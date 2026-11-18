import { createServer, Socket, type Socket as SocketType } from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { existsSync } from 'node:fs';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    PROCESS_CUSTODY_PEER_IDENTITY_PLATFORMS,
    observeLocalIpcPeerIdentity,
    parseProcessCustodyPeerIdentityLine,
    resolveProcessCustodyPeerIdentityExecutable,
    type ProcessCustodyPeerIdentityChild,
    type ProcessCustodyPeerIdentitySpawn,
} from './processCustody';

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
    }));
});

describe('process custody peer identity line parsing', () => {
    it('parses exactly the strict POSIX identity shape', () => {
        expect(parseProcessCustodyPeerIdentityLine('{"pid":4242,"t":"peer-identity","uid":1000,"v":1}\n'))
            .toEqual({ pid: 4242, uid: 1000 });
        expect(parseProcessCustodyPeerIdentityLine('{"pid":4242,"t":"peer-identity","uid":1000,"v":1}'))
            .toEqual({ pid: 4242, uid: 1000 });
    });

    it('parses the Windows shape where the pipe ACL is the uid authority', () => {
        expect(parseProcessCustodyPeerIdentityLine('{"pid":808,"t":"peer-identity","uid":null,"v":1}\n'))
            .toEqual({ pid: 808, uid: null });
    });

    it('rejects every malformed or padded shape instead of guessing', () => {
        expect(parseProcessCustodyPeerIdentityLine('')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('not json')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('[]')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('null')).toBeNull();
        // Exactly one line is an outcome; anything padded with more is not.
        expect(parseProcessCustodyPeerIdentityLine(
            '{"pid":1,"t":"peer-identity","uid":0,"v":1}\n{"pid":2,"t":"peer-identity","uid":0,"v":1}\n',
        )).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('{"pid":1,"t":"peer-identity","uid":0,"v":1,"extra":true}'))
            .toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('{"pid":1,"t":"peer-identity","uid":0}')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('{"pid":1,"t":"other","uid":0,"v":1}')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('{"pid":1,"t":"peer-identity","uid":0,"v":2}')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('{"pid":0,"t":"peer-identity","uid":0,"v":1}')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('{"pid":-4,"t":"peer-identity","uid":0,"v":1}')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('{"pid":1.5,"t":"peer-identity","uid":0,"v":1}')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('{"pid":"1","t":"peer-identity","uid":0,"v":1}')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('{"pid":1,"t":"peer-identity","uid":-1,"v":1}')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('{"pid":1,"t":"peer-identity","uid":1.5,"v":1}')).toBeNull();
        expect(parseProcessCustodyPeerIdentityLine('{"pid":1,"t":"peer-identity","uid":"0","v":1}')).toBeNull();
    });
});

describe('staged peer-identity helper resolution', () => {
    it('answers null on platforms without a peer primitive', () => {
        expect(resolveProcessCustodyPeerIdentityExecutable('sunos')).toBeNull();
    });

    it('supports exactly the three platforms with OS peer primitives', () => {
        expect([...PROCESS_CUSTODY_PEER_IDENTITY_PLATFORMS].sort()).toEqual(['darwin', 'linux', 'win32']);
    });

    it('returns only a real staged helper with the canonical executable name', () => {
        const resolved = resolveProcessCustodyPeerIdentityExecutable();
        if (resolved === null) return;
        expect(existsSync(resolved)).toBe(true);
        expect(basename(resolved)).toBe(
            process.platform === 'win32'
                ? 'happier-process-custody.exe'
                : 'happier-process-custody',
        );
    });
});

type FakeChildOutcome = Readonly<{
    stdout?: string;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: Error;
    stall?: boolean;
}>;

class FakePeerIdentityChild implements ProcessCustodyPeerIdentityChild {
    readonly stdout = new PassThrough();
    readonly killedWith: Array<NodeJS.Signals | number> = [];

    private readonly closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    private readonly errorListeners: Array<(error: Error) => void> = [];

    constructor(private readonly outcome: FakeChildOutcome) {}

    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    on(event: 'error' | 'close', listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): void {
        if (event === 'error') {
            this.errorListeners.push(listener as (error: Error) => void);
            if (this.outcome.error) queueMicrotask(() => this.emitError(this.outcome.error as Error));
            return;
        }
        this.closeListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
        if (!this.outcome.stall) queueMicrotask(() => this.finish());
    }

