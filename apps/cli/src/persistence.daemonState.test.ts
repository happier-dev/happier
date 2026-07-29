import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('readDaemonState', () => {
    const envKeys = [
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
    ] as const;
    let envScope = createEnvKeyScope(envKeys);

    beforeEach(() => {
        envScope.patch({ HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined });
    });

    afterEach(() => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        vi.resetModules();
    });

    it('retries when the daemon state file appears shortly after the call starts', async () => {
        await withTempDir('happier-cli-daemon-state-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined });

            const [{ configuration }, { readDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            setTimeout(() => {
                mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
                writeFileSync(
                    configuration.daemonStateFile,
                    JSON.stringify(
                        {
                            pid: 123,
                            httpPort: 5173,
                            startedAt: Date.now(),
                            startedWithCliVersion: '0.0.0-test',
                            controlToken: 'token-123',
                        },
                        null,
                        2
                    ),
                    'utf-8'
                );
            }, 5);

            const state = await readDaemonState();
            expect(state?.pid).toBe(123);
        });
    });

    it('uses a canonical server-scoped daemon state file name even when the public release channel is dev', async () => {
        await withTempDir('happier-cli-daemon-state-scope-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: undefined,
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });

            const [{ configuration }] = await Promise.all([import('./configuration')]);

            expect(configuration.daemonStateFile).toBe(join(configuration.activeServerDir, 'daemon.state.json'));
        });
    });

    it('falls back to the legacy ring-scoped daemon state file for the active server when the canonical state file is missing', async () => {
        await withTempDir('happier-cli-daemon-state-legacy-ring-fallback-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });

            const [{ configuration }, { readDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            const legacyPath = join(configuration.activeServerDir, 'daemon.dev.state.json');
            mkdirSync(dirname(legacyPath), { recursive: true });
            writeFileSync(
                legacyPath,
                JSON.stringify(
                    {
                        pid: 321,
                        httpPort: 5173,
                        startedAt: Date.now(),
                        startedWithCliVersion: '0.0.0-test',
                        controlToken: 'legacy-token-321',
                    },
                    null,
                    2,
                ),
                'utf-8',
            );

            const state = await readDaemonState();
            expect(state?.pid).toBe(321);
            expect(existsSync(configuration.daemonStateFile)).toBe(true);
            expect(JSON.parse(readFileSync(configuration.daemonStateFile, 'utf-8'))).toMatchObject({
                pid: 321,
                controlToken: 'legacy-token-321',
            });
        });
    });

    it('preserves runtime ownership metadata when reading the canonical daemon state file', async () => {
        await withTempDir('happier-cli-daemon-state-runtime-metadata-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });

            const [{ configuration }, { readDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
            writeFileSync(
                configuration.daemonStateFile,
                JSON.stringify(
                    {
                        pid: 654,
                        httpPort: 5173,
                        startedAt: Date.now(),
                        startedWithCliVersion: '0.0.0-test',
                        startedWithPublicReleaseChannel: 'preview',
                        runtimeId: 'runtime-654',
                        startupSource: 'background-service',
                        serviceLabel: 'com.happier.cli.daemon.default',
                        controlToken: 'ownership-token-654',
                    },
                    null,
                    2,
                ),
                'utf-8',
            );

            const state = await readDaemonState();
            expect(state?.runtimeId).toBe('runtime-654');
            expect(state?.startupSource).toBe('background-service');
            expect(state?.serviceLabel).toBe('com.happier.cli.daemon.default');
            expect(state?.startedWithPublicReleaseChannel).toBe('preview');
        });
    });

    it('reads only the explicit daemon lifecycle scope when the endpoint profile differs', async () => {
        await withTempDir('happier-cli-daemon-state-explicit-lifecycle-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'android-keyboard-qa',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
                HAPPIER_SERVER_URL: 'http://127.0.0.1:52753',
            });

            const [{ configuration }, { readDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);
            mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
            writeFileSync(configuration.daemonStateFile, JSON.stringify({
                pid: 744,
                httpPort: 5173,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-scope',
            }), 'utf-8');

            await expect(readDaemonState()).resolves.toMatchObject({ pid: 744 });
            expect(configuration.daemonStateFile).toBe(
                join(homeDir, 'servers', 'stack_repo-current__id_default', 'daemon.state.json'),
            );
        });
    });

    it('does not scan matching endpoint profiles when an explicit lifecycle scope has no state', async () => {
        await withTempDir('happier-cli-daemon-state-explicit-lifecycle-missing-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'android-keyboard-qa',
                HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
                HAPPIER_SERVER_URL: 'http://127.0.0.1:52753',
            });

            const { readDaemonState } = await import('./persistence');
            const decoyPath = join(homeDir, 'servers', 'matching-profile-alias', 'daemon.state.json');
            mkdirSync(dirname(decoyPath), { recursive: true });
            writeFileSync(decoyPath, JSON.stringify({
                pid: process.pid,
                httpPort: 5173,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-decoy',
            }), 'utf-8');

            await expect(readDaemonState()).resolves.toBeNull();
        });
    });

    it('falls back to a daemon state file under another server dir only when it matches the active server selection', async () => {
        await withTempDir('happier-cli-daemon-state-fallback-', async (homeDir) => {
            const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
                if (signal === 0 && pid === 456) return true;
                const error = new Error('ESRCH') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }) as typeof process.kill);

            try {
                writeFileSync(
                    join(homeDir, 'settings.json'),
                    JSON.stringify(
                        {
                            schemaVersion: 6,
                            onboardingCompleted: false,
                            activeServerId: 'localhost-53288',
                            servers: {
                                'localhost-53288': {
                                    id: 'localhost-53288',
                                    name: 'Current',
                                    serverUrl: 'http://127.0.0.1:53288',
                                    webappUrl: 'http://127.0.0.1:53288',
                                    createdAt: 0,
                                    updatedAt: 0,
                                    lastUsedAt: 0,
                                },
                                'stack_test__id_default': {
                                    id: 'stack_test__id_default',
                                    name: 'Legacy alias',
                                    serverUrl: 'http://127.0.0.1:53288',
                                    webappUrl: 'http://127.0.0.1:53288',
                                    createdAt: 0,
                                    updatedAt: 0,
                                    lastUsedAt: 0,
                                },
                            },
                        },
                        null,
                        2,
                    ),
                    'utf-8',
                );

                vi.resetModules();
                envScope.patch({
                    HAPPIER_HOME_DIR: homeDir,
                    HAPPIER_ACTIVE_SERVER_ID: 'localhost-53288',
                    HAPPIER_SERVER_URL: 'http://127.0.0.1:53288',
                    HAPPIER_WEBAPP_URL: 'http://127.0.0.1:53288',
                });

                const [{ configuration }, { readDaemonState }] = await Promise.all([
                    import('./configuration'),
                    import('./persistence'),
                ]);

                // Write a daemon state file under a different server id to simulate stack-managed daemon ids.
                const fallbackPath = join(homeDir, 'servers', 'stack_test__id_default', 'daemon.state.json');
                mkdirSync(dirname(fallbackPath), { recursive: true });
                writeFileSync(
                    fallbackPath,
                    JSON.stringify(
                        {
                            pid: 456,
                            httpPort: 5173,
                            startedAt: Date.now(),
                            startedWithCliVersion: '0.0.0-test',
                            controlToken: 'token-456',
                        },
                        null,
                        2
                    ),
                    'utf-8'
                );

                // Sanity: active daemon state path should be different (and missing).
                expect(configuration.daemonStateFile).not.toBe(fallbackPath);

                const state = await readDaemonState();
                expect(state?.pid).toBe(456);

                rmSync(dirname(fallbackPath), { recursive: true, force: true });
                const stalePath = join(homeDir, 'servers', 'stack_test__id_stale', 'daemon.state.json');
                mkdirSync(dirname(stalePath), { recursive: true });
                writeFileSync(
                    stalePath,
                    JSON.stringify(
                        {
                            pid: 999_999,
                            httpPort: 5173,
                            startedAt: Date.now(),
                            startedWithCliVersion: '0.0.0-test',
                            controlToken: 'token-stale',
                        },
                        null,
                        2
                    ),
                    'utf-8'
                );

                const staleState = await readDaemonState();
                expect(staleState).toBeNull();
            } finally {
                killSpy.mockRestore();
            }
        });
    });

    it('does not fall back to a live daemon state file from a different configured server', async () => {
        await withTempDir('happier-cli-daemon-state-cross-server-', async (homeDir) => {
            const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
                if (signal === 0 && pid === 654) return true;
                const error = new Error('ESRCH') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }) as typeof process.kill);

            try {
                writeFileSync(
                    join(homeDir, 'settings.json'),
                    JSON.stringify(
                        {
                            schemaVersion: 6,
                            onboardingCompleted: false,
                            activeServerId: '127.0.0.1-3005',
                            servers: {
                                '127.0.0.1-3005': {
                                    id: '127.0.0.1-3005',
                                    name: 'Current',
                                    serverUrl: 'http://127.0.0.1:3005',
                                    webappUrl: 'http://127.0.0.1:3005',
                                    createdAt: 0,
                                    updatedAt: 0,
                                    lastUsedAt: 0,
                                },
                                '127.0.0.1-4325': {
                                    id: '127.0.0.1-4325',
                                    name: 'Other',
                                    serverUrl: 'http://127.0.0.1:4325',
                                    webappUrl: 'http://127.0.0.1:4325',
                                    createdAt: 0,
                                    updatedAt: 0,
                                    lastUsedAt: 0,
                                },
                            },
                        },
                        null,
                        2,
                    ),
                    'utf-8',
                );

                vi.resetModules();
                envScope.patch({
                    HAPPIER_HOME_DIR: homeDir,
                    HAPPIER_ACTIVE_SERVER_ID: '127.0.0.1-3005',
                    HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
                    HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3005',
                });

                const [{ readDaemonState }] = await Promise.all([
                    import('./persistence'),
                ]);

                const fallbackPath = join(homeDir, 'servers', '127.0.0.1-4325', 'daemon.state.json');
                mkdirSync(dirname(fallbackPath), { recursive: true });
                writeFileSync(
                    fallbackPath,
                    JSON.stringify(
                        {
                            pid: 654,
                            httpPort: 5173,
                            startedAt: Date.now(),
                            startedWithCliVersion: '0.0.0-test',
                            controlToken: 'token-654',
                        },
                        null,
                        2,
                    ),
                    'utf-8',
                );

                await expect(readDaemonState()).resolves.toBeNull();
            } finally {
                killSpy.mockRestore();
            }
        });
    });

    it('accepts legacy startTime fields and normalizes to startedAt', async () => {
        await withTempDir('happier-cli-daemon-state-legacy-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined });

            const [{ configuration }, { readDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            const legacyStarted = new Date().toISOString();
            writeFileSync(
                configuration.daemonStateFile,
                JSON.stringify(
                    {
                        pid: 123,
                        httpPort: 5173,
                        startTime: legacyStarted,
                        startedWithCliVersion: '0.0.0-test',
                    },
                    null,
                    2
                ),
                'utf-8'
            );

            const state = await readDaemonState();
            expect(state?.pid).toBe(123);
            expect(typeof state?.startedAt).toBe('number');
        });
    });
});

