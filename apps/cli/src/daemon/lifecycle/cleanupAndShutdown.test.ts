import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
]);

describe('cleanupAndShutdown', () => {
    afterEach(() => {
        envScope.restore();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('drains background server work after stopping refresh loops and before teardown', async () => {
        await withTempDir('happier-cleanup-shutdown-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });
            vi.resetModules();

            const { cleanupAndShutdown } = await import('./cleanupAndShutdown');
            const calls: string[] = [];
            const beforeShutdown = vi.fn(async () => {
                calls.push('beforeShutdown');
            });
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
                calls.push(`exit:${code ?? ''}`);
                return undefined as never;
            }) as typeof process.exit);

            const params: Parameters<typeof cleanupAndShutdown>[0] & {
                beforeShutdown: () => Promise<void>;
            } = {
                source: 'happier-cli',
                processEnv: {},
                resolvePositiveIntEnv: (_raw, fallback) => fallback,
                restartOnStaleVersionAndHeartbeat: null,
                connectedServiceRefreshLoopHandle: {
                    stop: () => {
                        calls.push('refreshLoopStop');
                    },
                },
                connectedServiceQuotasLoopHandle: {
                    stop: () => {
                        calls.push('quotaLoopStop');
                    },
                    pause: () => {},
                    resume: () => {},
                },
                apiMachine: null,
                machineConnectionStateCleanup: null,
                automationWorker: null,
                memoryWorker: null,
                voiceInferenceWorker: null,
                trackedSessionCount: 0,
                stopDirectPeerServer: async () => {
                    calls.push('directPeerStop');
                },
                stopTailscaleTransferServeLifecycle: async () => {
                    calls.push('tailscaleStop');
                },
                stopManagedServersOnShutdown: async () => {
                    calls.push('managedServersStop');
                },
                stopSshTunnelsOnShutdown: async () => {
                    calls.push('sshTunnelsStop');
                },
                stopControlServer: async () => {
                    calls.push('controlServerStop');
                },
                stopCaffeinate: async () => {
                    calls.push('caffeinateStop');
                },
                daemonLockHandle: null,
                releaseDaemonLock: async () => {
                    calls.push('daemonLockRelease');
                },
                beforeShutdown,
            };

            await cleanupAndShutdown(params);

            expect(beforeShutdown).toHaveBeenCalledTimes(1);
            expect(calls).toEqual([
                'refreshLoopStop',
                'quotaLoopStop',
                'beforeShutdown',
                'directPeerStop',
                'tailscaleStop',
                'managedServersStop',
                'sshTunnelsStop',
                'controlServerStop',
                'caffeinateStop',
                'exit:0',
            ]);
            exitSpy.mockRestore();
        });
    });
});
