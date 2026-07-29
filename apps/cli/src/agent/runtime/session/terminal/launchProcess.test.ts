import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { createPluginExecSystemToolGrantStore } from '@/plugins/runtime/exec/system/tools/grants';
import { createEnvKeyScope } from '@/testkit/env/envScope';

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
    it('fails closed when asked to launch a non-absolute executable path', async () => {
        const spawn = vi.fn();
        const service = createTerminalRuntimeProcessService({
            spawn,
            createManagedChildProcess: vi.fn(),
            killProcessTree: vi.fn(),
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
            killProcessTree: vi.fn(),
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
            killProcessTree: vi.fn(),
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
            killProcessTree: vi.fn(),
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
            killProcessTree: vi.fn(),
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
            killProcessTree: vi.fn(),
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
        expect(launchedEnv?.CLAUDECODE).toBeUndefined();
        expect(launchedEnv?.HAPPIER_DAEMON_RUNTIME_ID).toBeUndefined();
        await expect(handle.waitForTermination()).resolves.toEqual({ type: 'exited', code: 0 });
    });

    it('does not inherit or accept spoofed session-control metadata at the final launch boundary', async () => {
        const envScope = createEnvKeyScope([
            'HAPPIER_SESSION_PROFILE_ID',
            'HAPPIER_SESSION_ATTACH_FILE',
            'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON',
        ]);
        envScope.patch({
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
                killProcessTree: vi.fn(),
                verifyExecutableGrant: vi.fn(() => true),
            });

            const handle = await service.launch({
                executable: {
                    path: '/usr/local/bin/codex',
                    hostGrant: { kind: 'agent-cli', grantId: 'agent-cli:codex' },
                },
                cwd: '/repo',
                env: {
                    HAPPIER_SESSION_PROFILE_ID: 'plugin-spoof',
                    HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'plugin-spoof',
                    SAFE_VALUE: 'kept',
                },
            });

            const launchedEnv = (spawn.mock.calls[0] as unknown as [string, readonly string[], { env?: NodeJS.ProcessEnv }])?.[2]?.env;
            expect(launchedEnv?.HAPPIER_SESSION_PROFILE_ID).toBeUndefined();
            expect(launchedEnv?.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
            expect(launchedEnv?.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON).toBeUndefined();
            expect(launchedEnv?.SAFE_VALUE).toBe('kept');
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
            killProcessTree: vi.fn(),
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
            killProcessTree: vi.fn(),
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
        const killProcessTree = vi.fn(async () => {});
        const service = createTerminalRuntimeProcessService({
            spawn: vi.fn(() => child),
            createManagedChildProcess: vi.fn(() => {
                throw setupError;
            }),
            killProcessTree,
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

        expect(killProcessTree).toHaveBeenCalledWith(child, undefined);
    });

    it('kills the spawned child when launch aborts after spawn but before the handle is returned', async () => {
        // Test boundary fixture: the process service only reads pid/stderr from the child directly.
        const child = new FakeChildProcess() as unknown as ChildProcess;
        const controller = new AbortController();
        const killProcessTree = vi.fn(async () => {});
        const service = createTerminalRuntimeProcessService({
            spawn: vi.fn(() => child),
            createManagedChildProcess: vi.fn(() => {
                controller.abort();
                return {
                    pid: child.pid ?? null,
                    waitForTermination: vi.fn(async () => ({ type: 'exited' as const, code: 0 })),
                };
            }),
            killProcessTree,
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

        expect(killProcessTree).toHaveBeenCalledTimes(1);
        expect(killProcessTree).toHaveBeenCalledWith(child, undefined);
    });

    it('removes abort listeners when the launched process is stopped before waiting', async () => {
        // Test boundary fixture: the process service only reads pid/stderr from the child directly.
        const child = new FakeChildProcess() as unknown as ChildProcess;
        const controller = new AbortController();
        const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
        const killProcessTree = vi.fn(async () => {});
        const service = createTerminalRuntimeProcessService({
            spawn: vi.fn(() => child),
            createManagedChildProcess: vi.fn(() => ({
                pid: child.pid ?? null,
                waitForTermination: vi.fn(async () => ({ type: 'exited' as const, code: 0 })),
            })),
            killProcessTree,
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

        expect(killProcessTree).toHaveBeenCalledWith(child, undefined);
        expect(removeAbortListener).toHaveBeenCalled();
    });
});
