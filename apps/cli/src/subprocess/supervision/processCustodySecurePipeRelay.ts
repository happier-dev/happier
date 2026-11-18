import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';

import { resolveProcessCustodyPeerIdentityExecutable } from './processCustody';

export const OWNER_ONLY_LOCAL_PIPE_PREFIXES = [
    'happier-workspace-sync-', 'happier-session-rpc-', 'happier-session-target-',
] as const;
export type OwnerOnlyLocalPipePrefix = typeof OWNER_ONLY_LOCAL_PIPE_PREFIXES[number];

const RELAY_SECRET_BYTES = 32;
const RELAY_NONCE_BYTES = 16;
const RELAY_MAC_BYTES = 32;
const RELAY_MAGIC = Buffer.from('HWSPIPE1', 'ascii');
const RELAY_PREAMBLE_BYTES = RELAY_MAGIC.byteLength + 4 + RELAY_NONCE_BYTES + RELAY_MAC_BYTES;
const RELAY_READY_LIMIT_BYTES = 4_096;
const RELAY_READY_TIMEOUT_MS = 5_000;
const RELAY_PREAMBLE_TIMEOUT_MS = 2_000;
const RELAY_SHUTDOWN_TIMEOUT_MS = 2_000;
const RELAY_GRACEFUL_SHUTDOWN_MS = 500;

export type ProcessCustodySecurePipeRelay = Readonly<{
    close(): Promise<void>;
}>;

export type ProcessCustodySecurePipeRelayStart = (input: Readonly<{
    pipeName: string;
    onConnection(socket: Socket, peerPid: number): void;
}>) => Promise<ProcessCustodySecurePipeRelay>;

function isPositivePid(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
}

/** Test/interop helper for the native relay's fixed authenticated PID witness. */
export function createProcessCustodySecurePipeRelayPreamble(
    secret: Uint8Array,
    peerPid: number,
    nonce: Uint8Array = randomBytes(RELAY_NONCE_BYTES),
): Buffer {
    if (secret.byteLength !== RELAY_SECRET_BYTES || nonce.byteLength !== RELAY_NONCE_BYTES || !isPositivePid(peerPid)) {
        throw new TypeError('invalid secure pipe relay preamble input');
    }
    const authenticated = Buffer.alloc(RELAY_MAGIC.byteLength + 4 + RELAY_NONCE_BYTES);
    RELAY_MAGIC.copy(authenticated, 0);
    authenticated.writeUInt32BE(peerPid, RELAY_MAGIC.byteLength);
    Buffer.from(nonce).copy(authenticated, RELAY_MAGIC.byteLength + 4);
    const mac = createHmac('sha256', Buffer.from(secret)).update(authenticated).digest();
    return Buffer.concat([authenticated, mac]);
}

function parseAuthenticatedPreamble(secret: Uint8Array, preamble: Buffer): number | null {
    if (preamble.byteLength !== RELAY_PREAMBLE_BYTES || !preamble.subarray(0, RELAY_MAGIC.byteLength).equals(RELAY_MAGIC)) {
        return null;
    }
    const authenticated = preamble.subarray(0, RELAY_PREAMBLE_BYTES - RELAY_MAC_BYTES);
    const receivedMac = preamble.subarray(RELAY_PREAMBLE_BYTES - RELAY_MAC_BYTES);
    const expectedMac = createHmac('sha256', Buffer.from(secret)).update(authenticated).digest();
    if (!timingSafeEqual(receivedMac, expectedMac)) return null;
    const pid = preamble.readUInt32BE(RELAY_MAGIC.byteLength);
    return isPositivePid(pid) ? pid : null;
}

function closeServer(server: Server): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function stopRelayChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin?.end();
    const graceful = await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => {
            const timer = setTimeout(() => resolve(false), RELAY_GRACEFUL_SHUTDOWN_MS);
            timer.unref();
        }),
    ]);
    if (graceful) return;
    child.kill();
    await Promise.race([
        closed,
        new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, RELAY_SHUTDOWN_TIMEOUT_MS);
            timer.unref();
        }),
    ]);
}

function listenLoopback(server: Server): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('secure pipe relay loopback address unavailable'));
                return;
            }
            resolve(address.port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: '127.0.0.1', port: 0 });
    });
}

function waitForReadyLine(
    stdout: NodeJS.ReadableStream,
    pipeName: string,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stdout.removeListener('data', onData);
            error ? reject(error) : resolve();
        };
        const onData = (chunk: Buffer | string) => {
            buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
            if (buffered.byteLength > RELAY_READY_LIMIT_BYTES) {
                finish(new Error('secure pipe relay readiness output exceeded its limit'));
                return;
            }
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) return;
            let parsed: unknown;
            try {
                parsed = JSON.parse(buffered.subarray(0, newline).toString('utf8'));
            } catch {
                finish(new Error('secure pipe relay returned malformed readiness output'));
                return;
            }
            const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : null;
            if (!record || record.v !== 1 || record.t !== 'secure-pipe-relay-ready' || record.pipeName !== pipeName) {
                finish(new Error('secure pipe relay returned an unexpected readiness result'));
                return;
            }
            finish();
        };
        const timer = setTimeout(
            () => finish(new Error('secure pipe relay readiness timed out')),
            RELAY_READY_TIMEOUT_MS,
        );
        timer.unref();
        stdout.on('data', onData);
    });
}

