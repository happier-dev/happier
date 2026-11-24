import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createConfiguredBrowserProfileStore } from '../browser/profiles/configuredStore';
import { deriveSessionBrowserProfileId } from '../browser/profiles/store';
import { writeSessionMarker } from '../sessionRegistry';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { legacyPidSessionTrackingKey, mintSessionTrackingKey, type SessionTrackingKey } from './sessionTrackingKey';
import type { TrackedSession } from '../types';
import { reattachTrackedSessionsFromMarkers } from './reattachFromMarkers';

// Process discovery is an OS boundary. Markers, liveness, startup reconciliation
// and Browser disk storage remain real; no stack or Browser engine is started.
vi.mock('../doctor', async importOriginal => ({
  ...await importOriginal<typeof import('../doctor')>(),
  findAllHappyProcesses: vi.fn(async () => []),
  findHappyProcessByPid: vi.fn(async () => null),
}));

it.each(['SIGTERM', 'SIGKILL'] as const)('reclaims a %s-ended runner profile at startup while retaining live and saved profiles', async signal => {
  await withConfiguredDaemonTestHome({ prefix: 'browser-unclean-stop-' }, async () => {
    const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    try {
      await once(child, 'message');
      if (!child.pid) throw new Error('Missing owned fixture PID');
      const deadSessionId = `browser-ended-${signal}`;
      const liveSessionId = 'browser-still-live';
      await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(child.pid), pid: child.pid,
        happySessionId: deadSessionId, startedBy: 'daemon' });
      // A stale runner marker can coexist with a live sibling for one Session.
      // Startup's recovered Session result, rather than the dead PID, owns retention.
      await writeSessionMarker({ trackingKey: mintSessionTrackingKey(), pid: child.pid,
        happySessionId: liveSessionId, startedBy: 'daemon' });
      const previous = createConfiguredBrowserProfileStore();
      const deadProfileId = deriveSessionBrowserProfileId(deadSessionId);
      const liveProfileId = deriveSessionBrowserProfileId(liveSessionId);
      for (const [sessionId, profileId] of [[deadSessionId, deadProfileId], [liveSessionId, liveProfileId]]) {
        previous.register({ profileId, storageMode: 'ephemeral', owner: { kind: 'session', id: sessionId }, cleanupOnSessionClose: true });
        await mkdir(previous.resolveProfileDirectory(profileId), { recursive: true });
        await writeFile(join(previous.resolveProfileDirectory(profileId), 'Cookies'), 'fixture');
      }
      for (const storageMode of ['user', 'plugin'] as const) {
        await previous.registerPersistentProfile({ profileId: `saved-${storageMode}`, storageMode,
          owner: { kind: storageMode, id: 'fixture-owner' } });
      }
      // This child deliberately has no final Session-exit purge. Both OS signals
      // leave its directory, independently of the predecessor daemon's lifetime.
      child.kill(signal);
      await exited;
      expect(await stat(previous.resolveProfileDirectory(deadProfileId))).toBeTruthy();
      // A Session that outlives its daemon is already tracked by reattachment.
      const trackingKey = legacyPidSessionTrackingKey(process.pid);
      const tracked = new Map<SessionTrackingKey, TrackedSession>([[trackingKey,
        { trackingKey, pid: process.pid, happySessionId: liveSessionId, startedBy: 'daemon' }]]);
      const result = await reattachTrackedSessionsFromMarkers({ trackedSessionsByKey: tracked });
      expect(result.orphanedDeadDaemonSessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: deadSessionId }),
        expect.objectContaining({ sessionId: liveSessionId, recoveredLiveSession: true }),
      ]));
      expect(result.recoveredLiveSessionIds).toContain(liveSessionId);
      await expect(stat(previous.resolveProfileDirectory(liveProfileId))).resolves.toBeTruthy();
      for (const mode of ['user', 'plugin']) {
        await expect(createConfiguredBrowserProfileStore().loadPersistentProfile(`saved-${mode}`)).resolves.toMatchObject({ storageMode: mode });
      }
      await expect(stat(previous.resolveProfileDirectory(deadProfileId))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});
