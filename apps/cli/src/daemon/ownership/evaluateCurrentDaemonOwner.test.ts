import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { mockCurrentProcessAsDaemonLifecycleOwner } from '@/testkit/process/daemonLifecycleOwner';
import type { HappyProcessInfo } from '@/daemon/doctor';
import { isDaemonProcessForCurrentRuntimeRoot } from './evaluateCurrentDaemonOwner';

describe('isDaemonProcessForCurrentRuntimeRoot', () => {
    const runtimeRoot = '/users/test/dev/happier/apps/cli';
    const otherPid = process.pid + 1;

    it('does not treat a transient `daemon start` launcher as a running daemon owner', () => {
        // The launcher is a short-lived bootstrapper that spawns the detached `start-sync`
        // daemon and then waits for the relay. Classifying it as a stateless owner makes the
        // daemon conflict with its own startup machinery and never come up.
        const launcher: HappyProcessInfo = {
            pid: otherPid,
            command: `/runtime/node /users/test/dev/happier/apps/cli/dist/index.mjs daemon start`,
            type: 'daemon',
        };
        expect(isDaemonProcessForCurrentRuntimeRoot(launcher, runtimeRoot)).toBe(false);
    });

    it('treats a real `daemon start-sync` process for the runtime root as an owner', () => {
        const daemon: HappyProcessInfo = {
            pid: otherPid,
            command: `/runtime/node --import tsx /users/test/dev/happier/apps/cli/src/index.ts daemon start-sync`,
            type: 'dev-daemon',
        };
        expect(isDaemonProcessForCurrentRuntimeRoot(daemon, runtimeRoot)).toBe(true);
    });

    it('ignores the current process and non-daemon process types', () => {
        const self: HappyProcessInfo = {
            pid: process.pid,
            command: `/runtime/node /users/test/dev/happier/apps/cli/dist/index.mjs daemon start-sync`,
            type: 'daemon',
        };
        const session: HappyProcessInfo = {
            pid: otherPid,
            command: `/runtime/node /users/test/dev/happier/apps/cli/src/index.ts claude --started-by daemon`,
            type: 'daemon-spawned-session',
        };
        expect(isDaemonProcessForCurrentRuntimeRoot(self, runtimeRoot)).toBe(false);
        expect(isDaemonProcessForCurrentRuntimeRoot(session, runtimeRoot)).toBe(false);
    });

    it('ignores a start-sync daemon rooted at a different runtime path', () => {
        const otherRoot: HappyProcessInfo = {
            pid: otherPid,
            command: `/runtime/node /users/test/other/happier/apps/cli/src/index.ts daemon start-sync`,
            type: 'dev-daemon',
        };
        expect(isDaemonProcessForCurrentRuntimeRoot(otherRoot, runtimeRoot)).toBe(false);
    });
});

