import { createServer } from 'node:net';

/** PGlite consumes PostgreSQL messages, while TCP delivers arbitrary byte chunks. */
export class FramedPgliteSocketServer {
    #server = null;
    #sockets = new Set();
    #listeningPort;

    constructor(options) {
        this.options = options;
        this.#listeningPort = options.port;
    }

    async start() {
        if (this.#server) throw new Error('PGlite socket server is already started');
        const server = createServer(socket => this.#accept(socket));
        this.#server = server;
        try {
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(this.options.port, this.options.host, () => {
                    server.off('error', reject);
                    resolve();
                });
            });
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected TCP address');
            this.#listeningPort = address.port;
        } catch (error) {
            this.#server = null;
            if (server.listening) server.close();
            throw error;
        }
    }

    getServerConn() {
        return `${this.options.host}:${this.#listeningPort}`;
    }

    async stop() {
        const server = this.#server;
        if (!server) return;
        this.#server = null;
        for (const socket of this.#sockets) socket.destroy();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }

    #accept(socket) {
        this.#sockets.add(socket);
        socket.once('close', () => this.#sockets.delete(socket));
        socket.on('error', () => undefined);
        socket.pause();
        void this.options.db.runExclusive(async () => {
            if (socket.destroyed) return;
            await this.options.db.waitReady;
            if (socket.destroyed) return;
            let startup = true;
            const chunks = [];
            let available = 0;
            let work = Promise.resolve();
            const closed = new Promise(resolve => socket.once('close', resolve));
            socket.on('data', chunk => {
                chunks.push(chunk);
                available += chunk.length;
                work = work.then(async () => {
                    const header = Buffer.allocUnsafe(5);
                    const peek = count => {
                        let copied = 0;
                        for (const part of chunks) {
                            const size = Math.min(part.length, count - copied);
                            part.copy(header, copied, 0, size);
                            copied += size;
                            if (copied === count) break;
                        }
                        return header;
                    };
                    const take = count => {
                        const frame = Buffer.allocUnsafe(count);
                        let copied = 0;
                        while (copied < count) {
                            const part = chunks[0];
                            const size = Math.min(part.length, count - copied);
                            part.copy(frame, copied, 0, size);
                            copied += size;
                            if (size === part.length) chunks.shift();
                            else chunks[0] = part.subarray(size);
                        }
                        available -= count;
                        return frame;
                    };
                    while (!socket.destroyed) {
                        const headerLength = startup ? 4 : 5;
                        if (available < headerLength) return;
                        const length = peek(headerLength).readUInt32BE(startup ? 0 : 1);
                        if (length < (startup ? 8 : 4)) throw new Error('Invalid PostgreSQL message length');
                        const frameLength = length + (startup ? 0 : 1);
                        if (available < frameLength) return;
                        const frame = take(frameLength);
                        if (startup && (frame.readUInt32BE(4) === 80877103 || frame.readUInt32BE(4) === 80877104)) {
                            await this.#write(socket, Buffer.from('N'));
                            continue;
                        }
                        startup = false;
                        // The wrapped API releases PGlite's parsed messages after each frame.
                        // Database errors still travel to the client as PostgreSQL error frames.
                        const { data: response } = await this.options.db.execProtocol(new Uint8Array(frame), { throwOnError: false });
                        if (response.length > 0) await this.#write(socket, Buffer.from(response));
                        if (frame[0] === 'X'.charCodeAt(0) && frame.length === 5) {
                            socket.end();
                            return;
                        }
                    }
                }).catch(error => socket.destroy(error instanceof Error ? error : new Error(String(error))));
            });
            socket.resume();
            await closed;
            await work;
        }).catch(error => socket.destroy(error instanceof Error ? error : new Error(String(error))));
    }

    async #write(socket, response) {
        if (socket.destroyed) return;
        await new Promise((resolve, reject) => socket.write(response, error => error ? reject(error) : resolve()));
    }
}