describe('daemon state canonicalization', () => {
    const envKeys = [
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
    ] as const;
    let envScope = createEnvKeyScope(envKeys);

    beforeEach(() => {
        envScope.patch({ HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined });
    });

    afterEach(() => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        vi.resetModules();
    });

    it('removes legacy ring-scoped daemon state files after writing the canonical owner state', async () => {
        await withTempDir('happier-cli-daemon-state-write-canonical-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });

            const [{ configuration }, { writeDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            const legacyPath = join(configuration.activeServerDir, 'daemon.dev.state.json');
            mkdirSync(dirname(legacyPath), { recursive: true });
            writeFileSync(
                legacyPath,
                JSON.stringify({
                    pid: 999,
                    httpPort: 5173,
                    startedAt: Date.now(),
                    startedWithCliVersion: '0.0.0-old',
                }),
                'utf-8',
            );

            writeDaemonState({
                pid: 123,
                httpPort: 5173,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-new',
                runtimeId: 'runtime-123',
            });

            expect(existsSync(configuration.daemonStateFile)).toBe(true);
            expect(existsSync(legacyPath)).toBe(false);
        });
    });

    it('uses a unique temp file per daemon state write to avoid cross-write corruption during restarts', async () => {
        await withTempDir('happier-cli-daemon-state-unique-tmp-', async (homeDir) => {
            const writeFileSyncSpy = vi.fn();

            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });

            vi.doMock('node:fs', async (importOriginal) => {
                const actual = await importOriginal<typeof import('node:fs')>();
                return {
                    ...actual,
                    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
                        writeFileSyncSpy(...args);
                        return actual.writeFileSync(...args);
                    },
                };
            });

            const [{ configuration }, { writeDaemonState }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            writeDaemonState({
                pid: 123,
                httpPort: 5173,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-a',
            });

            writeDaemonState({
                pid: 123,
                httpPort: 5173,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-b',
                lastHeartbeatAt: Date.now(),
            });

            const tempWrites = writeFileSyncSpy.mock.calls
                .map((call) => call[0])
                .filter((value): value is string => typeof value === 'string' && value.startsWith(`${configuration.daemonStateFile}.tmp`));

            expect(tempWrites.length).toBeGreaterThanOrEqual(2);
            expect(tempWrites[tempWrites.length - 1]).not.toBe(tempWrites[tempWrites.length - 2]);
        });
    });
});
