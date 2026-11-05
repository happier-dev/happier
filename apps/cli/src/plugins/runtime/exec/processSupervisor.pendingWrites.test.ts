import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createStablePluginExecService } from '../invocation/services/exec';
import { withTempDir } from '@/testkit/fs/tempDir';

type FixtureChild = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'kill' | 'emit'> & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
};

const boundary = vi.hoisted(() => ({
    holdWrite: false,
    writes: [] as string[],
    releaseWrites: [] as Array<() => void>,
    children: [] as FixtureChild[],
}));

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
        if (args[0] !== 'fixture-pending-write') return actual.spawn(...args);
        // Only the OS boundary is substituted: a descendant can retain the
        // pipes and a pending write callback after the root process exits.
        const child = Object.assign(new EventEmitter(), {
            pid: 2_147_483_647, exitCode: null as number | null, signalCode: null,
            stdin: new Writable({ write(chunk, _encoding, callback) {
                boundary.writes.push(Buffer.from(chunk).toString('utf8'));
                if (boundary.holdWrite) boundary.releaseWrites.push(() => callback());
                else callback();
            } }),
            stdout: new PassThrough(), stderr: new PassThrough(),
            kill: vi.fn(() => { throw new Error('The exited fixture must not be signalled'); }),
        });
        boundary.children.push(child);
        queueMicrotask(() => child.emit('spawn'));
        // The OS boundary consumes the fixture's ChildProcess-compatible surface.
        return child as unknown as ChildProcessWithoutNullStreams;
    } };
});

describe('Exec JSON-RPC pending startup writes', () => {
    it.each(['initialize write', 'initialize response', 'initialized write'] as const)(
        'settles %s and disposal on observed root exit without pipe closure', async phase => {
            await withTempDir('exec-pending-write-', async directory => {
                boundary.holdWrite = phase !== 'initialize response';
                boundary.writes.length = 0;
                boundary.releaseWrites.length = 0;
                boundary.children.length = 0;
                const exec = createStablePluginExecService({ environment: {}, signal: new AbortController().signal,
                    isOccurrenceCurrent: () => true, resolvePath: async () => directory,
                    resolveExecutable: async () => ({ command: 'fixture-pending-write' }),
                });
                const handle = await exec.clients.spawn({ kind: 'jsonRpc', framing: 'jsonLines', launch: {
                    executable: { kind: 'systemTool', id: 'fixture-pending-write' }, cwd: directory,
                } });
                const child = boundary.children[0]!;
                let outcome: unknown;
                const pending = (phase === 'initialized write'
                    ? handle.client.notify('initialized')
                    : handle.client.request('initialize', {}, { timeoutMs: null }))
                    .then(value => { outcome = { value }; }, error => { outcome = error; });
                try {
                    await vi.waitFor(() => expect(boundary.writes).toHaveLength(1));
                    expect(outcome).toBeUndefined();
                    child.exitCode = 17;
                    child.emit('exit', 17, null);

                    await vi.waitFor(() => expect(outcome).toMatchObject({ code: 'PLUGIN_EXEC_CLIENT_EXITED' }));
                    await pending;
                    await expect(handle.wait()).resolves.toMatchObject({
                        termination: { observed: { kind: 'exit', exitCode: 17 } },
                    });
                    await handle.dispose();
                    expect(child.kill).not.toHaveBeenCalled();
                    expect(child.stdout.destroyed).toBe(false);
                } finally {
                    // Release the old implementation without signalling any PID.
                    for (const release of boundary.releaseWrites) release();
                    child.emit('close', 17, null);
                    await pending;
                    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
                    await handle.dispose();
                }
            });
        },
    );
});
