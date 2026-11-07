import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
  'HAPPIER_DAEMON_HEARTBEAT_INTERVAL',
]);

afterEach(() => {
  envScope.restore();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('heartbeat during daemon lock handover', () => {
  it.each(['lock-release', 'replacement-startup'] as const)(
    'preserves the incumbent during %s and resumes publication after a failed replacement',
    async (phase) => {
      await withTempDir('happier-heartbeat-handover-', async (homeDir) => {
        envScope.patch({
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_ACTIVE_SERVER_ID: undefined,
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined,
          HAPPIER_DAEMON_HEARTBEAT_INTERVAL: '1000',
        });
        vi.resetModules();
        const { configuration } = await import('@/configuration');
        const persistence = await import('@/persistence');
        const { startDaemonHeartbeatLoop } = await import('./heartbeat');
        const { requestDaemonSelfRestartWithLockHandoff } = await import('./requestDaemonSelfRestartWithLockHandoff');
        let lock = await persistence.acquireDaemonLock();
        expect(lock).not.toBeNull();
        const state = {
          pid: process.pid, httpPort: 8765, startedAt: Date.now(),
          startedWithCliVersion: configuration.currentCliVersion,
          selfRestartCorrelationId: 'incumbent-restart-correlation',
        };
        expect(persistence.writeDaemonStateIfLockOwned(state)).toBe(true);
        const shutdowns: string[] = [];
        const requestShutdown = (_source: string, message?: string) => { shutdowns.push(message ?? 'shutdown'); };
        const timer = setInterval(() => {}, 2 ** 30);
        let tick: (() => Promise<void>) | undefined;
        vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => Promise<void>) => {
          tick = handler;
          return timer;
        }) as typeof setInterval);
        const interval = startDaemonHeartbeatLoop({
          pidToTrackedSession: new Map(), spawnResourceCleanupByPid: new Map(),
          sessionAttachCleanupByPid: new Map(), getApiMachineForSessions: () => null,
          controlPort: state.httpPort, fileState: state,
          currentCliVersion: configuration.currentCliVersion, requestShutdown,
          isShuttingDown: () => lock === null,
        });
        try {
          const heartbeat = tick;
          if (!heartbeat) throw new Error('Heartbeat did not register its timer');
          const observeHandover = async () => {
            await heartbeat();
            expect(shutdowns).toEqual([]);
            expect((await persistence.readDaemonState())?.lastHeartbeatAt).toBeUndefined();
          };
          const result = await requestDaemonSelfRestartWithLockHandoff({
            getCurrentDaemonLockHandle: () => lock,
            setCurrentDaemonLockHandle: (next) => { lock = next; },
            releaseDaemonLock: async (handle) => {
              await persistence.releaseDaemonLock(handle);
              if (phase === 'lock-release') await observeHandover();
            },
            acquireDaemonLock: () => persistence.acquireDaemonLock(), requestShutdown,
            selfRestartParams: {
              ownPid: process.pid, expectedCliVersion: configuration.currentCliVersion,
              timeoutMs: 1, pollMs: 1,
              // The OS launch boundary is held without starting a second real daemon.
              spawnDetachedDaemonStartSyncImpl: async () => {
                if (phase === 'replacement-startup') await observeHandover();
                return {};
              },
            },
          });
          expect(result.status).toBe('replacement_not_confirmed');
          expect(lock).not.toBeNull();
          expect(shutdowns).toEqual([]);
          await heartbeat();
          const resumed = await persistence.readDaemonState();
          expect(resumed?.lastHeartbeatAt).toEqual(expect.any(Number));
          expect(resumed?.selfRestartCorrelationId).toBe(state.selfRestartCorrelationId);
        } finally {
          clearInterval(interval);
          if (lock) await persistence.releaseDaemonLock(lock);
        }
      });
    },
  );
});