describe('evaluateCurrentDaemonOwner', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK',
        'HAPPIER_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
    ]);

    beforeEach(() => {
        envScope.patch({
            HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined,
            HAPPIER_SERVER_URL: undefined,
            HAPPIER_WEBAPP_URL: undefined,
        });
    });

    afterEach(() => {
        envScope.restore();
        vi.resetModules();
        vi.doUnmock('@/daemon/doctor');
    });

    it('returns none when no daemon state exists', async () => {
        await withTempDir('happier-daemon-owner-none-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const { evaluateCurrentDaemonOwner } = await import('./evaluateCurrentDaemonOwner');
            await expect(evaluateCurrentDaemonOwner()).resolves.toEqual({ kind: 'none' });
        });
    });

    it('allows an expected daemon to finish initial authentication when its startup lock exists before state', async () => {
        await withTempDir('happier-daemon-owner-starting-lock-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
            });
            const child = spawn(
                process.execPath,
                ['-e', 'setInterval(() => {}, 1000)', join(process.cwd(), 'src/index.ts'), 'daemon', 'start-sync'],
                { stdio: 'ignore' },
            );
            if (!child.pid) throw new Error('missing daemon fixture pid');

            try {
                vi.resetModules();
                const [{ configuration }, { evaluateCurrentDaemonOwner }] = await Promise.all([
                    import('@/configuration'),
                    import('./evaluateCurrentDaemonOwner'),
                ]);
                mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
                writeFileSync(configuration.daemonLockFile, String(child.pid), 'utf8');

                await expect(evaluateCurrentDaemonOwner()).resolves.toEqual({ kind: 'none' });
            } finally {
                child.kill('SIGKILL');
            }
        });
    });

    it('ignores a state-less daemon process from the same runtime when it belongs to another daemon scope', async () => {
        await withTempDir('happier-daemon-owner-scope-mismatch-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'stack_current__id_default',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
            });
            vi.resetModules();
            vi.doMock('@/daemon/doctor', () => ({
                findAllHappyProcesses: async () => [
                    {
                        pid: process.pid + 1000,
                        command: `${process.execPath} ${process.cwd()}/src/index.ts daemon start-sync`,
                        type: 'dev-daemon',
                        daemonOwnershipEnvironmentVariables: {
                            HAPPIER_HOME_DIR: `${homeDir}-other`,
                            HAPPIER_ACTIVE_SERVER_ID: 'stack_other__id_default',
                        },
                    } satisfies HappyProcessInfo & {
                        daemonOwnershipEnvironmentVariables: Record<string, string>;
                    },
                ],
            }));

            try {
                const { evaluateCurrentDaemonOwner } = await import('./evaluateCurrentDaemonOwner');
                await expect(evaluateCurrentDaemonOwner()).resolves.toEqual({ kind: 'none' });
            } finally {
                vi.doUnmock('@/daemon/doctor');
            }
        });
    });

    it.each([
        { inventoryScope: 'unavailable', expectedKind: 'none' },
        { inventoryScope: 'home-only', expectedKind: 'none' },
        { inventoryScope: 'released-relay', expectedKind: 'conflict' },
    ] as const)('requires proven scope before treating $inventoryScope inventory as a daemon owner', async ({ inventoryScope, expectedKind }) => {
        await withTempDir('happier-daemon-owner-scope-evidence-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_SERVER_URL: 'http://127.0.0.1:43127',
                HAPPIER_WEBAPP_URL: 'http://127.0.0.1:43127',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
            });
            vi.resetModules();
            const { projectPath } = await import('@/projectPath');
            // OS inventory cannot read ownership environment on Windows and may be partial elsewhere.
            vi.doMock('@/daemon/doctor', async (importOriginal) => ({
                ...await importOriginal<typeof import('@/daemon/doctor')>(),
                findAllHappyProcesses: async () => [{
                    pid: process.pid + 1000,
                    command: `${process.execPath} ${projectPath()}/src/index.ts daemon start-sync`,
                    type: 'dev-daemon',
                    ...(inventoryScope === 'unavailable' ? {} : {
                        daemonOwnershipEnvironmentVariables: {
                            HAPPIER_HOME_DIR: homeDir,
                            ...(inventoryScope === 'released-relay' ? {
                                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                                HAPPIER_SERVER_URL: 'http://127.0.0.1:43127',
                            } : {}),
                        },
                    }),
                } satisfies HappyProcessInfo],
            }));

            const { evaluateCurrentDaemonOwner } = await import('./evaluateCurrentDaemonOwner');
            const evaluation = await evaluateCurrentDaemonOwner();
            expect(evaluation.kind).toBe(expectedKind);
            if (evaluation.kind === 'conflict') {
                expect(evaluation.owner.source).toBe('process');
                expect(evaluation.owner.state.pid).toBe(process.pid + 1000);
            }
        });
    });

    it('recognizes a released runner lifecycle derived from the active server when the replacement daemon has no explicit scope', async () => {
        await withTempDir('happier-daemon-owner-derived-scope-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined,
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });
            vi.resetModules();

            const { daemonProcessMatchesCurrentScope } = await import('./daemonProcessScopeIdentity');
            const runner = {
                pid: process.pid + 1000,
                command: `${process.execPath} happier claude --started-by daemon`,
                type: 'daemon-spawned-session',
                daemonOwnershipEnvironmentVariables: {
                    HAPPIER_HOME_DIR: homeDir,
                    HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
                },
            } satisfies HappyProcessInfo;

            expect(daemonProcessMatchesCurrentScope(runner)).toBe(true);
            expect(daemonProcessMatchesCurrentScope({
                ...runner,
                daemonOwnershipEnvironmentVariables: {
                    ...runner.daemonOwnershipEnvironmentVariables,
                    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'foreign',
                },
            })).toBe(false);
        });
    });

    it('blocks a real state-less daemon with the same explicit lifecycle scope despite a different endpoint profile', async () => {
        await withTempDir('happier-daemon-owner-lifecycle-match-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'current-endpoint-profile',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
            });
            vi.resetModules();
            vi.doMock('@/daemon/controlClient', () => ({
                inspectDaemonRunningStateAndCleanupStaleState: async () => ({ status: 'not-running' }),
            }));
            vi.doMock('@/daemon/doctor', () => ({
                findAllHappyProcesses: async () => [{
                    pid: process.pid + 1000,
                    command: `${process.execPath} ${process.cwd()}/apps/cli/src/index.ts daemon start-sync`,
                    type: 'dev-daemon',
                    daemonOwnershipEnvironmentVariables: {
                        HAPPIER_HOME_DIR: homeDir,
                        HAPPIER_ACTIVE_SERVER_ID: 'older-endpoint-profile',
                        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
                    },
                } satisfies HappyProcessInfo],
            }));

            try {
                const { evaluateCurrentDaemonOwner } = await import('./evaluateCurrentDaemonOwner');
                const evaluation = await evaluateCurrentDaemonOwner();
                expect(evaluation.kind).toBe('conflict');
                if (evaluation.kind === 'conflict') {
                    expect(evaluation.owner.source).toBe('process');
                    expect(evaluation.owner.state.pid).toBe(process.pid + 1000);
                }
            } finally {
                vi.doUnmock('@/daemon/controlClient');
                vi.doUnmock('@/daemon/doctor');
            }
        });
    });

    it('blocks a real state-less daemon with the same explicit lifecycle scope despite a changed endpoint URL', async () => {
        await withTempDir('happier-daemon-owner-lifecycle-match-url-change-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'current-endpoint-profile',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
                HAPPIER_SERVER_URL: 'http://127.0.0.1:43127',
                HAPPIER_WEBAPP_URL: 'http://127.0.0.1:43127',
            });
            vi.resetModules();
            vi.doMock('@/daemon/controlClient', () => ({
                inspectDaemonRunningStateAndCleanupStaleState: async () => ({ status: 'not-running' }),
            }));
            vi.doMock('@/daemon/doctor', () => ({
                findAllHappyProcesses: async () => [{
                    pid: process.pid + 1000,
                    command: `${process.execPath} ${process.cwd()}/apps/cli/src/index.ts daemon start-sync`,
                    type: 'dev-daemon',
                    daemonOwnershipEnvironmentVariables: {
                        HAPPIER_HOME_DIR: homeDir,
                        HAPPIER_ACTIVE_SERVER_ID: 'older-endpoint-profile',
                        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
                        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
                    },
                } satisfies HappyProcessInfo],
            }));

            try {
                const { evaluateCurrentDaemonOwner } = await import('./evaluateCurrentDaemonOwner');
                const evaluation = await evaluateCurrentDaemonOwner();
                expect(evaluation.kind).toBe('conflict');
                if (evaluation.kind === 'conflict') {
                    expect(evaluation.owner.source).toBe('process');
                }
            } finally {
                vi.doUnmock('@/daemon/controlClient');
                vi.doUnmock('@/daemon/doctor');
            }
        });
    });

    it('rejects a state-less daemon with a different explicit lifecycle scope despite the same endpoint profile', async () => {
        await withTempDir('happier-daemon-owner-lifecycle-mismatch-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'shared-endpoint-profile',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
            });
            vi.resetModules();
            vi.doMock('@/daemon/controlClient', () => ({
                inspectDaemonRunningStateAndCleanupStaleState: async () => ({ status: 'not-running' }),
            }));
            vi.doMock('@/daemon/doctor', () => ({
                findAllHappyProcesses: async () => [{
                    pid: process.pid + 1000,
                    command: `${process.execPath} ${process.cwd()}/apps/cli/src/index.ts daemon start-sync`,
                    type: 'dev-daemon',
                    daemonOwnershipEnvironmentVariables: {
                        HAPPIER_HOME_DIR: homeDir,
                        HAPPIER_ACTIVE_SERVER_ID: 'shared-endpoint-profile',
                        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-other__id_default',
                    },
                } satisfies HappyProcessInfo],
            }));

            try {
                const { evaluateCurrentDaemonOwner } = await import('./evaluateCurrentDaemonOwner');
                await expect(evaluateCurrentDaemonOwner()).resolves.toEqual({ kind: 'none' });
            } finally {
                vi.doUnmock('@/daemon/controlClient');
                vi.doUnmock('@/daemon/doctor');
            }
        });
    });

    it('does not treat a current explicitly scoped daemon as an old daemon when the caller has no lifecycle scope', async () => {
        await withTempDir('happier-daemon-owner-current-scope-vs-generic-caller-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'shared-endpoint-profile',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined,
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
            });
            vi.resetModules();
            vi.doMock('@/daemon/controlClient', () => ({
                inspectDaemonRunningStateAndCleanupStaleState: async () => ({ status: 'not-running' }),
            }));
            vi.doMock('@/daemon/doctor', () => ({
                findAllHappyProcesses: async () => [{
                    pid: process.pid + 1000,
                    command: `${process.execPath} ${process.cwd()}/apps/cli/src/index.ts daemon start-sync`,
                    type: 'dev-daemon',
                    daemonOwnershipEnvironmentVariables: {
                        HAPPIER_HOME_DIR: homeDir,
                        HAPPIER_ACTIVE_SERVER_ID: 'shared-endpoint-profile',
                        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
                    },
                } satisfies HappyProcessInfo],
            }));

            try {
                const { evaluateCurrentDaemonOwner } = await import('./evaluateCurrentDaemonOwner');
                await expect(evaluateCurrentDaemonOwner()).resolves.toEqual({ kind: 'none' });
            } finally {
                vi.doUnmock('@/daemon/controlClient');
                vi.doUnmock('@/daemon/doctor');
            }
        });
    });

    it('returns a compatible manual owner when the current version and release channel already match', async () => {
        await withTempDir('happier-daemon-owner-compatible-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });
            vi.resetModules();
            mockCurrentProcessAsDaemonLifecycleOwner();

            const [{ configuration }, { writeDaemonState }, { evaluateCurrentDaemonOwner }] = await Promise.all([
                import('@/configuration'),
                import('@/persistence'),
                import('./evaluateCurrentDaemonOwner'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: configuration.currentCliVersion,
                startedWithPublicReleaseChannel: 'dev',
                runtimeId: 'runtime-compatible',
                startupSource: 'manual',
            });

            const evaluation = await evaluateCurrentDaemonOwner();
            expect(evaluation.kind).toBe('compatible');
            if (evaluation.kind !== 'compatible') {
                throw new Error(`unexpected evaluation: ${evaluation.kind}`);
            }
            expect(evaluation.owner.serviceManaged).toBe(false);
            expect(evaluation.owner.state.runtimeId).toBe('runtime-compatible');
        });
    });

    it('returns a conflict for a service-managed owner on a different version or release channel', async () => {
        await withTempDir('happier-daemon-owner-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();
            mockCurrentProcessAsDaemonLifecycleOwner();

            const [{ writeDaemonState }, { evaluateCurrentDaemonOwner }] = await Promise.all([
                import('@/persistence'),
                import('./evaluateCurrentDaemonOwner'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43111,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                runtimeId: 'runtime-conflict',
                startupSource: 'background-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            });

            const evaluation = await evaluateCurrentDaemonOwner();
            expect(evaluation.kind).toBe('conflict');
            if (evaluation.kind !== 'conflict') {
                throw new Error(`unexpected evaluation: ${evaluation.kind}`);
            }
            expect(evaluation.owner.serviceManaged).toBe(true);
            expect(evaluation.owner.versionMatches).toBe(false);
            expect(evaluation.owner.releaseChannelMatches).toBe(false);
            expect(evaluation.owner.state.serviceLabel).toBe('com.happier.cli.daemon.default');
        });
    });

    it('treats legacy daemon state without startup metadata as a manual owner when no service label exists', async () => {
        await withTempDir('happier-daemon-owner-legacy-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();
            mockCurrentProcessAsDaemonLifecycleOwner();

            const [{ writeDaemonState }, { evaluateCurrentDaemonOwner }] = await Promise.all([
                import('@/persistence'),
                import('./evaluateCurrentDaemonOwner'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43112,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                runtimeId: 'runtime-legacy',
            });

            const evaluation = await evaluateCurrentDaemonOwner();
            expect(evaluation.kind).toBe('conflict');
            if (evaluation.kind !== 'conflict') {
                throw new Error(`unexpected evaluation: ${evaluation.kind}`);
            }
            expect(evaluation.owner.serviceManaged).toBe(false);
            expect(evaluation.owner.startupSource).toBe('unknown');
        });
    });

    it('treats legacy daemon state with a service label and missing startup metadata as service-managed', async () => {
        await withTempDir('happier-daemon-owner-legacy-service-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();
            mockCurrentProcessAsDaemonLifecycleOwner();

            const [{ writeDaemonState }, { evaluateCurrentDaemonOwner }] = await Promise.all([
                import('@/persistence'),
                import('./evaluateCurrentDaemonOwner'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43114,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                runtimeId: 'runtime-legacy-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            });

            const evaluation = await evaluateCurrentDaemonOwner();
            expect(evaluation.kind).toBe('conflict');
            if (evaluation.kind !== 'conflict') {
                throw new Error(`unexpected evaluation: ${evaluation.kind}`);
            }
            expect(evaluation.owner.serviceManaged).toBe(true);
            expect(evaluation.owner.startupSource).toBe('unknown');
        });
    });

    it('treats a legacy owner with a matching version and missing release-channel metadata as compatible', async () => {
        await withTempDir('happier-daemon-owner-missing-ring-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });
            vi.resetModules();
            mockCurrentProcessAsDaemonLifecycleOwner();

            const [{ configuration }, { writeDaemonState }, { evaluateCurrentDaemonOwner }] = await Promise.all([
                import('@/configuration'),
                import('@/persistence'),
                import('./evaluateCurrentDaemonOwner'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43113,
                startedAt: Date.now(),
                startedWithCliVersion: configuration.currentCliVersion,
                runtimeId: 'runtime-missing-ring',
                startupSource: 'manual',
            });

            const evaluation = await evaluateCurrentDaemonOwner();
            expect(evaluation.kind).toBe('compatible');
            if (evaluation.kind !== 'compatible') {
                throw new Error(`unexpected evaluation: ${evaluation.kind}`);
            }
            expect(evaluation.owner.versionMatches).toBe(true);
            expect(evaluation.owner.releaseChannelMatches).toBe(false);
        });
    });
});
