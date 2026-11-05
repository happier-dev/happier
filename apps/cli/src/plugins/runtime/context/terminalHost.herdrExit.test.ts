import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createHerdrTerminalHostAdapter } from '@/integrations/herdr/adapter';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { waitForCondition } from '@/testkit/async/waitFor';
import { isPidAlive } from '@/testkit/process/spawn';

import { createPluginTerminalHostService } from './terminalHost';

describe('independent Herdr host exit observation', () => {
    it('reports qualified native exit while the pane and its shell remain alive, without another input', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-herdr-native-exit-'));
        const readyPath = join(directory, 'native.json');
        const nativeSource = [
            'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid }));',
            'setInterval(() => {}, 1000);',
        ].join('\n');
        const nativeArgv = [process.execPath, '-e', nativeSource, '--', readyPath];
        let launcher: ChildProcess | undefined;
        let ambiguousProcess: ChildProcess | undefined;
        let nativePid: number | undefined;
        try {
            await withHerdrApi(async api => {
                // Only the external Herdr endpoint is simulated. Its submitted
                // launch command runs the real launch-spec runner and native child.
                api.beforeResponse.set('layout.apply', () => {
                    const root = api.requests.at(-1)?.params.root as { command: string[] };
                    launcher = spawn(root.command[0]!, root.command.slice(1), { stdio: 'ignore' });
                });
                let foregroundArgv = nativeArgv;
                let ambiguous = true;
                api.responses.set('pane.process_info', () => ({ process_info: {
                    shell_pid: process.pid,
                    foreground_processes: nativePid ? [
                        ...(ambiguous && ambiguousProcess?.pid ? [{ pid: ambiguousProcess.pid, argv: nativeArgv }] : []),
                        { pid: nativePid, argv: foregroundArgv },
                    ] : [],
                } }));
                const adapter = createHerdrTerminalHostAdapter({
                    binary: 'herdr', sessionName: 'work', socketPath: api.socketPath,
                    actionTimeoutMs: 5_000, startupTimeoutMs: 5_000,
                });
                const host = createPluginTerminalHostService({
                    hasCapability: capability => capability === 'terminalHost',
                    resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'herdr_forced' }),
                    resolveAgentCliLaunch: () => ({ command: nativeArgv[0]!, args: nativeArgv.slice(1), providerExitOwnership: 'direct' }),
                    disposeHost: ({ adapter, handle }) => adapter.dispose(handle),
                });
                const handle = await host.createOrAttachHost({
                    preference: 'herdr', sessionName: 'work', workingDirectory: directory, isolatedEnv: true,
                    launch: { kind: 'agent-cli', agentId: 'claude' },
                });
                const exits: unknown[] = [];
                let subscription: Awaited<ReturnType<NonNullable<typeof host.subscribeExit>>> = null;
                try {
                    await waitForCondition(() => existsSync(readyPath), { timeoutMs: 10_000, label: 'Herdr native provider startup' });
                    nativePid = (JSON.parse(await readFile(readyPath, 'utf8')) as { pid: number }).pid;
                    ambiguousProcess = spawn(nativeArgv[0]!, nativeArgv.slice(1), { stdio: 'ignore' });
                    await new Promise<void>((resolve, reject) => {
                        ambiguousProcess!.once('spawn', resolve);
                        ambiguousProcess!.once('error', reject);
                    });
                    // Real provider startup is complete before controlling only the
                    // observation timer; socket and process I/O remain real.
                    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
                    subscription = await host.subscribeExit!(handle, exit => exits.push(exit));
                    expect(subscription).not.toBeNull();
                    await vi.waitFor(() => expect(api.requests.some(request => request.method === 'pane.process_info')).toBe(true));

                    // Two exact invocation candidates remain unknown. A generic
                    // executable match or first-match custody would stop discovery.
                    await vi.advanceTimersByTimeAsync(30_000);
                    await vi.waitFor(() => expect(api.requests.filter(request => request.method === 'pane.process_info')).toHaveLength(2));
                    const ambiguousExited = new Promise<void>((resolve, reject) => {
                        ambiguousProcess!.once('exit', () => resolve());
                        ambiguousProcess!.once('error', reject);
                    });
                    ambiguousProcess.kill('SIGTERM');
                    await ambiguousExited;
                    expect(exits).toEqual([]);
                    ambiguous = false;
                    await vi.advanceTimersByTimeAsync(30_000);
                    await vi.waitFor(() => expect(api.requests.filter(request => request.method === 'pane.process_info')).toHaveLength(3));

                    // Foreground visibility can change while the qualified native
                    // process remains alive; that observation is never exit proof.
                    foregroundArgv = ['bash'];
                    expect(await host.evaluateLiveness(handle)).toMatchObject({ paneAlive: true });
                    expect(isPidAlive(nativePid)).toBe(true);
                    expect(exits).toEqual([]);

                    // Failed physical retirement restores the live host and its
                    // existing demand for native exit observations.
                    api.faults.set("pane.close", "error");
                    await expect(host.dispose(handle, { kind: "destroy_owned_host", reason: "session_closed" })).rejects.toThrow();
                    api.faults.delete("pane.close");

                    const launcherExited = new Promise<void>((resolve, reject) => {
                        launcher!.once('exit', () => resolve());
                        launcher!.once('error', reject);
                    });
                    const processQueries = api.requests.filter(request => request.method === 'pane.process_info').length;
                    // Managed panes can disappear with their native process. Once
                    // qualified, exit proof must survive a failed Herdr query.
                    api.faults.set('pane.process_info', 'error');
                    process.kill(nativePid, 'SIGTERM');
                    await launcherExited;
                    expect(isPidAlive(nativePid)).toBe(false);
                    // Preserve the established host-liveness cadence without
                    // turning this regression into a 30-second wall-clock wait.
                    await vi.advanceTimersByTimeAsync(30_000);
                    await vi.waitFor(() => expect(exits).toEqual([
                        { code: null, signal: null, nativeExited: true },
                    ]), { timeout: 1_000 });
                    expect(api.requests.filter(request => request.method === 'pane.process_info')).toHaveLength(processQueries);
                    api.faults.delete('pane.process_info');
                    expect(api.panes.has('managed')).toBe(true);
                    expect(await host.evaluateLiveness(handle)).toMatchObject({ paneAlive: true });
                } finally {
                    await subscription?.dispose();
                    vi.useRealTimers();
                    await host.dispose(handle, { kind: 'destroy_owned_host', reason: 'session_closed' });
                }
            });
        } finally {
            vi.useRealTimers();
            if (!nativePid && existsSync(readyPath)) nativePid = (JSON.parse(await readFile(readyPath, 'utf8')) as { pid: number }).pid;
            if (nativePid && isPidAlive(nativePid)) await terminateProcessTree({ pid: nativePid });
            if (ambiguousProcess?.pid && isPidAlive(ambiguousProcess.pid)) await terminateProcessTree({ pid: ambiguousProcess.pid });
            if (launcher?.pid && isPidAlive(launcher.pid)) await terminateProcessTree({ pid: launcher.pid });
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('shares discovery while subscribed and stops at last unsubscribe or host retirement', async () => {
        await withHerdrApi(async api => {
            const adapter = createHerdrTerminalHostAdapter({
                binary: 'herdr', sessionName: 'work', socketPath: api.socketPath,
                actionTimeoutMs: 5_000, startupTimeoutMs: 5_000,
            });
            const host = createPluginTerminalHostService({
                hasCapability: capability => capability === 'terminalHost',
                resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'herdr_forced' }),
                resolveAgentCliLaunch: () => ({ command: process.execPath, args: ['-e', 'void 0'], providerExitOwnership: 'direct' }),
                disposeHost: ({ adapter, handle }) => adapter.dispose(handle),
            });
            const handle = await host.createOrAttachHost({
                preference: 'herdr', sessionName: 'work', workingDirectory: tmpdir(), isolatedEnv: true,
                launch: { kind: 'agent-cli', agentId: 'claude' },
            });
            const exits: unknown[] = [];
            const queryCount = () => api.requests.filter(request => request.method === 'pane.process_info').length;
            const subscriptions: Array<NonNullable<Awaited<ReturnType<NonNullable<typeof host.subscribeExit>>>>> = [];
            let retired = false;
            try {
                vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
                for (let index = 0; index < 2; index++) {
                    const subscription = await host.subscribeExit!(handle, exit => exits.push(exit));
                    expect(subscription).not.toBeNull();
                    subscriptions.push(subscription!);
                }
                await vi.waitFor(() => expect(queryCount()).toBe(1));
                await vi.advanceTimersByTimeAsync(30_000);
                await vi.waitFor(() => expect(queryCount()).toBe(2));
                await subscriptions.shift()!.dispose();
                await vi.advanceTimersByTimeAsync(30_000);
                await vi.waitFor(() => expect(queryCount()).toBe(3));
                await subscriptions.shift()!.dispose();
                await vi.advanceTimersByTimeAsync(60_000);
                expect(queryCount()).toBe(3);
                expect(exits).toEqual([]);

                const restarted = await host.subscribeExit!(handle, exit => exits.push(exit));
                subscriptions.push(restarted!);
                await vi.waitFor(() => expect(queryCount()).toBe(4));
                await host.dispose(handle, { kind: 'destroy_owned_host', reason: 'session_closed' });
                retired = true;
                await vi.advanceTimersByTimeAsync(60_000);
                expect(queryCount()).toBe(4);
                expect(exits).toEqual([]);
            } finally {
                for (const subscription of subscriptions) await subscription.dispose();
                vi.useRealTimers();
                if (!retired) await host.dispose(handle, { kind: 'destroy_owned_host', reason: 'session_closed' });
            }
        });
    });
});
