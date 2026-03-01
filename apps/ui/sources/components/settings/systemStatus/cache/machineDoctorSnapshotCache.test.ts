import { describe, expect, it } from 'vitest';
import { MMKV } from 'react-native-mmkv';

import {
  buildMachineDoctorSnapshotCacheKey,
  clearCachedMachineDoctorSnapshot,
  readCachedMachineDoctorSnapshot,
  writeCachedMachineDoctorSnapshot,
} from './machineDoctorSnapshotCache';

const storage = new MMKV();

describe('machineDoctorSnapshotCache', () => {
  it('returns null when no cache entry exists', () => {
    expect(readCachedMachineDoctorSnapshot({ serverId: 's1', machineId: 'm1' })).toBeNull();
  });

  it('round-trips a cached doctor snapshot', () => {
    clearCachedMachineDoctorSnapshot({ serverId: 's1', machineId: 'm1' });
    writeCachedMachineDoctorSnapshot({
      serverId: 's1',
      machineId: 'm1',
      cachedAt: 123,
      snapshot: {
        capturedAt: '2026-02-23T00:00:00.000Z',
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://api.happier.dev/',
          publicServerUrl: 'https://api.happier.dev/',
          webappUrl: 'https://app.happier.dev/',
        },
        accountId: 'acct_1',
        settings: {
          activeServerId: 'cloud',
          servers: [],
          knownAccountIds: ['acct_1'],
        },
      },
    });

    const cached = readCachedMachineDoctorSnapshot({ serverId: 's1', machineId: 'm1' });
    expect(cached).not.toBeNull();
    expect(cached!.cachedAt).toBe(123);
    expect(cached!.snapshot.server.serverUrl).toBe('https://api.happier.dev');
  });

  it('deletes invalid cache entries', () => {
    const key = buildMachineDoctorSnapshotCacheKey({ serverId: 's1', machineId: 'm2' });
    storage.set(key, '{not-json');

    expect(readCachedMachineDoctorSnapshot({ serverId: 's1', machineId: 'm2' })).toBeNull();
    expect(storage.getString(key)).toBeUndefined();
  });
});
