import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createStablePluginExecService } from '../invocation/services/exec';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createCodexSharedAppServer } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/sharedServer';
import { withCodexNativeStartupLock } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/nativeStartupLock';

type FixtureChild = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'kill' | 'emit'> & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
};

const boundary = vi.hoisted(() => ({ home: '', holdProbe: false, children: [] as FixtureChild[] }));
vi.mock('node:os', async importOriginal => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: boundary.home }) };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
        if (args[0] !== 'fixture-native-codex') return actual.spawn(...args);
        // The OS may report root exit before inherited stdio closes. Only this
        // process boundary is substituted; Exec, supervision and startup stay real.
        const child = Object.assign(new EventEmitter(), {
            pid: 2_147_483_647, exitCode: null as number | null, signalCode: null,
            stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
            kill: vi.fn(() => { throw new Error('The exited fixture must not be signalled'); }),
        });
        const commandArgs = Array.isArray(args[1]) ? args[1] : [];
        if (commandArgs.includes('app-server') || (boundary.holdProbe && commandArgs.includes('features'))) {
            boundary.children.push(child);
            queueMicrotask(() => {
                child.emit('spawn');
                if (boundary.holdProbe && commandArgs.includes('app-server')) {
                    child.stdout.end();
                    child.stderr.end();
                    child.exitCode = 17;
                    child.emit('exit', 17, null);
                    child.emit('close', 17, null);
                }
            });
        } else {
            queueMicrotask(() => {
                child.emit('spawn');
                child.stdout.end(commandArgs.includes('--version') ? 'codex-cli 0.162.1' : '');
                child.stderr.end();
                child.exitCode = 0;
                child.emit('exit', 0, null);
                child.emit('close', 0, null);
            });
        }
        // The OS boundary consumes the fixture's ChildProcess-compatible surface.
        return child as unknown as ChildProcessWithoutNullStreams;
    } };
});

describe.skipIf(process.platform === 'win32')('native startup launcher exit', () => {
    it.each(['feature probe', 'app-server'] as const)('settles startup without retaining admission when the %s exits before stdio closes', async phase => {
        await withTempDir('codex-startup-exit-', async directory => {
            boundary.home = directory;
            boundary.holdProbe = phase === 'feature probe';
            boundary.children.length = 0;
            const exec = createStablePluginExecService({ environment: {}, signal: new AbortController().signal,
                isOccurrenceCurrent: () => true, resolvePath: async () => directory,
                resolveExecutable: async () => ({ command: 'fixture-native-codex' }),
            });
            const server = await createCodexSharedAppServer({ processEnv: {}, exec: { ...exec,
                systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' }, executablePath: 'fixture-native-codex' }) },
            } });
            if (!server) throw new Error('Expected Unix native shared startup');
            let failure: unknown;
            const opening = server.createClient({ cwd: directory, processEnv: {}, configOverrides: [], disableUserMcpServers: false })
                .catch(error => { failure = error; return null; });
            let child: FixtureChild | undefined;
            try {
                await vi.waitFor(() => expect(boundary.children).toHaveLength(1));
                child = boundary.children[0]!;
                const lockPath = join(directory, '.happier-codex-native-startup.lock');
                if (phase === 'app-server') expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
                else expect(existsSync(lockPath)).toBe(false);
                child.exitCode = 17;
                child.emit('exit', 17, null);
                await vi.waitFor(() => expect(failure).toMatchObject({ code: 'agent_startup_transport_failed',
                    startupFailure: { reason: 'process_exited', nativeExitCode: 17 } }));
                await opening;
                expect(existsSync(lockPath)).toBe(false);
                await withCodexNativeStartupLock(async () => expect(existsSync(lockPath)).toBe(true));
                for (const launcher of boundary.children) expect(launcher.kill).not.toHaveBeenCalled();
            } finally {
                // Unblock the pre-fix implementation without signals or a timer.
                child ??= boundary.children[0];
                child?.emit('close', 17, null);
                await opening;
                for (const launcher of boundary.children) {
                    launcher.emit('close', 17, null);
                    launcher.stdout.destroy(); launcher.stderr.destroy(); launcher.stdin.destroy();
                }
                await server.dispose();
            }
        });
    });
});