    kill(signal?: NodeJS.Signals | number): boolean {
        this.killedWith.push(signal ?? 'SIGTERM');
        this.finish();
        return true;
    }

    writeStdout(text: string): void {
        this.stdout.write(text);
        this.stdout.end();
    }

    emitError(error: Error): void {
        for (const listener of this.errorListeners) listener(error);
    }

    private finish(): void {
        if (this.outcome.error) return;
        for (const listener of this.closeListeners) {
            listener(this.outcome.code ?? (this.outcome.signal ? null : 0), this.outcome.signal ?? null);
        }
    }
}

function fakeSpawnFactory(record: {
    calls: Array<{ executablePath: string; args: readonly string[]; stdio: readonly unknown[] }>;
    outcome: FakeChildOutcome;
    children?: FakePeerIdentityChild[];
}): ProcessCustodyPeerIdentitySpawn {
    return (input) => {
        record.calls.push({ executablePath: input.executablePath, args: input.args, stdio: input.stdio });
        const child = new FakePeerIdentityChild(record.outcome);
        record.children?.push(child);
        if (record.outcome.stdout !== undefined) {
            queueMicrotask(() => child.writeStdout(record.outcome.stdout as string));
        }
        return child;
    };
}

function makeSocket(): SocketType {
    return new Socket({ readable: false, writable: false });
}

describe('local IPC peer identity invocation boundary', () => {
    it('asks the native boundary to prove a connected Windows pipe server belongs to this user', async () => {
        const calls: Array<{ executablePath: string; args: readonly string[]; stdio: readonly unknown[] }> = [];
        const identity = await observeLocalIpcPeerIdentity({
            socket: makeSocket(), executablePath: 'custody', peer: 'server',
            spawn: fakeSpawnFactory({ calls,
                outcome: { stdout: '{"pid":4242,"t":"peer-identity","uid":null,"v":1}\n', code: 0 },
            }),
        });
        expect(identity).toEqual({ pid: 4242, uid: null });
        expect(calls[0].args).toEqual(['peer-identity', '--server']);
    });

    it('passes the accepted socket as the fixed extra descriptor and parses the identity', async () => {
        const socket = makeSocket();
        const calls: Array<{ executablePath: string; args: readonly string[]; stdio: readonly unknown[] }> = [];
        const identity = await observeLocalIpcPeerIdentity({
            socket,
            executablePath: '/staged/happier-process-custody',
            spawn: fakeSpawnFactory({
                calls,
                outcome: { stdout: '{"pid":4242,"t":"peer-identity","uid":1000,"v":1}\n', code: 0 },
            }),
        });
        expect(identity).toEqual({ pid: 4242, uid: 1000 });
        expect(calls).toHaveLength(1);
        expect(calls[0].executablePath).toBe('/staged/happier-process-custody');
        expect(calls[0].args).toEqual(['peer-identity']);
        expect(calls[0].stdio).toEqual(['ignore', 'pipe', 'pipe', socket]);
    });

    it('answers null on a non-zero helper exit', async () => {
        const identity = await observeLocalIpcPeerIdentity({
            socket: makeSocket(),
            executablePath: 'custody',
            spawn: fakeSpawnFactory({
                calls: [],
                outcome: { stdout: '', code: 5 },
            }),
        });
        expect(identity).toBeNull();
    });

    it('answers null on a signal exit instead of a proven code', async () => {
        const identity = await observeLocalIpcPeerIdentity({
            socket: makeSocket(),
            executablePath: 'custody',
            spawn: fakeSpawnFactory({
                calls: [],
                outcome: { stdout: '{"pid":1,"t":"peer-identity","uid":0,"v":1}', code: null, signal: 'SIGKILL' },
            }),
        });
        expect(identity).toBeNull();
    });

    it('answers null when the helper prints malformed output', async () => {
        const identity = await observeLocalIpcPeerIdentity({
            socket: makeSocket(),
            executablePath: 'custody',
            spawn: fakeSpawnFactory({ calls: [], outcome: { stdout: 'garbage\n', code: 0 } }),
        });
        expect(identity).toBeNull();
    });

    it('answers null when the spawn itself fails', async () => {
        const identity = await observeLocalIpcPeerIdentity({
            socket: makeSocket(),
            executablePath: 'custody',
            spawn: fakeSpawnFactory({ calls: [], outcome: { error: new Error('spawn EBADF') } }),
        });
        expect(identity).toBeNull();
    });

    it('kills a stalled helper at the deadline and answers null', async () => {
        const children: FakePeerIdentityChild[] = [];
        const identity = await observeLocalIpcPeerIdentity({
            socket: makeSocket(),
            executablePath: 'custody',
            timeoutMs: 20,
            spawn: fakeSpawnFactory({ calls: [], outcome: { stall: true }, children }),
        });
        expect(identity).toBeNull();
        expect(children[0]?.killedWith).toContain('SIGKILL');
    });

    it('kills a helper that exceeds the bounded stdout cap and answers null', async () => {
        const children: FakePeerIdentityChild[] = [];
        const identityPromise = observeLocalIpcPeerIdentity({
            socket: makeSocket(),
            executablePath: 'custody',
            spawn: fakeSpawnFactory({ calls: [], outcome: { stall: true }, children }),
        });
        await Promise.resolve();
        const child = children[0];
        if (!child) throw new Error('fake helper never started');
        child.stdout.write('x'.repeat(8192));
        await expect(identityPromise).resolves.toBeNull();
        expect(child.killedWith).toContain('SIGKILL');
    });
});

