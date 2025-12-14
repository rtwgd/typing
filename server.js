const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

const rooms = new Map();
const clients = new Map();

// 辞書ファイル読み込み (同じディレクトリに khjy.json が必要です)
let allWords = [];
try {
    const wordsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'khjy.json'), 'utf8'));
    allWords = wordsData.list;
} catch (e) {
    console.error('khjy.json loading failed. Using fallback words.', e);
    allWords = [{text:'エラー', kana:['えらー']},{text:'ファイルなし', kana:['ふぁいるなし']}];
}

function getAvailableRooms() {
    const availableRooms = [];
    const MAX_PLAYERS = 8;
    for (const [name, room] of rooms.entries()) {
        if (!room || !room.players || room.isPrivate) continue;

        const playerCount = Object.keys(room.players).length;
        if (playerCount >= MAX_PLAYERS) continue;

        const isGaming = !!(room.game && room.game.state && !room.game.state.isOver);
        
        let hostName = '(空室)';
        if (playerCount > 0) {
            const hostPlayer = Object.values(room.players).find(p => p.clientId === room.hostId);
            hostName = hostPlayer?.name || 'Unknown';
        }

        availableRooms.push({
            name: name,
            hostName: hostName,
            playerCount: playerCount,
            maxPlayers: MAX_PLAYERS,
            isGaming: isGaming
        });
    }
    return availableRooms;
}

function broadcastRoomList() {
    const roomList = getAvailableRooms();
    for (const client of clients.values()) {
        if (!client.roomName && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'roomList', payload: { rooms: roomList } }));
        }
    }
}

function broadcastToRoom(roomName, message) {
    const room = rooms.get(roomName);
    if (!room || !room.players) return;
    Object.values(room.players).forEach(player => {
        const clientConnection = clients.get(player.clientId);
        if (clientConnection && clientConnection.readyState === WebSocket.OPEN) {
            clientConnection.send(JSON.stringify(message));
        }
    });
}

// 共通のロビー情報送信関数（重複コード削減）
function broadcastLobbyUpdate(room) {
    broadcastToRoom(room.name, {
        type: 'gameLobby',
        payload: {
            gameId: room.game ? room.game.id : null,
            host: room.hostId,
            originalHostId: room.originalHostId,
            hasPassword: !!room.password, // パスワード有無フラグ
            settings: room.game ? room.game.settings : {},
            players: room.players,
            teams: room.teams
        }
    });
}

