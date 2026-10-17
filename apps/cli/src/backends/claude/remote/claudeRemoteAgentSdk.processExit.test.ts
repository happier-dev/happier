import type { Query, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeProviderRuntimeActivityAdapter } from '@/backends/claude/providerActivity/createClaudeProviderRuntimeActivityAdapter';
import { createSessionRuntimeActivity } from '@/session/runtimeActivity/createSessionRuntimeActivity';
import { createDeferred } from '@/testkit/async/deferred';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { isPidAlive } from '@/testkit/process/spawn';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';
import { createClaudeRuntimeActivityEvidence } from './runtimeActivityEvidence';

// Capture and launch real OS children; Windows platform selection is restored at this OS boundary.
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

// The SDK transport and OS process are the boundaries; the ledger, adapter and session
// contribution below remain real so premature task abandonment reaches the publication.
class ControlledProcess extends EventEmitter implements SpawnedProcess {
    stdin = new PassThrough();
    stdout = new PassThrough();
    killed = false;
    pid: number | undefined;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;

    kill() {
        this.killed = true;
        return true;
    }

    exit(signal: NodeJS.Signals | null = null) {
        this.exitCode = signal === null ? 0 : null;
        this.signalCode = signal;
        this.emit('exit', this.exitCode, signal);
        this.stdin.destroy();
        this.stdout.destroy();
    }
}

function runStoppedProcessFixture(child: ControlledProcess, evidence: ReturnType<typeof createClaudeRuntimeActivityEvidence>, launchError?: Error) {
    let didSendPrompt = false;
    return claudeRemoteAgentSdk({
        sessionId: null,
        transcriptPath: null,
        path: '/tmp',
        claudeExecutablePath: '/tmp/claude',
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        isAborted: () => false,
        nextMessage: async () => {
            if (didSendPrompt) return null;
            didSendPrompt = true;
            return { message: 'continue', mode: makeMode() };
        },
        onReady: () => {},
        onSessionFound: () => {},
        onMessage: () => {},
        providerRuntimeActivityEvidence: evidence,
        spawnClaudeCodeProcess: () => child,
        createQuery: ({ options }) => {
            const spawnProcess = options?.spawnClaudeCodeProcess as (options: SpawnOptions) => SpawnedProcess;
            spawnProcess({ command: '/tmp/claude', args: [], env: process.env, signal: new AbortController().signal });
            // SDK process errors reach its query iterator; no exit follows a failed OS spawn.
            child.on('error', () => {});
            if (launchError) child.emit('error', launchError);
            return {
                async *[Symbol.asyncIterator]() {
                    if (launchError) throw launchError;
                },
                close: () => {},
                supportedCommands: async () => [],
                supportedModels: async () => [],
            } as unknown as Query;
        },
    });
}