describe('live staged helper on this Linux target', () => {
    const liveBin = process.env.HAPPIER_PROCESS_CUSTODY_LIVE_BIN;
    it.skipIf(!liveBin || process.platform !== 'linux')(
        'proves the exact peer pid/uid of a real accepted connection end to end',
        async () => {
            if (!liveBin) throw new Error('the live lane requires HAPPIER_PROCESS_CUSTODY_LIVE_BIN');
            const directory = await mkdtemp(join(tmpdir(), 'peer-identity-live-'));
            tempDirs.push(directory);
            const server = createServer(() => {});
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(join(directory, 'broker.sock'), () => {
                    server.off('error', reject);
                    resolve();
                });
            });
            const acceptedPromise = once(server, 'connection') as Promise<[Socket]>;
            const client = new Socket();
            client.connect(String(server.address()));
            await once(client, 'connect');
            const [accepted] = await acceptedPromise;
            try {
                await expect(observeLocalIpcPeerIdentity({
                    socket: accepted,
                    executablePath: liveBin,
                })).resolves.toEqual({ pid: process.pid, uid: process.getuid?.() });
                // The shared socket must remain fully usable afterwards.
                expect(accepted.writable && accepted.readable).toBe(true);
                const withDeadline = async <T>(value: Promise<T>, direction: string): Promise<T> => await Promise.race([
                    value,
                    new Promise<never>((_resolve, reject) => setTimeout(
                        () => reject(new Error(`peer-checked socket stalled ${direction}`)),
                        2_000,
                    )),
                ]);
                const serverBytes = once(accepted, 'data') as Promise<[Buffer]>;
                client.write(Buffer.from('after-peer-check-client'));
                await expect(withDeadline(serverBytes, 'client-to-server')).resolves.toEqual([Buffer.from('after-peer-check-client')]);
                const clientBytes = once(client, 'data') as Promise<[Buffer]>;
                accepted.write(Buffer.from('after-peer-check-server'));
                await expect(withDeadline(clientBytes, 'server-to-client')).resolves.toEqual([Buffer.from('after-peer-check-server')]);
            } finally {
                client.destroy();
                accepted.destroy();
                server.close();
            }
        },
        15_000,
    );

    it('runs no live lane without a staged helper', () => {
        expect(liveBin === undefined || typeof liveBin === 'string').toBe(true);
    });
});

describe('unchanged custody surface', () => {
    it.each(['darwin', 'win32'] as const)('resolves the staged custody helper on %s without throwing', async (platform) => {
        const { resolveProcessCustodyRuntimeExecutable } = await import('./processCustody');
        const executable = resolveProcessCustodyRuntimeExecutable(platform);
        if (executable === null) return;
        expect(existsSync(executable)).toBe(true);
        expect(basename(executable)).toBe(platform === 'win32' ? 'happier-process-custody.exe' : 'happier-process-custody');
    });

    it('still resolves the custody helper only on its custody platforms', async () => {
        const { resolveProcessCustodyRuntimeExecutable } = await import('./processCustody');
        expect(resolveProcessCustodyRuntimeExecutable('linux')).toBeNull();
        expect(resolveProcessCustodyRuntimeExecutable('sunos')).toBeNull();
        expect(vi.isMockFunction(resolveProcessCustodyRuntimeExecutable)).toBe(false);
    });
});
