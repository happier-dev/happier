import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserProfileStore, deriveSessionBrowserProfileId } from './store';

// Only the filesystem boundary is simulated. No real Browser directory or
// profile contents are accessed; the store and partition lifecycle stay real.
const disk = vi.hoisted(() => new Set<string>());
vi.mock('node:fs/promises', () => ({
  lstat: async (path: string) => {
    if (!disk.has(path)) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
    return { isDirectory: () => true };
  },
  readFile: async () => { throw Object.assign(new Error('No fixture metadata'), { code: 'ENOENT' }); },
  rm: async (path: string) => { disk.delete(path); },
}));

it('77 ended Sessions retain zero ephemeral profiles after daemon recreation, preserving live and saved storage', async () => {
  const root = join('synthetic-browser-retention');
  const createStore = () => createBrowserProfileStore({ storageRootDirectory: root,
    partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
  const previous = createStore();
  // Match the reported directory count, with no browser payloads or processes.
  const endedSessions = Array.from({ length: 77 }, (_, index) => `ended-session-${index}`);
  const liveSession = 'live-session';
  for (const sessionId of [...endedSessions, liveSession]) {
    const profile = previous.register({ profileId: deriveSessionBrowserProfileId(sessionId),
      storageMode: 'ephemeral', owner: { kind: 'session', id: sessionId }, cleanupOnSessionClose: true });
    disk.add(previous.resolveProfileDirectory(profile.profileId));
  }
  const restarted = createStore();
  for (const storageMode of ['user', 'plugin'] as const) {
    const profile = restarted.register({ profileId: `saved-${storageMode}`, storageMode,
      owner: { kind: storageMode, id: 'fixture-owner' }, cleanupOnSessionClose: false });
    disk.add(restarted.resolveProfileDirectory(profile.profileId));
  }
  try {
    let purged = 0;
    for (const sessionId of endedSessions) {
      const result = await restarted.purgeForSessionDeleted({ sessionId });
      expect(result.failedProfileIds).toEqual([]);
      purged += result.purgedProfileIds.length;
    }
    expect(purged).toBe(77);
    expect(endedSessions.filter(sessionId => disk.has(restarted.resolveProfileDirectory(
      deriveSessionBrowserProfileId(sessionId))))).toHaveLength(0);
    expect(disk).toEqual(new Set([
      restarted.resolveProfileDirectory(deriveSessionBrowserProfileId(liveSession)),
      restarted.resolveProfileDirectory('saved-user'),
      restarted.resolveProfileDirectory('saved-plugin'),
    ]));
    expect(restarted.listProfiles().map(profile => profile.profileId).sort()).toEqual(['saved-plugin', 'saved-user']);
  } finally { disk.clear(); }
});
