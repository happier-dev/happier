import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';

import { cleanupSessionResources, registerSessionSpawnResourceCleanup } from './cleanupSessionResources';
import { listSessionMarkers, readSessionMarker, removeSessionMarker, writeSessionMarker } from '../sessionRegistry';
import { createOnHappySessionWebhook } from './onHappySessionWebhook';
import { mintSessionTrackingKey, trackedSessionAfterExit, trackSession, untrackSession, type SessionTrackingKey } from './sessionTrackingKey';

// Several Sessions hosted by one process share its pid; each keeps its own
// tracking entry, marker and session-started correlation.
const HOST_PID = 649301;

async function withMarkerHome<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'happier-multi-session-host-'));
  const originalHome = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
  Object.defineProperty(configuration, 'happyHomeDir', { ...originalHome, value: dir });
  try {
    return await run(dir);
  } finally {
    Object.defineProperty(configuration, 'happyHomeDir', originalHome);
    await rm(dir, { recursive: true, force: true });
  }
}

function hostMetadata(dir: string): Metadata {
  return {
    path: dir, host: 'test-host', homeDir: '/tmp/home', happyHomeDir: configuration.happyHomeDir,
    happyLibDir: '/tmp/lib', happyToolsDir: '/tmp/tools', hostPid: HOST_PID, startedBy: 'daemon', machineId: 'machine-test',
  };
}

describe('Sessions hosted by one process', () => {
  it('keep one marker each', async () => {
    await withMarkerHome(async () => {
      const first = mintSessionTrackingKey();
      const second = mintSessionTrackingKey();
      await writeSessionMarker({ trackingKey: first, pid: HOST_PID, happySessionId: 'session-a', startedBy: 'daemon', processStartTimeMs: 1 });
      await writeSessionMarker({ trackingKey: second, pid: HOST_PID, happySessionId: 'session-b', startedBy: 'daemon', processStartTimeMs: 1 });

      expect((await listSessionMarkers()).map(marker => marker.happySessionId).sort()).toEqual(['session-a', 'session-b']);
      await removeSessionMarker(first);
      expect(await readSessionMarker(first)).toBeNull();
      expect(await readSessionMarker(second)).toMatchObject({ pid: HOST_PID, happySessionId: 'session-b' });
    });
  });

  it('correlate each session-started report to the Session whose key it carries', async () => {
    await withMarkerHome(async (dir) => {
      const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>();
      const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
      const startSession = (nonce: string) => {
        const tracked: TrackedSession = {
          trackingKey: mintSessionTrackingKey(), pid: HOST_PID, startedBy: 'daemon', happySessionId: `PID-${HOST_PID}`,
          spawnOptions: { directory: dir, backendTarget: { kind: 'backend', backendId: 'claude' }, spawnNonce: nonce },
        };
        const awaiter = vi.fn();
        trackSession(trackedSessionsByKey, tracked);
        spawnAwaiterByKey.set(tracked.trackingKey, awaiter);
        return { tracked, awaiter };
      };
      const a = startSession('launch-a');
      const b = startSession('launch-b');
      const report = createOnHappySessionWebhook({
        trackedSessionsByKey, spawnAwaiterByKey,
        // The OS identity read is the boundary; correlation and markers stay real.
        readProcessIdentityByPidFn: async (pid) => ({ pid, processStartTimeMs: 1_000, command: '/runtime/bin/happier session-host' }),
        readCredentialsFn: async () => null,
      });

      await report('session-b', hostMetadata(dir), undefined, undefined, b.tracked.trackingKey);
      await report('session-a', hostMetadata(dir), undefined, undefined, a.tracked.trackingKey);
      await a.tracked.reportMarkerCustody?.pending;
      await b.tracked.reportMarkerCustody?.pending;

      expect(trackedSessionsByKey.size).toBe(2);
      expect(a.tracked.happySessionId).toBe('session-a');
      expect(b.tracked.happySessionId).toBe('session-b');
      expect(a.awaiter).toHaveBeenCalledWith(a.tracked);
      expect(b.awaiter).toHaveBeenCalledWith(b.tracked);
      expect(await readSessionMarker(a.tracked.trackingKey)).toMatchObject({ pid: HOST_PID, happySessionId: 'session-a' });
      expect(await readSessionMarker(b.tracked.trackingKey)).toMatchObject({ pid: HOST_PID, happySessionId: 'session-b' });
    });
  });

  it('keep and clean only their own spawn resources', async () => {
    const spawnResourceCleanupByKey = new Map<SessionTrackingKey, () => void | Promise<void>>();
    const sessionAttachCleanupByKey = new Map<SessionTrackingKey, () => Promise<void>>();
    const cleaned: string[] = [];
    const sessions = ['a', 'b'].map(name => ({ name, trackingKey: mintSessionTrackingKey(), pid: HOST_PID }));
    for (const session of sessions) {
      registerSessionSpawnResourceCleanup({
        trackingKey: session.trackingKey, spawnResourceCleanupByKey, isCurrentOwner: () => true,
        cleanup: () => { cleaned.push(session.name); },
      });
    }

    expect(await cleanupSessionResources({ trackingKey: sessions[0]!.trackingKey, spawnResourceCleanupByKey, sessionAttachCleanupByKey })).toBe(true);

    expect(cleaned).toEqual(['a']);
    expect([...spawnResourceCleanupByKey.keys()]).toEqual([sessions[1]!.trackingKey]);
  });
  it('give a Session-addressed end only its own successor, never another unready Session of the host', () => {
    const map = new Map<SessionTrackingKey, TrackedSession>();
    const session = (happySessionId?: string): TrackedSession => ({ trackingKey: mintSessionTrackingKey(), pid: HOST_PID, startedBy: 'daemon',
      ...(happySessionId === undefined ? {} : { happySessionId }) });
    // Two unready Sessions of one host: same placeholder id, and one with no id yet.
    const exited = session(`PID-${HOST_PID}`);
    const unreadySibling = session(`PID-${HOST_PID}`);
    const noIdSibling = session();
    for (const tracked of [exited, unreadySibling, noIdSibling]) trackSession(map, tracked);
    untrackSession(map, exited);
    expect(trackedSessionAfterExit(map, HOST_PID, exited, true)).toBeNull();
    const exitedWithoutId = session();
    trackSession(map, exitedWithoutId);
    untrackSession(map, exitedWithoutId);
    expect(trackedSessionAfterExit(map, HOST_PID, exitedWithoutId, true)).toBeNull();

    // A known Session's own successor (same id, new tracking) keeps its custody; a ready sibling does not.
    const ready = session('session-a');
    const readySibling = session('session-b');
    trackSession(map, ready);
    trackSession(map, readySibling);
    untrackSession(map, ready);
    expect(trackedSessionAfterExit(map, HOST_PID, ready, true)).toBeNull();
    const successor = { ...session('session-a') };
    trackSession(map, successor);
    expect(trackedSessionAfterExit(map, HOST_PID, ready, true)).toBe(successor);
    // Still current in the process: nothing ended.
    expect(trackedSessionAfterExit(map, HOST_PID, readySibling, true)).toBe(readySibling);
  });
});
