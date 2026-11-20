import { afterEach, describe, expect, it } from 'vitest';

import { homeSettingsProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';

import {
    applyHomeSettingsProjection,
    getHomeSettingsSnapshot,
    resetHomeSettingsSnapshotsForTests,
    retireHomeSettingsSnapshot,
    subscribeHomeSettingsSnapshots,
} from './homeSettingsSnapshots';

afterEach(resetHomeSettingsSnapshotsForTests);

describe('Home settings snapshots', () => {
    it('only notifies a settings reader about its selected Home and Account', () => {
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const seen: Array<number | null> = [];
        const onChange = () => seen.push(getHomeSettingsSnapshot(scope)?.settings?.revision ?? null);
        const stop = subscribeHomeSettingsSnapshots(scope, onChange);
        try {
            applyHomeSettingsProjection({ ...scope, accountId: 'account-b' }, homeSettingsProjectionFixture({ revision: 1 }));
            applyHomeSettingsProjection({ ...scope, serverId: 'home-b' }, homeSettingsProjectionFixture({ revision: 2 }));
            applyHomeSettingsProjection(scope, homeSettingsProjectionFixture({ revision: 3 }));
            retireHomeSettingsSnapshot(scope);

            expect(seen).toEqual([3, null]);
        } finally {
            stop();
        }
    });
});