describe('claudeRemoteAgentSdk owned process exit', () => {
    it.runIf(process.platform !== 'win32').each(['javascript-direct', 'native-direct', 'wrapper-exit', 'wrapper-cleanup'])('qualifies provider stop through SDK 0.2.123 and its actual OS invocation (%s)', async (kind) => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-sdk-owned-invocation-'));
        const pidPath = join(dir, 'provider-pid');
        const aliveAckPath = join(dir, 'provider-alive-ack');
        const providerPath = join(dir, kind === 'javascript-direct' ? 'provider.js' : 'provider');
        const shellWrapper = join(dir, 'comspec');
        const shimPath = join(dir, 'claude.cmd');
        const wrapsProvider = kind.startsWith('wrapper-');
        const env = createEnvKeyScope(['ComSpec']);
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        if (!platformDescriptor) throw new Error('Expected OS platform descriptor');
        const restorePlatform = () => Object.defineProperty(process, 'platform', platformDescriptor);
        await writeFile(providerPath, `#!${process.execPath}
            const fs = require('node:fs');
            fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
            process.on('SIGUSR2', () => fs.writeFileSync(${JSON.stringify(aliveAckPath)}, 'alive'));
            const send = value => console.log(JSON.stringify(value));
            require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
                const message = JSON.parse(line);
                if (message.type === 'control_request') {
                    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
                        response: { commands: [], models: [], agents: [] } } });
                } else if (message.type === 'user') {
                    send({ type: 'system', subtype: 'init', session_id: 'owned-session' });
                    send({ type: 'system', subtype: 'task_started', session_id: 'owned-session', task_id: 'background-task',
                        task_type: 'local_agent', is_backgrounded: true });
                    send({ type: 'result', subtype: 'success', session_id: 'owned-session' });
                    process.stdout.end(() => {
                        if (${wrapsProvider}) process.kill(process.ppid, 'SIGUSR1');
                        else process.exit(0);
                    });
                }
            });
            setInterval(() => {}, 1000);
        `, { mode: 0o755 });
        await writeFile(shimPath, 'Windows shell shim fixture\n');
        await writeFile(shellWrapper, `#!${process.execPath}
            process.on('SIGTERM', () => {});
            process.on('SIGUSR1', () => {
                if (${kind === 'wrapper-exit'}) process.exit(0);
                else process.stdout.end();
            });
            require('node:child_process').spawn(process.execPath, [${JSON.stringify(providerPath)}], { stdio: 'inherit' });
        `, { mode: 0o755 });
        const activity = createSessionRuntimeActivity('supported');
        const snapshots: Array<{ state: string; activeCount: number }> = [];
        await activity.bindPublisher({ publish: async snapshot => { snapshots.push(snapshot); }, close: async () => {} });
        const contributionHandle = activity.agentRuntimeContributionHandle;
        if (!contributionHandle) throw new Error('Expected supported runtime contribution');
        const evidence = createClaudeRuntimeActivityEvidence();
        const adapter = createClaudeProviderRuntimeActivityAdapter({ contributionHandle, providerActivityLedger: evidence.providerActivityLedger });
        let sent = false;
        const providerTurnFinished = createDeferred<void>();
        const originalSpawn = vi.mocked(spawn).getMockImplementation();
        if (!originalSpawn) throw new Error('Expected real OS spawn boundary');
        if (wrapsProvider) {
            env.patch({ ComSpec: shellWrapper });
            // Exercise the actual canonical Windows invocation; Linux executes the fixture at the OS boundary.
            Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
            vi.mocked(spawn).mockImplementationOnce((command, args, options) => {
                restorePlatform();
                return originalSpawn(command, args, options);
            });
        }
        let providerPid: number | undefined;
        try {
            const run = claudeRemoteAgentSdk({
                sessionId: null, transcriptPath: null, path: dir,
                claudeExecutablePath: wrapsProvider ? shimPath : providerPath,
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage: async () => {
                    if (sent) { await providerTurnFinished.promise; return null; }
                    sent = true;
                    return { message: 'start background work', mode: makeMode() };
                },
                onReady: async () => {
                    if (kind === 'wrapper-exit') {
                        const captured = vi.mocked(spawn).mock.results.find(result => result.type === 'return' && result.value.spawnfile === shellWrapper);
                        if (!captured || captured.type !== 'return') throw new Error('Expected actual canonical ComSpec child');
                        if (captured.value.exitCode === null && captured.value.signalCode === null) await once(captured.value, 'exit');
                    }
                    providerTurnFinished.resolve();
                }, onSessionFound: () => {}, onMessage: () => {},
                providerRuntimeActivityEvidence: evidence, runtimeActivityAdapter: adapter,
            });
            const failure: unknown = await run.then(() => null, (error: unknown) => error);
            providerPid = Number(await readFile(pidPath, 'utf8'));
            if (wrapsProvider) {
                expect(vi.mocked(spawn).mock.calls.some(([command, args]) => command === shellWrapper && Array.isArray(args) && args[0] === '/d')).toBe(true);
            }
            if (kind === 'wrapper-exit') {
                expect(isPidAlive(providerPid)).toBe(true);
                process.kill(providerPid, 'SIGUSR2');
                await vi.waitFor(async () => expect(await readFile(aliveAckPath, 'utf8')).toBe('alive'));
                expect(evidence.providerActivityLedger.getActiveProviderTaskCount()).toBe(1);
                expect(snapshots.at(-1)).toEqual({ state: 'unknown', activeCount: 0 });
                expect(failure).toMatchObject({ code: 'claude_native_provider_exit_unverified' });
            } else {
                expect(failure).toBeNull();
                expect(isPidAlive(providerPid)).toBe(false);
                expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(false);
                expect(snapshots.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
            }
        } finally {
            restorePlatform();
            env.restore();
            if (!providerPid) providerPid = Number(await readFile(pidPath, 'utf8').catch(() => '0'));
            await killProcessTree({ pid: providerPid });
            await activity.dispose();
            await rm(dir, { recursive: true, force: true });
        }
    });
    it.each([
        { denySignals: false, runtimeFails: false },
        { denySignals: true, runtimeFails: false },
        { denySignals: true, runtimeFails: true },
    ])('settles an owned OS child ignoring SIGTERM only when cleanup is verified (OS denies signals: $denySignals, runtime fails: $runtimeFails)', async ({ denySignals, runtimeFails }) => {
        const ready = createDeferred();
        const closeRequested = createDeferred();
        const childCreated = createDeferred<ChildProcess>();
        const evidence = createClaudeRuntimeActivityEvidence();
        const runtimeError = Object.assign(new Error('provider stream failed'), {
            happierClaudeCodeArtifacts: { debugTail: 'provider-debug-evidence', stderrTail: 'provider-stderr-evidence' },
        });
        const activity = createSessionRuntimeActivity('supported');
        const publish = vi.fn(async () => {});
        await activity.bindPublisher({ publish, close: async () => {} });
        const contributionHandle = activity.agentRuntimeContributionHandle;
        if (!contributionHandle) throw new Error('Expected supported runtime contribution');
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            contributionHandle,
            providerActivityLedger: evidence.providerActivityLedger,
        });
        let didSendPrompt = false;
        const run = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) {
                    await ready.promise;
                    return null;
                }
                didSendPrompt = true;
                return { message: 'background work', mode: makeMode() };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            providerRuntimeActivityEvidence: evidence,
            runtimeActivityAdapter: adapter,
            spawnClaudeCodeProcess: () => {
                const spawnedChild = spawn(process.execPath, [
                    '-e',
                    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
                ], { stdio: 'pipe' });
                return spawnedChild;
            },
            createQuery: ({ options }) => {
                const spawnProcess = options?.spawnClaudeCodeProcess as (options: SpawnOptions) => SpawnedProcess;
                const controller = options?.abortController as AbortController;
                const owned = spawnProcess({
                    command: process.execPath,
                    args: ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
                    env: process.env,
                    signal: controller.signal,
                });
                if (!(owned instanceof ChildProcess)) throw new Error('Expected real owned OS child');
                childCreated.resolve(owned);
                let stderr = '';
                owned.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
                owned.stdout?.once('data', () => ready.resolve());
                owned.once('exit', (code, signal) => ready.reject(new Error(`Owned OS fixture exited before transport readiness (${code}, ${signal}): ${stderr}`)));
                // The SDK handles AbortError from the OS spawn signal and then closes transport.
                owned.on('error', (error) => {
                    if (!controller.signal.aborted) ready.reject(error);
                });
                controller.signal.addEventListener('abort', () => { owned.kill('SIGTERM'); }, { once: true });
                return {
                    async *[Symbol.asyncIterator]() {
                        await ready.promise;
                        yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                        yield { type: 'system', subtype: 'task_started', session_id: 'owned-session', task_id: 'background-task', task_type: 'local_agent', is_backgrounded: true };
                        if (runtimeFails) throw runtimeError;
                        yield { type: 'result', subtype: 'success', session_id: 'owned-session' };
                    },
                    // SDK 0.2.123 skips its delayed SIGKILL path once killed is true.
                    close: () => {
                        if (!owned.killed) owned.kill('SIGTERM');
                        closeRequested.resolve();
                    },
                    supportedCommands: async () => [],
                    supportedModels: async () => [],
                } as unknown as Query;
            },
        });
        void run.catch(() => {});
        const child = await Promise.race([childCreated.promise, run.then(() => { throw new Error('SDK query returned before spawn'); })]);
        const signal = process.kill.bind(process);
        // A genuine OS boundary denial restricted to the real process owned by this fixture.
        const denied = denySignals ? vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => {
            if (pid === child.pid) throw Object.assign(new Error('OS denied owned cleanup'), { code: 'EPERM' });
            return signal(pid, requestedSignal);
        }) : null;
        try {
            await Promise.race([closeRequested.promise, run.then(() => { throw new Error('SDK query returned before close'); })]);
            if (!child.pid) throw new Error('Expected owned child pid');
            expect(child.killed).toBe(true);
            if (denySignals) {
                const failure: unknown = await run.catch((error: unknown) => error);
                if (runtimeFails) {
                    expect(failure).toBeInstanceOf(AggregateError);
                    if (!(failure instanceof AggregateError)) throw new Error('Expected runtime and cleanup failures together');
                    expect(failure.cause).toBe(runtimeError);
                    expect(failure.errors[0]).toBe(runtimeError);
                    expect(failure.errors[1]).toMatchObject({ code: 'process_tree_termination_incomplete' });
                    expect(failure.cause).toHaveProperty('happierClaudeCodeArtifacts', runtimeError.happierClaudeCodeArtifacts);
                } else {
                    expect(failure).not.toBeInstanceOf(AggregateError);
                    expect(failure).toMatchObject({ code: 'process_tree_termination_incomplete' });
                }
                expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(true);
                expect(publish).toHaveBeenLastCalledWith({ state: 'unknown', activeCount: 0 });
            } else {
                await expect(waitForProcessExit(child.pid)).resolves.toBe(true);
                await run;
                expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(false);
                await adapter.publishCurrent('verify-process-exit');
                expect(publish).toHaveBeenLastCalledWith({ state: 'idle', activeCount: 0 });
            }
        } finally {
            denied?.mockRestore();
            if (child && child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                if (child.pid) await waitForProcessExit(child.pid);
            }
            await run.catch(() => {});
            await activity.dispose();
        }
    });

    it.each([null, 'SIGTERM'] as const)('settles already-exited opaque SDK processes (%s) without treating them as provider exit', async (signal) => {
        const child = new ControlledProcess();
        child.exit(signal);
        const evidence = createClaudeRuntimeActivityEvidence();
        evidence.providerActivityLedger.apply({ type: 'started', sessionId: 's1', taskId: 'old-task' });

        await expect(runStoppedProcessFixture(child, evidence)).rejects.toMatchObject({ code: 'claude_native_provider_exit_unverified' });

        expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(true);
    });

    it('propagates a failed OS spawn without waiting for an exit that cannot arrive or abandoning known tasks', async () => {
        const child = new ControlledProcess();
        child.pid = undefined;
        const launchError = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
        const evidence = createClaudeRuntimeActivityEvidence();
        evidence.providerActivityLedger.apply({ type: 'started', sessionId: 's1', taskId: 'known-task' });
        try {
            await expect(runStoppedProcessFixture(child, evidence, launchError)).rejects.toThrow(launchError);
            expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(true);
        } finally {
            child.stdin.destroy();
            child.stdout.destroy();
        }
    });

    it('keeps background task evidence and finalization pending until an opaque SDK process exits', async () => {
        const child = new ControlledProcess();
        const resultPublished = createDeferred();
        const finishStream = createDeferred();
        const closeRequested = createDeferred();
        const evidence = createClaudeRuntimeActivityEvidence();
        const activity = createSessionRuntimeActivity('supported');
        const publish = vi.fn(async () => {});
        await activity.bindPublisher({ publish, close: async () => {} });
        const contributionHandle = activity.agentRuntimeContributionHandle;
        if (!contributionHandle) throw new Error('Expected supported runtime contribution');
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            contributionHandle,
            providerActivityLedger: evidence.providerActivityLedger,
        });
        let didSendPrompt = false;
        let didReturn = false;
        const run = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) return null;
                didSendPrompt = true;
                return { message: 'start background work', mode: makeMode() };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            providerRuntimeActivityEvidence: evidence,
            runtimeActivityAdapter: adapter,
            spawnClaudeCodeProcess: () => child,
            createQuery: ({ options }) => {
                const spawnProcess = options?.spawnClaudeCodeProcess as (options: SpawnOptions) => SpawnedProcess;
                spawnProcess({ command: '/tmp/claude', args: [], cwd: '/tmp', env: process.env, signal: new AbortController().signal });
                // The real SDK exposes many unrelated operations. This transport fixture only
                // implements the operations consumed by this lifecycle recipe.
                return {
                    async *[Symbol.asyncIterator]() {
                        yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                        yield { type: 'system', subtype: 'task_started', session_id: 'owned-session', task_id: 'background-task', task_type: 'local_agent', is_backgrounded: true };
                        yield { type: 'result', subtype: 'success', session_id: 'owned-session' };
                        resultPublished.resolve();
                        await finishStream.promise;
                    },
                    close: () => { closeRequested.resolve(); },
                    supportedCommands: async () => [],
                    supportedModels: async () => [],
                } as unknown as Query;
            },
        });
        void run.then(() => { didReturn = true; }, () => {});

        try {
            await Promise.race([resultPublished.promise, run.then(() => { throw new Error('SDK query returned before result'); })]);
            expect(publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 1 });
            expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(true);

            finishStream.resolve();
            await closeRequested.promise;
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(true);
            expect(publish).toHaveBeenLastCalledWith({ state: 'unknown', activeCount: 0 });
            expect(didReturn).toBe(false);

            child.exit();
            await expect(run).rejects.toMatchObject({ code: 'claude_native_provider_exit_unverified' });
            await adapter.publishCurrent('verify-process-exit');
            expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(true);
            expect(publish).toHaveBeenLastCalledWith({ state: 'unknown', activeCount: 0 });
        } finally {
            finishStream.resolve();
            if (child.exitCode === null) child.exit();
            await run.catch(() => {});
            await activity.dispose();
        }
    });
});