/**
 * Start the Windows-only native listener. Native code owns only the secured
 * named-pipe accept and byte relay; TypeScript retains all broker protocol,
 * HMAC authentication, authorization, and stream lifecycle decisions.
 */
export async function startProcessCustodySecurePipeRelay(input: Readonly<{
    pipeName: string;
    onConnection(socket: Socket, peerPid: number): void;
}>): Promise<ProcessCustodySecurePipeRelay> {
    if (process.platform !== 'win32') throw new Error('secure named-pipe relay is Windows-only');
    // The native relay implements this same closed command contract.
    const prefix = OWNER_ONLY_LOCAL_PIPE_PREFIXES.find(prefix => input.pipeName.startsWith(`\\\\.\\pipe\\${prefix}`));
    if (!prefix || !/^[A-Za-z0-9-]+$/u.test(input.pipeName.slice(`\\\\.\\pipe\\${prefix}`.length))) {
        throw new TypeError('invalid owner-only named-pipe path');
    }
    const executablePath = resolveProcessCustodyPeerIdentityExecutable('win32');
    if (!executablePath) throw new Error('process-custody runtime is unavailable');

    const secret = randomBytes(RELAY_SECRET_BYTES);
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        const timer = setTimeout(() => socket.destroy(), RELAY_PREAMBLE_TIMEOUT_MS);
        timer.unref();
        const onReadable = () => {
            if (socket.readableLength < RELAY_PREAMBLE_BYTES) return;
            const preamble = socket.read(RELAY_PREAMBLE_BYTES) as Buffer | null;
            if (!preamble) return;
            socket.off('readable', onReadable);
            clearTimeout(timer);
            const pid = parseAuthenticatedPreamble(secret, preamble);
            if (pid === null) {
                socket.destroy();
                return;
            }
            // Any coalesced broker bytes remain in Node's internal read buffer.
            // Emitting the logical connection now preserves the same initially
            // paused Socket semantics as a direct net.Server accept.
            input.onConnection(socket, pid);
        };
        socket.on('readable', onReadable);
    });
    const port = await listenLoopback(server);
    const child = nodeSpawn(executablePath, [
        'secure-pipe-relay',
        `--pipe-name=${input.pipeName}`,
        `--target-port=${port}`,
    ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    if (!child.stdin || !child.stdout) {
        child.kill();
        await closeServer(server);
        throw new Error('secure pipe relay stdio unavailable');
    }
    let startupFinished = false;
    let secretDelivered = false;
    let rejectStartupFailure!: (error: Error) => void;
    const startupFailure = new Promise<never>((_resolve, reject) => {
        rejectStartupFailure = reject;
    });
    const failStartup = (error: Error) => {
        if (!startupFinished) rejectStartupFailure(error);
    };
    const secretDeliveryError = (error?: Error) => {
        const detail = error?.message ? `: ${error.message}` : '';
        return new Error(`secure pipe relay secret delivery failed${detail}`);
    };
    const onChildError = (error: Error) => failStartup(
        secretDelivered ? error : secretDeliveryError(error),
    );
    const onChildClose = (code: number | null, signal: NodeJS.Signals | null) => failStartup(
        secretDelivered
            ? new Error(`secure pipe relay exited before readiness (${code ?? signal ?? 'unknown'})`)
            : secretDeliveryError(),
    );
    const onStdinError = (error: Error) => failStartup(secretDeliveryError(error));
    child.once('error', onChildError);
    child.once('close', onChildClose);
    // This listener intentionally remains for the child's lifetime. stdin stays
    // open as the native helper's parent-lifetime signal, so an exit after
    // readiness can still surface EPIPE and must never become an unhandled
    // EventEmitter error.
    child.stdin.on('error', onStdinError);

    // Keep stdin open after delivering the fixed secret. Its EOF is the
    // native listener's parent-lifetime signal, so a daemon crash cannot leave
    // an orphan named-pipe listener behind.
    try {
        const delivery = new Promise<void>((resolve, reject) => {
            try {
                child.stdin!.write(secret, (error) => {
                    if (error) {
                        reject(secretDeliveryError(error));
                        return;
                    }
                    resolve();
                });
            } catch (error) {
                reject(secretDeliveryError(error instanceof Error ? error : undefined));
            }
        });
        await Promise.race([delivery, startupFailure]);
        secretDelivered = true;
        await Promise.race([
            waitForReadyLine(child.stdout, input.pipeName),
            startupFailure,
        ]);
        startupFinished = true;
    } catch (error) {
        startupFinished = true;
        secret.fill(0);
        await stopRelayChild(child);
        for (const socket of sockets) socket.destroy();
        await closeServer(server);
        throw error;
    }

    child.once('close', () => {
        for (const socket of sockets) socket.destroy();
        void closeServer(server);
    });

    let closed = false;
    return Object.freeze({
        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            secret.fill(0);
            for (const socket of sockets) socket.destroy();
            await closeServer(server);
            await stopRelayChild(child);
        },
    });
}
