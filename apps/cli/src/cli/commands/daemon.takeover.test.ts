import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import type { DaemonRunningInspection } from '@/daemon/controlClient';

const spawnDetachedDaemonStartSyncMock = vi.fn(async () => ({ unref() {} }));
const startDaemonMock = vi.fn(async () => undefined);
const checkIfDaemonRunningMock = vi.fn(async () => true);
const inspectDaemonRunningStateMock = vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({ status: 'not-running' }));

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
    spawnDetachedDaemonStartSync: spawnDetachedDaemonStartSyncMock,
}));

vi.mock('@/daemon/startDaemon', () => ({
    startDaemon: startDaemonMock,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
    return {
        ...actual,
        checkIfDaemonRunningAndCleanupStaleState: checkIfDaemonRunningMock,
        inspectDaemonRunningStateAndCleanupStaleState: inspectDaemonRunningStateMock,
    };
});

describe('handleDaemonCliCommand takeover handling', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
    ]);

    afterEach(() => {
        envScope.restore();
        spawnDetachedDaemonStartSyncMock.mockReset();
        startDaemonMock.mockReset();
        checkIfDaemonRunningMock.mockReset();
        checkIfDaemonRunningMock.mockResolvedValue(true);
        inspectDaemonRunningStateMock.mockReset();
        inspectDaemonRunningStateMock.mockImplementation(async () => ({ status: 'not-running' }));
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('takes over a manual relay runtime when daemon start uses --takeover', async () => {
        await withTempDir('happier-daemon-start-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/persistence'),
                import('./daemon'),
            ]);

            const manualOwnedState = {
                pid: process.pid,
                httpPort: 43120,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other' as const,
                startedWithPublicReleaseChannel: 'preview' as const,
                startupSource: 'manual' as const,
            };
            writeDaemonState(manualOwnedState);
            inspectDaemonRunningStateMock.mockResolvedValue({
                status: 'running',
                state: manualOwnedState,
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);
            const output = captureConsoleText();

            try {
                await expect(handleDaemonCliCommand({
                    args: ['daemon', 'start', '--takeover'],
                    rawArgv: ['node', 'happier', 'daemon', 'start', '--takeover'],
                    terminalRuntime: null,
                })).rejects.toThrow(/exit:0/);
            } finally {
                output.restore();
                exitSpy.mockRestore();
            }

            expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledTimes(1);
            expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledWith(expect.objectContaining({
                env: expect.objectContaining({
                    HAPPIER_DAEMON_TAKEOVER: '1',
                }),
            }));
            expect(output.text()).toContain('Taking over the current manual relay runtime');
        });
    });

    it('allows a stale manual relay runtime to be replaced without explicit takeover', async () => {
        await withTempDir('happier-daemon-start-stale-manual-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/persistence'),
                import('./daemon'),
            ]);

            const manualOwnedState = {
                pid: process.pid,
                httpPort: 43124,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other' as const,
                startedWithPublicReleaseChannel: 'stable' as const,
                startupSource: 'manual' as const,
            };
            writeDaemonState(manualOwnedState);
            inspectDaemonRunningStateMock.mockResolvedValue({
                status: 'running',
                state: manualOwnedState,
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);
            const output = captureConsoleText();

            try {
                await expect(handleDaemonCliCommand({
                    args: ['daemon', 'start'],
                    rawArgv: ['node', 'happier', 'daemon', 'start'],
                    terminalRuntime: null,
                })).rejects.toThrow(/exit:0/);
            } finally {
                output.restore();
                exitSpy.mockRestore();
            }

            expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledTimes(1);
            expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledWith({});
            expect(output.text()).not.toContain('Taking over the current manual relay runtime');
        });
    });

  it('takes over a legacy manual relay runtime without startup metadata when daemon start uses --takeover', async () => {
        await withTempDir('happier-daemon-start-legacy-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { handleDaemonCliCommand }] = await Promise.all([
                import('@/persistence'),
                import('./daemon'),
            ]);

            const legacyManualState = {
                pid: process.pid,
                httpPort: 43122,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other' as const,
                startedWithPublicReleaseChannel: 'preview' as const,
            };
            writeDaemonState(legacyManualState);
            inspectDaemonRunningStateMock.mockResolvedValue({
                status: 'running',
                state: legacyManualState,
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as never);
            const output = captureConsoleText();

            try {
                await expect(handleDaemonCliCommand({
                    args: ['daemon', 'start', '--takeover'],
                    rawArgv: ['node', 'happier', 'daemon', 'start', '--takeover'],
                    terminalRuntime: null,
                })).rejects.toThrow(/exit:0/);
            } finally {
                output.restore();
                exitSpy.mockRestore();
            }

            expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledTimes(1);
            expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledWith(expect.objectContaining({
                env: expect.objectContaining({
                    HAPPIER_DAEMON_TAKEOVER: '1',
                }),
            }));
            expect(output.text()).toContain('Taking over the current manual relay runtime');
    });
  });

  it('starts an explicitly requested plugin recovery daemon with recovery mode in the detached child', async () => {
    await withTempDir('happier-daemon-start-plugin-recovery-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
      });
      spawnDetachedDaemonStartSyncMock.mockResolvedValueOnce({ unref() {} });
      vi.resetModules();
      const { handleDaemonCliCommand } = await import('./daemon');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code ?? ''}`);
      }) as never);
      const output = captureConsoleText();

      try {
        await expect(handleDaemonCliCommand({
          args: ['daemon', 'start', '--plugin-recovery'],
          rawArgv: ['node', 'happier', 'daemon', 'start', '--plugin-recovery'],
          terminalRuntime: null,
        })).rejects.toThrow(/exit:0/);
      } finally {
        output.restore();
        exitSpy.mockRestore();
      }

      expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledWith(expect.objectContaining({
        env: expect.objectContaining({
          HAPPIER_DAEMON_PLUGIN_RECOVERY: '1',
        }),
      }));
    });
  });
});
