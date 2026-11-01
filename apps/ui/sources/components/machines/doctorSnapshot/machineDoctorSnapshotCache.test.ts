import { describe, expect, it } from 'vitest';
import { MMKV } from 'react-native-mmkv';

import {
    buildMachineDoctorSnapshotCacheKey,
    readCachedMachineDoctorSnapshot,
} from './machineDoctorSnapshotCache';

const storage = new MMKV();

describe('machineDoctorSnapshotCache', () => {
    it('returns null when no cache entry exists', () => {
        expect(readCachedMachineDoctorSnapshot({ serverId: 's1', machineId: 'm1' })).toBeNull();
    });

    it('deletes invalid cache entries', () => {
        const key = buildMachineDoctorSnapshotCacheKey({ serverId: 's1', machineId: 'm2' });
        storage.set(key, '{not-json');

        expect(readCachedMachineDoctorSnapshot({ serverId: 's1', machineId: 'm2' })).toBeNull();
        expect(storage.getString(key)).toBeUndefined();
    });
});
