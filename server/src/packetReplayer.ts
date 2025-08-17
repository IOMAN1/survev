import { readFileSync } from "fs";
import { App, type WebSocket } from "uWebSockets.js";
import * as net from "../../shared/net/net";
import { Config } from "./config";
import { returnJson } from "./utils/serverHelpers";

// keybinds:
//
// move up = fast forward
// moveRight = send a single packet (use only when paused)
// shootStart / clicking = toggle pause

// which file to load the recording
const file = "../reference/recorded-packets/surviv.io20200106_l.har";
// recordings can have more than 1 game
const gameIndex = 3;

const data = JSON.parse(readFileSync(file) as unknown as string);

function base64ToArrayBuffer(base64: string) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer as ArrayBuffer;
}

const recordings: Array<ArrayBuffer[]> = [];
for (const entrie of data.log.entries) {
    if (!entrie.request.url.includes("/play")) continue;

    const rec = [];
    if (!entrie._webSocketMessages?.length) continue;
    for (const msg of entrie._webSocketMessages ?? []) {
        if (msg.type === "send") continue;
        rec.push(base64ToArrayBuffer(msg.data));
    }
    recordings.push(rec);
}

const packets = recordings.filter((record) => record.length)[gameIndex];
const app = App();

app.post("/api/find_game", async (res) => {
    returnJson(res, {
        res: [
            {
                zone: "help",
                data: "i'm being held hostage",
                gameId: "by ioman",
                useHttps: Config.regions["local"].https,
                hosts: [Config.regions["local"].address],
                addrs: [Config.regions["local"].address],
            },
        ],
    });
});

const clients = new Set<Client>();

class Client {
    packetIdx = 0;

    paused = false;
    fastForward = false;
    singlePacket = false;

    socket!: WebSocket<{ c: Client }>;

    nextPacketTicker = 0;

    sendNextPacket() {
        const packet = packets[this.packetIdx];
        this.packetIdx++;
        if (packet === undefined) {
            this.socket.close();
            clients.delete(this);
            return;
        }
        this.socket.send(packet, true, false);
    }

    update(dt: number) {
        if (this.singlePacket) {
            this.singlePacket = false;
            this.sendNextPacket();
        }

        if (this.paused) return;
        this.nextPacketTicker += dt * (this.fastForward ? 10 : 1);

        if (this.nextPacketTicker > 0.03) {
            this.nextPacketTicker = 0;
            this.sendNextPacket();
        }
    }
}

app.ws("/play", {
    idleTimeout: 30,
    upgrade(res, req, context) {
        res.onAborted((): void => {});

        res.upgrade(
            {
                c: new Client(),
            },
            req.getHeader("sec-websocket-key"),
            req.getHeader("sec-websocket-protocol"),
            req.getHeader("sec-websocket-extensions"),
            context,
        );
    },
    open(socket: WebSocket<{ c: Client }>) {
        const client = socket.getUserData().c;
        client.socket = socket;
        clients.add(client);
    },
    message(socket: WebSocket<{ c: Client }>, message) {
        const msgStream = new net.MsgStream(message);
        const type = msgStream.deserializeMsgType();
        const stream = msgStream.stream;

        const client = socket.getUserData().c;

        switch (type) {
            case net.MsgType.Input: {
                const inputMsg = new net.InputMsg();
                inputMsg.deserialize(stream);

                client.fastForward = inputMsg.moveUp;
                client.singlePacket = inputMsg.moveRight;

                if (inputMsg.shootStart) {
                    client.paused = !client.paused;
                }

                break;
            }
            case net.MsgType.Emote: {
                const emoteMsg = new net.EmoteMsg();
                emoteMsg.deserialize(stream);
                break;
            }
            case net.MsgType.DropItem: {
                const dropMsg = new net.DropItemMsg();
                dropMsg.deserialize(stream);
                break;
            }
            case net.MsgType.Spectate: {
                const spectateMsg = new net.SpectateMsg();
                spectateMsg.deserialize(stream);
                break;
            }
        }
    },
    close(socket: WebSocket<{ c: Client }>) {
        clients.delete(socket.getUserData().c);
    },
});

app.listen(Config.devServer.host, Config.devServer.port, () => {});

let now = Date.now();
setInterval(() => {
    const nNow = Date.now();
    const dt = (nNow - now) / 1000;
    now = nNow;

    for (const client of clients) {
        client.update(dt);
    }
}, 1);
