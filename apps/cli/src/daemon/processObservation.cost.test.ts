import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const observed = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: (...args: Parameters<typeof original.open>) => {
    observed.paths.push(String(args[0]));
    return original.open(...args);
  } };
});

import { inspectProcessGeneration, readProcessIdentityByPid } from './processIdentity';
import { verifySessionMarkerProcessLiveness } from './processIdentity';
import { isPidSafeHappySessionProcess } from './pidSafety';
import { hashProcessCommand } from './sessionRegistry';
import { acquireSessionRunnerLock } from './sessionRunnerLock';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isSessionRunnerActive } from './sessions/isSessionRunnerActive';
import type { TrackedSession } from './types';
import { startDaemonHeartbeatLoop } from './lifecycle/heartbeat';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';

// Exercise the real census and procfs; only observe the filesystem system boundary.
describe.skipIf(process.platform !== 'linux')('one process observation per identity verdict', () => {
  beforeEach(() => { observed.paths.length = 0; });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['generation', 'marker', 'legacy-hash'] as const)('reads a PID stat once for %s verification', async (kind) => {
    const identity = await readProcessIdentityByPid(process.pid);
    if (!identity) throw new Error('Current process birth witness unavailable');
    observed.paths.length = 0;
    if (kind === 'generation') {
      await expect(inspectProcessGeneration(identity)).resolves.toBe('verified_running');
    } else if (kind === 'marker') {
      await expect(verifySessionMarkerProcessLiveness(identity)).resolves.toMatchObject({ status: 'verified_running' });
    } else {
      await isPidSafeHappySessionProcess({ pid: identity.pid, expectedProcessCommandHash: hashProcessCommand(identity.command) });
    }
    expect(observed.paths.filter(path => path === '/proc/' + process.pid + '/stat')).toHaveLength(1);
  });
  it('reuses its process observation when checking an existing runner lock', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-pid-cost-'));
    try {
      const owner = await acquireSessionRunnerLock({ sessionId: 'audit-session', happyHomeDir: home });
      if (!owner.ok) throw new Error('Unable to acquire isolated runner lock');
      try {
        observed.paths.length = 0;
        await expect(acquireSessionRunnerLock({ sessionId: 'audit-session', happyHomeDir: home }))
          .resolves.toMatchObject({ ok: false, reason: 'already_running' });
        expect(observed.paths.filter(path => path === '/proc/' + process.pid + '/stat')).toHaveLength(1);
      } finally { await owner.release(); }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('uses one observation when checking a tracked runner for resume', async () => {
    const identity = await readProcessIdentityByPid(process.pid);
    if (!identity) throw new Error('Current process birth witness unavailable');
    observed.paths.length = 0;
    await expect(isSessionRunnerActive({ sessionId: 'audit-session', trackedSessions: [{
      trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, startedBy: 'happy-session', happySessionId: 'audit-session', processStartTimeMs: identity.processStartTimeMs,
    }] })).resolves.toBe(true);
    expect(observed.paths.filter(path => path === '/proc/' + process.pid + '/stat')).toHaveLength(1);
  });

  it('shares one census across tracked runners during a heartbeat', async () => {
    const pids = [...new Set([process.pid, process.ppid])];
    const tracked = new Map<SessionTrackingKey, TrackedSession>();
    for (const pid of pids) {
      const identity = await readProcessIdentityByPid(pid);
      if (!identity) throw new Error('Live process birth witness unavailable');
      tracked.set(legacyPidSessionTrackingKey(pid), { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'happy-session', processStartTimeMs: identity.processStartTimeMs });
    }
    let tick: (() => Promise<void>) | undefined;
    vi.spyOn(global, 'setInterval').mockImplementation((handler) => {
      if (typeof handler !== 'function') throw new Error('Expected interval callback');
      tick = async () => { await handler(); };
      return 1 as unknown as NodeJS.Timeout;
    });
    const version = (JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf8')) as { version: string }).version;
    startDaemonHeartbeatLoop({
      trackedSessionsByKey: tracked, spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null, controlPort: 8765,
      fileState: { pid: process.pid, httpPort: 8765, startedAt: Date.now(), startedWithCliVersion: version, daemonLogPath: '/tmp/audit-daemon.log' },
      currentCliVersion: version, requestShutdown: () => { throw new Error('Unexpected shutdown'); },
      requestSelfRestart: async () => { throw new Error('Unexpected restart'); },
      writeDaemonStateForCurrentOwner: () => true,
    });
    if (!tick) throw new Error('Heartbeat timer missing');
    observed.paths.length = 0;
    await tick();
    expect(tracked.size).toBe(pids.length);
    for (const pid of pids) expect(observed.paths.filter(path => path === '/proc/' + pid + '/stat')).toHaveLength(1);
  });
});