wss.on('connection', (ws) => {
    const clientId = uuidv4();
    clients.set(clientId, ws);
    ws.clientId = clientId;
    console.log(`Client connected: ${clientId}`);
    
    ws.send(JSON.stringify({ type: 'connected', payload: { clientId: clientId } }));
    ws.send(JSON.stringify({ type: 'roomList', payload: { rooms: getAvailableRooms() } }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { type, payload } = data;
            const roomName = ws.roomName;

            switch (type) {
                case 'getRooms':
                    ws.send(JSON.stringify({ type: 'roomList', payload: { rooms: getAvailableRooms() } }));
                    break;

                case 'joinRoom': {
                    if (ws.roomName) return;
                    const { roomName, playerName, isPrivate, level, password } = payload;
                    
                    let room = rooms.get(roomName);
                    if (!room) {
                        room = { 
                            name: roomName, 
                            teams: { 1: {}, 2: {} },
                            players: {},
                            game: null, 
                            isPrivate: isPrivate,
                            password: password || null,
                            originalHostId: clientId,
                            hostId: clientId,
                            lastActivityTime: Date.now(),
                            chatHistory: []
                        };
                        rooms.set(roomName, room);
                    } else {
                        // 既存部屋に参加する場合、パスワードがあればチェックする等の処理が必要ならここに追加
                        // 現状は作成時のパスワードが優先され、参加者はスルー（ホスト奪取用）
                    }

                    room.lastActivityTime = Date.now();

                    if (clientId === room.originalHostId) {
                        room.hostId = clientId;
                    }

                    const isGaming = !!(room.game && room.game.state && !room.game.state.isOver);
                    if (isGaming) {
                        ws.send(JSON.stringify({ type: 'error', payload: { message: '試合が進行中のため、参加できません。' } }));
                        return;
                    }

                    const team1Size = Object.keys(room.teams[1]).length;
                    const team2Size = Object.keys(room.teams[2]).length;
                    const targetTeam = team1Size <= team2Size ? 1 : 2;

                    const player = {
                        clientId: clientId,
                        name: playerName,
                        level: level || 250,
                        team: targetTeam,
                        id: clientId,
                        joinTime: Date.now()
                    };
                    
                    room.players[clientId] = player;
                    room.teams[targetTeam][clientId] = player;
                    ws.roomName = roomName;
                    ws.clientId = clientId;

                    if (!room.game && Object.keys(room.players).length >= 2) {
                        room.game = { 
                            id: roomName, 
                            host: room.hostId, 
                            settings: {}, 
                            state: null 
                        };
                    }

                    // ロビー情報を全員に送信
                    broadcastLobbyUpdate(room);
                                    
                    if (room.chatHistory && room.chatHistory.length > 0) {
                        ws.send(JSON.stringify({
                            type: 'chatHistory',
                            payload: { messages: room.chatHistory }
                        }));
                    }
    
                    broadcastRoomList();
                    break;
                }

                case 'requestStartGame': {
                    const room = rooms.get(roomName);
                    if (room && room.game && ws.clientId === room.hostId) {
                        const timeInSeconds = payload.timeSetting || 60;
                        const spaceToggle = payload.spaceToggle !== undefined ? payload.spaceToggle : true;

                        room.game.settings.spaceToggle = spaceToggle;

                        const allPlayers = Object.values(room.players);
                        const team1KPM = allPlayers.filter(p => p.team === 1).reduce((sum, p) => sum + p.level, 0);
                        const team2KPM = allPlayers.filter(p => p.team === 2).reduce((sum, p) => sum + p.level, 0);
                        
                        // KPMが0の場合は開始できない（少なくとも誰かいるはず）
                        if (team1KPM <= 0 || team2KPM <= 0) {
                            ws.send(JSON.stringify({ type: 'error', payload: { message: '各チームに少なくとも1人のプレイヤーが必要です（KPM>0）。' } }));
                            return;
                        }

                        const team1DPS = team1KPM / 60;
                        const team2DPS = team2KPM / 60;

                        const team1HP = team2DPS * timeInSeconds;
                        const team2HP = team1DPS * timeInSeconds;

                        const damages = {};
                        Object.values(room.players).forEach(p => {
                            damages[p.id] = 1;
                        });
                        
                        room.game.words = allWords.sort(() => 0.5 - Math.random()).slice(0, 300);
                        
                        if (room.game.timer) clearTimeout(room.game.timer);
                        room.game.timer = null;

                        room.game.state = {
                            hp: { 1: team1HP, 2: team2HP },
                            maxHp: { 1: team1HP, 2: team2HP },
                            damages: damages,
                            isOver: false
                        };
                        
                        broadcastToRoom(roomName, {
                            type: 'gameStarting',
                            payload: {
                                settings: room.game.settings,
                                words: room.game.words,
                                players: room.players,
                                teams: room.teams,
                                hp: room.game.state.hp,
                                maxHp: room.game.state.maxHp
                            }
                        });
                    }
                    break;
                }

                case 'charTyped': {
                    const room = rooms.get(roomName);
                    if (!room || !room.game || !room.game.state || room.game.state.isOver) {
                        return;
                    }

                    const { isCorrect } = payload;
                    if (!isCorrect) {
                        return;
                    }

                    const player = room.players[ws.clientId];
                    if (!player) return;

                    const shooterId = player.id;
                    const teamNum = player.team;

                    Object.values(room.players).forEach(p => {
                        if (p.id === shooterId) return;
                        const conn = clients.get(p.clientId);
                        if (conn && conn.readyState === WebSocket.OPEN) {
                            const messageType = p.team === teamNum ? 'teammateShot' : 'opponentShot';
                            conn.send(JSON.stringify({ type: messageType, payload: { shooterId: shooterId } }));
                        }
                    });
    
                    const damage = room.game.state.damages[player.id];
                    const opponentTeamNum = teamNum === 1 ? 2 : 1;
                    room.game.state.hp[opponentTeamNum] -= damage;

                    if (room.game.state.hp[opponentTeamNum] <= 0) {
                        room.game.state.hp[opponentTeamNum] = 0;
                        room.game.state.isOver = true;
                        
                        const winnerTeam = player.team;

                        Object.values(room.players).forEach(p => {
                            const conn = clients.get(p.clientId);
                            if (conn) {
                                conn.send(JSON.stringify({
                                    type: 'matchResult',
                                    payload: {
                                        result: { winnerTeam: winnerTeam },
                                        hp: room.game.state.hp
                                    }
                                }));
                            }
                        });
                        room.game.state = null;
                    } else {
                        broadcastToRoom(roomName, {
                            type: 'hpUpdate',
                            payload: { hp: room.game.state.hp }
                        });
                    }
                    break;
                }

                case 'requestHost': {
                    const room = rooms.get(roomName);
                    const { password } = payload;

                    if (room && room.password && password === room.password) {
                        room.hostId = ws.clientId;
                        console.log(`Room ${roomName}: Host changed to ${ws.clientId} by password.`);
                        broadcastLobbyUpdate(room);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', payload: { message: 'パスワードが違うか、この部屋では使用できません。' } }));
                    }
                    break;
                }

                case 'requestHost': {
                const room = rooms.get(roomName);
                const { password } = payload;

                if (room && room.password && password === room.password) {
                    // Password matches, grant host privileges
                    room.hostId = ws.clientId;
                    console.log(`Room ${roomName}: Host changed to ${ws.clientId} by password authentication.`);

                    // Broadcast the updated lobby info to all players
                    broadcastToRoom(roomName, {
                        type: 'gameLobby',
                        payload: {
                            gameId: room.game ? room.game.id : null,
                            host: room.hostId,
                            originalHostId: room.originalHostId,
                            hasPassword: !!room.password,
                            settings: room.game ? room.game.settings : {},
                            players: room.players,
                            teams: room.teams
                        }
                    });
                } else {
                    // Password incorrect or not set
                    ws.send(JSON.stringify({ type: 'error', payload: { message: 'パスワードが違うか、この部屋では使用できません。' } }));
                }
                break;
            }

            case 'updateKpm': {
                    const room = rooms.get(roomName);
                    if (room && ws.clientId === room.hostId) {
                        const { playerId, kpm } = payload;
                        const playerToUpdate = room.players[playerId];
                        if (playerToUpdate) {
                            playerToUpdate.level = parseInt(kpm, 10) || 250;
                            // KPM変更もロビー情報の更新として全員に伝える
                            broadcastLobbyUpdate(room);
                        }
                    }
                    break;
                }

                case 'changeTeam': {
                    const room = rooms.get(roomName);
                    const requesterId = ws.clientId;

                    if (room && room.hostId === requesterId) {
                        const { playerId } = payload;
                        const playerToMove = room.players[playerId];

                        if (playerToMove) {
                            const currentTeam = playerToMove.team;
                            const newTeam = currentTeam === 1 ? 2 : 1;

                            delete room.teams[currentTeam][playerId];
                            room.teams[newTeam][playerId] = playerToMove;
                            playerToMove.team = newTeam;

                            broadcastLobbyUpdate(room);
                        }
                    }
                    break;
                }

                case 'deleteRoom': {
                    const room = rooms.get(roomName);
                    if (!room) {
                        ws.send(JSON.stringify({ type: 'roomDeletionError', payload: { message: '部屋が見つかりません。' } }));
                        return;
                    }
                    if (room.password && payload.password === room.password) {
                        rooms.delete(roomName);
                        console.log(`Room ${roomName} deleted by ${ws.clientId}.`);
                        ws.send(JSON.stringify({ type: 'roomDeletionSuccess' }));
                        broadcastRoomList();
                    } else {
                        ws.send(JSON.stringify({ type: 'roomDeletionError', payload: { message: 'パスワードが違います。' } }));
                    }
                    break;
                }

                case 'sendChatMessage': {
                    const room = rooms.get(roomName);
                    if (room && room.players[ws.clientId]) {
                        const playerName = room.players[ws.clientId].name;
                        const messageData = {
                            sender: playerName,
                            message: payload.message,
                            timestamp: Date.now()
                        };

                        room.chatHistory.push(messageData);
                        if (room.chatHistory.length > 100) room.chatHistory.shift();

                        broadcastToRoom(roomName, {
                            type: 'newChatMessage',
                            payload: messageData
                        });
                    }
                    break;
                }
            }
        } catch (e) {
            console.error('Message handling error:', e);
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected: ${ws.clientId}`);
        const clientId = ws.clientId;
        const roomName = ws.roomName;

        clients.delete(clientId);

        if (roomName) {
            const room = rooms.get(roomName);
            if (room && room.players[clientId]) {
                const removedPlayer = room.players[clientId];
                const teamNum = removedPlayer.team;

                delete room.players[clientId];
                if (room.teams[teamNum]) {
                    delete room.teams[teamNum][clientId];
                }

                room.lastActivityTime = Date.now();

                if (Object.keys(room.players).length === 0) {
                    // 誰もいなくなったが、即座には消さずにタイマーに任せる（再接続などを考慮）
                } else {
                    if (room.hostId === clientId) {
                        const remainingPlayers = Object.values(room.players).sort((a, b) => a.joinTime - b.joinTime);
                        const newHost = remainingPlayers[0];
                        if (newHost) {
                            room.hostId = newHost.clientId;
                            console.log(`Room ${roomName}: Host auto-assigned to ${newHost.name}`);
                        }
                    }

                    if (room.game && room.game.state && !room.game.state.isOver) {
                        room.game.state.isOver = true;
                        
                        const winnerTeam = removedPlayer.team === 1 ? 2 : 1;
                        broadcastToRoom(roomName, {
                            type: 'matchResult',
                            payload: {
                                result: { 
                                    winnerTeam: winnerTeam,
                                    reason: `${removedPlayer.name}が切断しました。`
                                },
                                hp: room.game.state.hp
                            }
                        });
                        room.game.state = null;

                    } else if (!room.game || !room.game.state) {
                        broadcastLobbyUpdate(room);
                    }
                }
            }
        }
        broadcastRoomList();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

const INACTIVE_ROOM_TIMEOUT = 1 * 60 * 60 * 1000; 

setInterval(() => {
    const now = Date.now();
    for (const [roomName, room] of rooms.entries()) {
        if (Object.keys(room.players).length === 0 && (now - room.lastActivityTime > INACTIVE_ROOM_TIMEOUT)) {
            rooms.delete(roomName);
            console.log(`Room ${roomName} deleted due to inactivity.`);
            broadcastRoomList();
        }
    }
}, 5 * 60 * 1000); 

console.log('Inactive room cleanup timer started.');