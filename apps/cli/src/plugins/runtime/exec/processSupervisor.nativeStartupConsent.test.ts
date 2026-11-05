import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createStablePluginExecService, issueAgentNativeLaunchQualifierForHost } from '../invocation/services/exec';
import { createActionOperationSetupReview } from '@/daemon/actionOperations/actionOperationSetupReview';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createCodexNativeAppServerClient } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/client';
import { createCodexSharedAppServer } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/sharedServer';
import { createCodexControlSocketFixture } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/client.test-support';
import { withCodexNativeStartupLock } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/nativeStartupLock';

type FixtureChild = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'kill' | 'emit'> & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
};

const boundary = vi.hoisted(() => ({ home: '', children: [] as FixtureChild[], closePeers: [] as Array<() => Promise<void>> }));
vi.mock('node:os', async importOriginal => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: boundary.home }) };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
        if (args[0] !== 'fixture-native-consent') return actual.spawn(...args);
        const commandArgs = Array.isArray(args[1]) ? args[1] : [];
        if (!commandArgs.includes('app-server')) {
            // Finite discovery uses a real child so stdout/exit scheduling has
            // the same observable contract as the native version command.
            return actual.spawn(process.execPath, ['-e', commandArgs.includes('--version')
                ? 'process.stdout.write("codex-cli 0.162.1\\n")' : ''], args[2]);
        }
        // Substitute only the native executable; launch preparation, review,
        // filesystem admission, process supervision and JSON-RPC stay real.
        const child: FixtureChild = Object.assign(new EventEmitter(), {
            pid: 2_147_483_647, exitCode: null as number | null, signalCode: null,
            stdin: new Writable({ write(chunk, _encoding, callback) {
                const request = JSON.parse(Buffer.from(chunk).toString()) as { id?: number; method: string };
                if (request.id !== undefined) child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
                callback();
            } }), stdout: new PassThrough(), stderr: new PassThrough(),
            kill: vi.fn(() => { throw new Error('The exited fixture must not be signalled'); }),
        });
        setImmediate(() => {
            child.emit('spawn');
            if (commandArgs[commandArgs.indexOf('--listen') + 1]?.startsWith('unix://')) {
                void createCodexControlSocketFixture(commandArgs[commandArgs.indexOf('--listen') + 1]!.slice('unix://'.length), async message =>
                    message.id === undefined ? undefined : {}).then(peer => { boundary.closePeers.push(() => peer.close()); });
            }
        });
        boundary.children.push(child);
        // The OS boundary consumes the fixture's ChildProcess-compatible surface.
        return child as unknown as ChildProcessWithoutNullStreams;
    } };
});

