import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { resolveBackendExecutionSurfacesFromNativeAgentRuntime } from '@/agent/runtime/registry/backendEngineSurfaceBindings';
import { createExternalContributionFixtures } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createTerminalRuntimeHostOrchestration } from './orchestration';
import { createTerminalRuntimeProjectionHostService } from './projection';

import { describe, expect, it, vi } from 'vitest';

import { createPluginExecSystemToolGrantStore } from '@/plugins/runtime/exec/system/tools/grants';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { logger } from '@/ui/logger';

import { createTerminalRuntimeProcessService } from './launchProcess';

class FakeChildProcess extends EventEmitter {
    readonly pid = 4217;
    readonly stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: BufferEncoding) => void };
    readonly kill = vi.fn();

    constructor() {
        super();
        this.stderr.setEncoding = vi.fn();
    }
}

describe('createTerminalRuntimeProcessService', () => {
    it('keeps executable resolution and native child baselines scoped across interleaved Sessions with partial overlays', async () => {
        const root = await createTempDir('native-terminal-scopes-');
        const envScope = createEnvKeyScope(['HAPPIER_CODEX_PATH']);
        const executables = new Map<string, string>();
        try {
            for (const id of ['ambient', 'a', 'b']) {
                const directory = join(root, id);
                await mkdir(directory);
                const executable = join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
                await writeFile(executable, 'native executable boundary fixture');
                if (process.platform !== 'win32') await chmod(executable, 0o755);
                executables.set(id, executable);
            }
            envScope.patch({ HAPPIER_CODEX_PATH: executables.get('ambient') });
            const observations = await Promise.all(['a', 'b'].map(id => runAddedHostedSession({
                environment: { HAPPIER_CODEX_PATH: executables.get(id), HOME: join(root, id), PATH: join(root, id, 'bin'),
                    NODE_EXTRA_CA_CERTS: join(root, id, 'trust.pem'), REMOVE_NATIVE_ENV: 'remove', OVERLAY_VALUE: 'baseline' },
                workingDirectory: root, end() {},
            }, async () => {
                await Promise.resolve();
                const grants = createPluginExecSystemToolGrantStore();
                let observed: { command: string; options: SpawnOptions } | undefined;
                // Only physical process creation is substituted. Catalog/native
                // resolution, grants, host orchestration and supervision stay real.
                const processService = createTerminalRuntimeProcessService({
                    verifyExecutableGrant: grants.verifyGrant, registerExecutableGrant: grants.register,
                    spawn(command, _args, options) {
                        observed = { command, options };
                        const child = new FakeChildProcess() as unknown as ChildProcess;
                        queueMicrotask(() => child.emit('exit', 0, null));
                        return child;
                    },
                });
                const session = createMutableApiSessionClientFixture({ sessionId: 'native-terminal-' + id });
                const host = createTerminalRuntimeHostOrchestration({ session, process: processService,
                    messageQueue: new MessageQueue2<string, string>(mode => mode),
                    projection: createTerminalRuntimeProjectionHostService({ session }),
                });
                if (!host) throw new Error('Native terminal host unavailable');
                const { backend } = createExternalContributionFixtures('codex');
                const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({ backend, agentId: 'codex',
                    runtime: { surfaces: { terminal: { resolveLaunch: async () => ({ argv: [], environment: {
                        values: { NATIVE_PLAN_ENV: id, OVERLAY_VALUE: 'native-plan' }, unset: ['REMOVE_NATIVE_ENV'],
                    } }) } } },
                    isCurrent: () => true, declaredAgentSurfaceFamilies: new Set(['terminalRuntime']), diagnostics: [],
                });
                const result = await surfaces.terminalRuntime?.launch?.({ sessionId: session.sessionId,
                    directory: root, metadata: {}, env: { PARTIAL_OVERLAY: id, OVERLAY_VALUE: 'request' }, host,
                    runWithCurrentPublisherPermit: async effect => ({ status: 'completed', value: await effect() }),
                });
                expect(result).toEqual({ type: 'process_exited', exitCode: 0 });
                return observed;
            })));
            for (const [index, id] of ['a', 'b'].entries()) {
                expect(observations[index]?.command).toBe(executables.get(id));
                expect(observations[index]?.options.env).toMatchObject({ HOME: join(root, id), PATH: join(root, id, 'bin'),
                    NODE_EXTRA_CA_CERTS: join(root, id, 'trust.pem'), PARTIAL_OVERLAY: id,
                    NATIVE_PLAN_ENV: id, OVERLAY_VALUE: 'native-plan' });
                expect(observations[index]?.options.env?.REMOVE_NATIVE_ENV).toBeUndefined();
            }
        } finally { envScope.restore(); await removeTempDir(root); }
    });

    it('shares pending stop failure and permits physical retry before retaining success', async () => {
        // ChildProcess and termination are OS boundaries; supervision and grant verification stay real.
        const child = new FakeChildProcess() as unknown as ChildProcess;
        const grants = createPluginExecSystemToolGrantStore();
        grants.register({ grantId: 'stop-fixture', toolId: 'claude', executablePath: '/fixture/claude', expiresAt: null });
        const failure = new Error('physical stop rejected');
        let rejectAttempt!: (error: unknown) => void;
        const pending = new Promise<void>((_resolve, reject) => { rejectAttempt = reject; });
        let attempts = 0;
        let alive = true;
        const seenOptions: unknown[] = [];
        const service = createTerminalRuntimeProcessService({
            spawn: () => child,
            verifyExecutableGrant: grants.verifyGrant,
            async terminateProcessTree(_child, options) {
                seenOptions.push(options);
                if (!alive) throw new Error('A settled process must not be stopped again');
                if (++attempts === 1) return await pending;
                alive = false;
                child.emit('exit', null, 'SIGTERM');
            },
        });
        const handle = await service.launch({ executable: { path: '/fixture/claude',
            hostGrant: { kind: 'system-tool', grantId: 'stop-fixture' } }, cwd: '/repo' });
        const first = handle.stop({ graceMs: 17 }).then(() => undefined, error => error);
        let secondSettled = false;
        const second = handle.stop({ graceMs: 23 }).then(
            () => { secondSettled = true; },
            error => { secondSettled = true; return error; },
        );
        try {
            await Promise.resolve();
            await Promise.resolve();
            expect(secondSettled).toBe(false);
            rejectAttempt(failure);
            expect(await Promise.all([first, second])).toEqual([failure, failure]);
            expect(alive).toBe(true);
            await handle.stop({ graceMs: 29 });
            expect(alive).toBe(false);
            expect(seenOptions).toEqual([{ graceMs: 17 }, { graceMs: 29 }]);
            await expect(handle.waitForTermination()).resolves.toEqual({ type: 'signaled', signal: 'SIGTERM' });
            await expect(handle.stop()).resolves.toBeUndefined();
        } finally {
            rejectAttempt(failure);
            await Promise.all([first, second]);
            child.emit('exit', 0, null);
        }
    });

    it.each(['failed_stop', 'post_spawn_error'] as const)('keeps containing cancellation effective after %s', async boundary => {
        // Only child events and physical termination are substituted; the public service and supervision are real.
        const child = new FakeChildProcess() as unknown as ChildProcess;
        const grants = createPluginExecSystemToolGrantStore();
        grants.register({ grantId: 'cancel-retry-fixture', toolId: 'claude', executablePath: '/fixture/claude', expiresAt: null });
        const controller = new AbortController();
        const failure = new Error('manual physical stop rejected');
        let alive = true;
        let attempts = 0;
        const service = createTerminalRuntimeProcessService({
            spawn: () => child,
            verifyExecutableGrant: grants.verifyGrant,
            terminateProcessTree: async () => {
                attempts += 1;
                if (boundary === 'failed_stop' && attempts === 1) throw failure;
                alive = false;
                child.emit('exit', null, 'SIGTERM');
            },
        });
        const handle = await service.launch({ executable: { path: '/fixture/claude',
            hostGrant: { kind: 'system-tool', grantId: 'cancel-retry-fixture' } },
            cwd: '/repo', signal: controller.signal });
        try {
            if (boundary === 'failed_stop') {
                await expect(handle.stop()).rejects.toBe(failure);
            } else {
                child.emit('error', new Error('post-spawn observation failed'));
            }
            expect(alive).toBe(true);
            controller.abort();
            await vi.waitFor(() => expect(alive).toBe(false));
            await expect(handle.waitForTermination()).resolves.toEqual({ type: 'signaled', signal: 'SIGTERM' });
        } finally { child.emit('exit', 0, null); }
    });

    it('preserves cancellation and physical cleanup failures after spawn', async () => {
        const child = new FakeChildProcess() as unknown as ChildProcess;
        const grants = createPluginExecSystemToolGrantStore();
        grants.register({ grantId: 'aborted-stop-fixture', toolId: 'claude', executablePath: '/fixture/claude', expiresAt: null });
        const controller = new AbortController();
        const cleanupFailure = new Error('spawned child cleanup rejected');
        const service = createTerminalRuntimeProcessService({
            spawn: () => { controller.abort(); return child; },
            verifyExecutableGrant: grants.verifyGrant,
            terminateProcessTree: async () => { throw cleanupFailure; },
        });
        try {
            await expect(service.launch({ executable: { path: '/fixture/claude',
                hostGrant: { kind: 'system-tool', grantId: 'aborted-stop-fixture' } },
                cwd: '/repo', signal: controller.signal })).rejects.toMatchObject({
                errors: [expect.objectContaining({ name: 'AbortError' }), cleanupFailure],
                cause: expect.objectContaining({ name: 'AbortError' }),
            });
        } finally { child.emit('exit', 0, null); }
    });

    it('reports cancellation stop rejection while keeping the handle retryable', async () => {
        const child = new FakeChildProcess() as unknown as ChildProcess;
        const grants = createPluginExecSystemToolGrantStore();
        grants.register({ grantId: 'cancel-stop-fixture', toolId: 'claude', executablePath: '/fixture/claude', expiresAt: null });
        const controller = new AbortController();
        const failure = new Error('cancellation stop rejected');
        let failed = false;
        const report = vi.spyOn(logger, 'infoFile');
        const service = createTerminalRuntimeProcessService({
            spawn: () => child,
            verifyExecutableGrant: grants.verifyGrant,
            terminateProcessTree: async () => {
                if (!failed) { failed = true; throw failure; }
                child.emit('exit', 0, null);
            },
        });
        const handle = await service.launch({ executable: { path: '/fixture/claude',
            hostGrant: { kind: 'system-tool', grantId: 'cancel-stop-fixture' } },
            cwd: '/repo', signal: controller.signal });
        try {
            controller.abort();
            await vi.waitFor(() => expect(report.mock.calls.some(call =>
                typeof call[1] === 'object' && call[1] !== null
                    && Reflect.get(call[1], 'code') === 'terminal_process_stop_failed')).toBe(true));
            await handle.stop();
            await expect(handle.waitForTermination()).resolves.toEqual({ type: 'exited', code: 0 });
        } finally { report.mockRestore(); child.emit('exit', 0, null); }
    });

    it('fails closed when asked to launch a non-absolute executable path', async () => {
        const spawn = vi.fn();
        const service = createTerminalRuntimeProcessService({
            spawn,
            createManagedChildProcess: vi.fn(),
            terminateProcessTree: vi.fn(),
        });

        await expect(service.launch({
            executable: {
                path: 'codex',
                hostGrant: { kind: 'system-tool', grantId: 'system-tool:codex' },
            },
            args: [],
            cwd: '/repo',
            env: {},
        })).rejects.toThrow(/absolute executable/i);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('fails closed when an absolute executable lacks a host-issued grant descriptor', async () => {
        const spawn = vi.fn();
        const service = createTerminalRuntimeProcessService({
            spawn,
            createManagedChildProcess: vi.fn(),
            terminateProcessTree: vi.fn(),
        });

        await expect(service.launch({
            // @ts-expect-error Missing hostGrant exercises runtime validation for untyped plugin callers.
            executable: { path: '/usr/local/bin/codex' },
            args: [],
            cwd: '/repo',
            env: {},
        })).rejects.toThrow(/host-issued executable grant/i);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('denies managed runtime and package-manager shim executables before spawn', async () => {
        const spawn = vi.fn();
        const service = createTerminalRuntimeProcessService({
            spawn,
            createManagedChildProcess: vi.fn(),
            terminateProcessTree: vi.fn(),
        });

        await expect(service.launch({
            executable: {
                path: '/tmp/npm.cmd',
                hostGrant: { kind: 'system-tool', grantId: 'system-tool:npm' },
            },
            args: ['--version'],
            cwd: '/repo',
            env: {},
        })).rejects.toThrow(/managed runtime/i);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects forged non-empty host grant descriptors before spawn', async () => {
        const spawn = vi.fn();
        const verifyExecutableGrant = vi.fn(() => false);
        const service = createTerminalRuntimeProcessService({
            spawn,
            createManagedChildProcess: vi.fn(),
            terminateProcessTree: vi.fn(),
            verifyExecutableGrant,
        });

        await expect(service.launch({
            executable: {
                path: '/usr/local/bin/codex',
                hostGrant: { kind: 'system-tool', grantId: 'system-tool:forged' },
            },
            args: [],
            cwd: '/repo',
            env: {},
        })).rejects.toThrow(/trusted host-issued executable grant/i);
        expect(verifyExecutableGrant).toHaveBeenCalledWith({
            kind: 'system-tool',
            grantId: 'system-tool:forged',
            executablePath: '/usr/local/bin/codex',
        });
        expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects host grants that were issued for a different executable path before spawn', async () => {
        const spawn = vi.fn();
        const grantStore = createPluginExecSystemToolGrantStore({ now: () => 1000 });
        grantStore.register({
            grantId: 'system-tool:trusted-codex',
            toolId: 'codex',
            executablePath: '/usr/local/bin/codex',
            expiresAt: null,
        });
        const service = createTerminalRuntimeProcessService({
            spawn,
            createManagedChildProcess: vi.fn(),
            terminateProcessTree: vi.fn(),
            verifyExecutableGrant: grantStore.verifyGrant,
        });

        await expect(service.launch({
            executable: {
                path: '/tmp/codex',
                hostGrant: { kind: 'system-tool', grantId: 'system-tool:trusted-codex' },
            },
            args: [],
            cwd: '/repo',
            env: {},
        })).rejects.toThrow(/trusted host-issued executable grant/i);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('launches host-granted agent CLI executable descriptors', async () => {
        // Test boundary fixture: the process service only reads pid/stderr from the child directly.
        const child = new FakeChildProcess() as unknown as ChildProcess;
        const spawn = vi.fn(() => child);
        const verifyExecutableGrant = vi.fn(() => true);
        const service = createTerminalRuntimeProcessService({
            spawn,
            createManagedChildProcess: vi.fn(() => ({
                pid: child.pid ?? null,
                waitForTermination: vi.fn(async () => ({ type: 'exited' as const, code: 0 })),
            })),
            terminateProcessTree: vi.fn(),
            verifyExecutableGrant,
        });

        const handle = await service.launch({
            executable: {
                path: '/usr/local/bin/codex',
                hostGrant: {
                    kind: 'agent-cli',
                    grantId: 'agent-cli:codex',
                },
            },
            args: ['--model', 'gpt-5'],
            cwd: '/repo',
            env: {
                CODEX_HOME: '/tmp/codex-home',
                CLAUDE_CODE_ENTRYPOINT: 'happier',
                CLAUDECODE: '1',
                HAPPIER_DAEMON_RUNTIME_ID: 'runtime-parent',
            },
            stdio: 'inherit',
        });

        expect(verifyExecutableGrant).toHaveBeenCalledWith({
            kind: 'agent-cli',
            grantId: 'agent-cli:codex',
            executablePath: '/usr/local/bin/codex',
        });
        expect(spawn).toHaveBeenCalledWith('/usr/local/bin/codex', ['--model', 'gpt-5'], expect.objectContaining({
            cwd: '/repo',
            env: expect.objectContaining({ CODEX_HOME: '/tmp/codex-home' }),
            stdio: 'inherit',
        }));
        // Boundary fixture: Vitest cannot infer the injected SpawnLike call tuple from the fake child factory.
        const launchedEnv = (spawn.mock.calls[0] as unknown as [string, readonly string[], { env?: NodeJS.ProcessEnv }])?.[2]?.env;
        expect(launchedEnv?.CLAUDE_CODE_ENTRYPOINT).toBe('happier');
        expect(launchedEnv?.CLAUDECODE).toBeUndefined();
        expect(launchedEnv?.HAPPIER_DAEMON_RUNTIME_ID).toBeUndefined();
        await expect(handle.waitForTermination()).resolves.toEqual({ type: 'exited', code: 0 });
    });

    it('does not inherit or accept spoofed session-control metadata at the final launch boundary', async () => {
        const envScope = createEnvKeyScope([
            'HAPPIER_PROCESS_OWNER',
            'HAPPIER_SESSION_PROFILE_ID',
            'HAPPIER_SESSION_ATTACH_FILE',
            'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON',
        ]);
        envScope.patch({
            HAPPIER_PROCESS_OWNER: 'v1.0123456789ab.session.session-terminal',
            HAPPIER_SESSION_PROFILE_ID: 'ambient-profile',
            HAPPIER_SESSION_ATTACH_FILE: '/tmp/ambient-attach.json',
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'ambient-selections',
        });
        try {
            const child = new FakeChildProcess() as unknown as ChildProcess;
            const spawn = vi.fn(() => child);
            const service = createTerminalRuntimeProcessService({
                spawn,
                createManagedChildProcess: vi.fn(() => ({
                    pid: child.pid ?? null,
                    waitForTermination: vi.fn(async () => ({ type: 'exited' as const, code: 0 })),
                })),
                terminateProcessTree: vi.fn(),
                verifyExecutableGrant: vi.fn(() => true),
            });

            const handle = await service.launch({
                executable: {
                    path: '/usr/local/bin/codex',
                    hostGrant: { kind: 'agent-cli', grantId: 'agent-cli:codex' },
                },
                cwd: '/repo',
                env: {
                    HAPPIER_PROCESS_OWNER: 'plugin-forged-owner',
                    HAPPIER_SESSION_PROFILE_ID: 'plugin-spoof',
                    HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'plugin-spoof',
                    SAFE_VALUE: 'kept',
                },
                unsetEnvKeys: ['HAPPIER_PROCESS_OWNER'],
            });

            const launchedEnv = (spawn.mock.calls[0] as unknown as [string, readonly string[], { env?: NodeJS.ProcessEnv }])?.[2]?.env;
            expect(launchedEnv?.HAPPIER_SESSION_PROFILE_ID).toBeUndefined();
            expect(launchedEnv?.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
            expect(launchedEnv?.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON).toBeUndefined();
            expect(launchedEnv?.SAFE_VALUE).toBe('kept');
            expect(launchedEnv?.HAPPIER_PROCESS_OWNER).toBe('v1.0123456789ab.session.session-terminal');
            await handle.stop();
        } finally {
            envScope.restore();
        }
    });

    it('resolves agent CLI launches into host-granted terminal executable descriptors', async () => {
        const registerExecutableGrant = vi.fn();
        const resolveAgentCliLaunch = vi.fn(() => ({
            source: 'system' as const,
            resolvedPath: '/usr/local/bin/codex',
            command: '/opt/happier/bin/node',
            args: ['/usr/local/bin/codex'],
        }));
        const service = createTerminalRuntimeProcessService({
            spawn: vi.fn(),
            createManagedChildProcess: vi.fn(),
            terminateProcessTree: vi.fn(),
            registerExecutableGrant,
            resolveAgentCliLaunch,
            now: () => 1000,
        });

        expect(typeof service.resolveAgentCliExecutable).toBe('function');

        const resolved = await service.resolveAgentCliExecutable!({
            agentId: 'codex',
            cwd: '/repo',
            env: { CODEX_HOME: '/tmp/codex-home' },
        });

        expect(resolveAgentCliLaunch).toHaveBeenCalledWith({
            agentId: 'codex',
            cwd: '/repo',
            env: { CODEX_HOME: '/tmp/codex-home' },
        });
        expect(registerExecutableGrant).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'agent-cli',
            agentId: 'codex',
            executablePath: '/opt/happier/bin/node',
            expiresAt: null,
        }));
        expect(resolved).toEqual({
            executable: {
                path: '/opt/happier/bin/node',
                hostGrant: {
                    kind: 'agent-cli',
                    grantId: expect.stringMatching(/^agent-cli:/u),
                },
            },
            args: ['/usr/local/bin/codex'],
            source: 'system',
            resolvedPath: '/usr/local/bin/codex',
        });
    });

    it('launches with host process supervision and returns sanitized termination results', async () => {
        // Test boundary fixture: the process service only reads pid/stderr from the child directly.
        const child = new FakeChildProcess() as unknown as ChildProcess;
        const managed = {
            pid: child.pid ?? null,
            waitForTermination: vi.fn(async () => ({ type: 'exited' as const, code: 0 })),
        };
        const spawn = vi.fn(() => child);
        const verifyExecutableGrant = vi.fn(() => true);
        const service = createTerminalRuntimeProcessService({
            spawn,
            createManagedChildProcess: vi.fn(() => managed),
            terminateProcessTree: vi.fn(),
            verifyExecutableGrant,
        });

        const handle = await service.launch({
            executable: {
                path: '/usr/local/bin/codex',
                hostGrant: { kind: 'system-tool', grantId: 'system-tool:codex' },
            },
            args: ['--model', 'gpt-5'],
            cwd: '/repo',
            env: { CODEX_HOME: '/tmp/codex-home' },
            stdio: 'inherit',
            windowsHide: true,
        });

        expect(verifyExecutableGrant).toHaveBeenCalledWith({
            kind: 'system-tool',
            grantId: 'system-tool:codex',
            executablePath: '/usr/local/bin/codex',
        });
        expect(spawn).toHaveBeenCalledWith('/usr/local/bin/codex', ['--model', 'gpt-5'], expect.objectContaining({
            cwd: '/repo',
            env: expect.objectContaining({ CODEX_HOME: '/tmp/codex-home' }),
            stdio: 'inherit',
            windowsHide: true,
        }));
        await expect(handle.waitForTermination()).resolves.toEqual({ type: 'exited', code: 0 });
        expect(handle).not.toHaveProperty('child');
    });

    it('cleans up a spawned process when host supervision setup fails', async () => {
        // Test boundary fixture: the process service only reads pid/stderr from the child directly.
        const child = new FakeChildProcess() as unknown as ChildProcess;
        const setupError = new Error('supervision setup failed');
        const terminateProcessTree = vi.fn(async () => {});
        const service = createTerminalRuntimeProcessService({
            spawn: vi.fn(() => child),
            createManagedChildProcess: vi.fn(() => {
                throw setupError;
            }),
            terminateProcessTree,
            verifyExecutableGrant: vi.fn(() => true),
        });

        await expect(service.launch({
            executable: {
                path: '/usr/local/bin/codex',
                hostGrant: { kind: 'system-tool', grantId: 'system-tool:codex' },
            },
            args: [],
            cwd: '/repo',
        })).rejects.toThrow('supervision setup failed');

        expect(terminateProcessTree).toHaveBeenCalledWith(child, undefined);
    });

    it('kills the spawned child when launch aborts after spawn but before the handle is returned', async () => {
        // Test boundary fixture: the process service only reads pid/stderr from the child directly.
        const child = new FakeChildProcess() as unknown as ChildProcess;
        const controller = new AbortController();
        const terminateProcessTree = vi.fn(async () => {});
        const service = createTerminalRuntimeProcessService({
            spawn: vi.fn(() => child),
            createManagedChildProcess: vi.fn(() => {
                controller.abort();
                return {
                    pid: child.pid ?? null,
                    waitForTermination: vi.fn(async () => ({ type: 'exited' as const, code: 0 })),
                };
            }),
            terminateProcessTree,
            verifyExecutableGrant: vi.fn(() => true),
        });

        await expect(service.launch({
            executable: {
                path: '/usr/local/bin/codex',
                hostGrant: { kind: 'system-tool', grantId: 'system-tool:codex' },
            },
            args: [],
            cwd: '/repo',
            signal: controller.signal,
        })).rejects.toMatchObject({
            name: 'AbortError',
        });

        expect(terminateProcessTree).toHaveBeenCalledTimes(1);
        expect(terminateProcessTree).toHaveBeenCalledWith(child, undefined);
    });

    it('removes abort listeners when the launched process is stopped before waiting', async () => {
        // Test boundary fixture: the process service only reads pid/stderr from the child directly.
        const child = new FakeChildProcess() as unknown as ChildProcess;
        const controller = new AbortController();
        const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
        const terminateProcessTree = vi.fn(async () => {});
        const service = createTerminalRuntimeProcessService({
            spawn: vi.fn(() => child),
            createManagedChildProcess: vi.fn(() => ({
                pid: child.pid ?? null,
                waitForTermination: vi.fn(async () => ({ type: 'exited' as const, code: 0 })),
            })),
            terminateProcessTree,
            verifyExecutableGrant: vi.fn(() => true),
        });

        const handle = await service.launch({
            executable: {
                path: '/usr/local/bin/codex',
                hostGrant: { kind: 'system-tool', grantId: 'system-tool:codex' },
            },
            args: [],
            cwd: '/repo',
            signal: controller.signal,
        });

        await handle.stop();

        expect(terminateProcessTree).toHaveBeenCalledWith(child, undefined);
        expect(removeAbortListener).toHaveBeenCalled();
    });
});
