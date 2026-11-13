import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedActivityInventory, type LiveWorkItemV1 } from './managedActivity';

describe('daemon heartbeat allocator maintenance', () => {
  let home: string;
  let timer: NodeJS.Timeout | undefined;
  let tick: () => Promise<void>;
  const inventories: Array<ReturnType<typeof createManagedActivityInventory>> = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'happier-heartbeat-trim-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    vi.stubEnv('HAPPIER_DAEMON_HEARTBEAT_INTERVAL', '30000');
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(async () => {
    if (timer) clearInterval(timer);
    for (const inventory of inventories.splice(0)) inventory.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function start(trim: () => Promise<boolean>, items: () => readonly LiveWorkItemV1[] = () => [],
    coverage: () => 'complete' | 'unknown' = () => 'complete') {
    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    const { configuration } = await import('@/configuration');
    const activity = createManagedActivityInventory({
      producers: [{ read: () => ({ items: items(), coverage: coverage() }), subscribe: () => () => {} }],
    });
    inventories.push(activity);
    let publications = 0;
    const intervals = vi.spyOn(globalThis, 'setInterval');
    timer = startDaemonHeartbeatLoop({
      trackedSessionsByKey: new Map(),
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      controlPort: 8765,
      fileState: { pid: process.pid, httpPort: 8765, startedAt: Date.now(),
        startedWithCliVersion: configuration.currentCliVersion, daemonLogPath: join(home, 'daemon.log') },
      currentCliVersion: configuration.currentCliVersion,
      requestShutdown: () => {},
      writeDaemonStateForCurrentOwner: () => { publications++; return true; },
      allocatorMaintenance: { activity, trim },
    });
    const callback = intervals.mock.calls.at(-1)?.[0];
    if (typeof callback !== 'function') throw new Error('heartbeat timer missing');
    clearInterval(timer);
    tick = async () => { await callback(); };
    return () => publications;
  }

  async function advance(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 30_000) {
      vi.setSystemTime(Date.now() + 30_000);
      await tick();
    }
  }

  it('releases idle allocator memory on the first heartbeat and again after ten minutes', async () => {
    let releases = 0;
    await start(async () => { releases++; return true; });
    await advance(30_000);
    expect(releases).toBe(1);
    await advance(570_000);
    expect(releases).toBe(1);
    await advance(30_000);
    expect(releases).toBe(2);
  });

  it('defers maintenance while canonical work is active or unknown and resumes when it settles', async () => {
    let busy = true;
    let coverage: 'complete' | 'unknown' = 'complete';
    let releases = 0;
    await start(async () => { releases++; return true; }, () => busy
      ? [{ category: 'execution_run', ownerRef: 'run', attribution: { kind: 'unknown' }, state: 'active' }]
      : [], () => coverage);
    await advance(30_000);
    expect(releases).toBe(0);
    busy = false;
    coverage = 'unknown';
    await advance(30_000);
    expect(releases).toBe(0);
    coverage = 'complete';
    await advance(30_000);
    expect(releases).toBe(1);
  });

  it('keeps publishing heartbeats after native failure and rate-limits the next attempt', async () => {
    let attempts = 0;
    const publications = await start(async () => { attempts++; throw new Error('native boundary failed'); });
    await advance(60_000);
    expect(attempts).toBe(1);
    expect(publications()).toBeGreaterThan(0);
    await advance(570_000);
    expect(attempts).toBe(2);
  });
});