describe.skipIf(process.platform === 'win32')('native startup with person-facing preparation', () => {
    it('settles typed host cancellation while queued for native admission without a separate startup signal', async () => {
        await withTempDir('codex-admission-cancel-', async directory => {
            boundary.home = directory;
            let enter!: () => void;
            let release!: () => void;
            const entered = new Promise<void>(resolve => { enter = resolve; });
            const held = new Promise<void>(resolve => { release = resolve; });
            const holder = withCodexNativeStartupLock(async () => { enter(); await held; });
            await entered;
            const stop = new AbortController();
            const exec = createStablePluginExecService({ environment: {}, signal: stop.signal,
                isOccurrenceCurrent: () => true, resolvePath: async () => directory,
                resolveExecutable: async () => ({ command: 'fixture-native-consent' }),
            });
            let waiting!: () => void;
            const queued = new Promise<void>(resolve => { waiting = resolve; });
            let outcome: unknown;
            const opening = createCodexNativeAppServerClient({
                exec: { ...exec, systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' }, executablePath: 'fixture-native-consent' }) } },
                processEnv: {}, cwd: directory, onStartupWaiting: active => { if (active) waiting(); },
            }).then(client => { outcome = { client }; }, error => { outcome = error; });
            try {
                await queued;
                stop.abort();
                await vi.waitFor(() => expect(outcome).toMatchObject({ code: 'plugin_exec_aborted', execLaunch: 'notStarted' }));
                expect(existsSync(join(directory, '.happier-codex-native-startup.lock'))).toBe(true);
            } finally {
                stop.abort(); release();
                await Promise.all([holder, opening]);
            }
        });
    });
    it.each(['stdio', 'shared'] as const)('lets a second cold %s start reach readiness while the first retains its consent card', async transport => {
        await withTempDir('codex-consent-', async directory => {
            boundary.home = directory; boundary.children.length = 0; boundary.closePeers.length = 0;
            const stop = new AbortController();
            let published: unknown;
            let entered!: () => void;
            const reviewing = new Promise<void>(resolve => { entered = resolve; });
            const review = createActionOperationSetupReview({ signal: stop.signal, publish(details) {
                published = details;
                if (details) entered();
            } });
            const service = (consent: boolean) => {
                const exec = createStablePluginExecService({ environment: {}, signal: consent ? stop.signal : new AbortController().signal,
                    isOccurrenceCurrent: () => true, resolvePath: async () => directory,
                    resolveExecutable: async () => ({ command: 'fixture-native-consent' }),
                    ...(consent ? { prepareAgentNativeLaunch: async () => {
                        await review.operationReview.waitForResume({ kind: 'pendingApproval', code: 'project_setup_consent_required',
                            reviewedEffectDigest: 'reviewed-setup', reviewedEffect: { commands: ['reviewed command'] } });
                    } } : {}),
                });
                return { exec: { ...exec, systemTools: { resolve: async () => ({ executable: { kind: 'systemTool' as const, id: 'codex-cli' }, executablePath: 'fixture-native-consent' }) } },
                    ...(consent ? { nativeLaunch: issueAgentNativeLaunchQualifierForHost(exec) } : {}) };
            };
            const servers: Array<{ dispose(): Promise<void> }> = [];
            const opening = async (consent: boolean) => {
                const params = { ...service(consent), processEnv: {}, signal: consent ? stop.signal : undefined };
                if (transport === 'stdio') return await createCodexNativeAppServerClient({ ...params, cwd: directory });
                const server = await createCodexSharedAppServer(params);
                if (!server) throw new Error('Expected Unix shared startup');
                servers.push(server);
                return await server.createClient({ cwd: directory, processEnv: {}, configOverrides: [], disableUserMcpServers: false });
            };
            const first = opening(true).then(client => ({ client }), error => ({ error }));
            let second: ReturnType<typeof opening> | undefined;
            let ready: Awaited<ReturnType<typeof opening>> | undefined;
            try {
                await Promise.race([reviewing, first.then(value => {
                    if ('error' in value) throw value.error;
                    throw new Error('Native startup passed the retained consent review');
                })]);
                expect(published).toMatchObject({ kind: 'pendingApproval', code: 'project_setup_consent_required' });
                expect(existsSync(join(directory, '.happier-codex-native-startup.lock'))).toBe(false);
                second = opening(false).then(client => { ready = client; return client; });
                await vi.waitFor(() => expect(ready).toBeDefined());
                expect(published).toMatchObject({ kind: 'pendingApproval' });
                expect(existsSync(join(directory, '.happier-codex-native-startup.lock'))).toBe(false);
            } finally {
                stop.abort();
                await expect(first).resolves.toMatchObject({ error: { code: 'plugin_exec_aborted', execLaunch: 'notStarted' } });
                expect(published).toBeUndefined();
                if (second) await second;
                for (const child of boundary.children) {
                    if (child.exitCode === null) { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); }
                }
                await ready?.dispose();
                for (const server of servers) await server.dispose();
                for (const close of boundary.closePeers) await close();
                for (const child of boundary.children) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); expect(child.kill).not.toHaveBeenCalled(); }
            }
        });
    });
});
