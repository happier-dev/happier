import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { homeSettingsProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { resetHomeSettingsEngineForTests } from '@/sync/engine/home/governance/homeSettingsEngine';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    applyHomeSettingsProjection,
    getHomeSettingsSnapshot,
    resetHomeSettingsSnapshotsForTests,
    subscribeHomeSettingsSnapshots,
} from '@/sync/store/home/governance/homeSettingsSnapshots';

import { HomeSettingsLifetime, useHomeSettingsLifetime } from './homeSettingsLifetime';

afterEach(() => {
    resetHomeSettingsEngineForTests();
    resetHomeSettingsSnapshotsForTests();
});

describe('Home settings lifetime', () => {
    it('invalidates the registry without starting a read when no settings page is visible', async () => {
        const scope = { serverId: 'https://settings-idle.example', accountId: 'account-admin' };
        const settings = homeSettingsProjectionFixture({ revision: 3 });
        applyHomeSettingsProjection(scope, settings);

        function SettingsPage() {
            const retain = useHomeSettingsLifetime();
            React.useEffect(() => { retain?.(scope); }, [retain]);
            return null;
        }
        const page = (children: React.ReactNode) => <HomeSettingsLifetime serverId={scope.serverId}>{children}</HomeSettingsLifetime>;
        const screen = await renderScreen(page(<SettingsPage />));
        expect(getHomeSettingsSnapshot(scope)).toMatchObject({ loading: false, stale: false });

        let reads = 0;
        const stop = subscribeHomeSettingsSnapshots(scope, () => {
            if (getHomeSettingsSnapshot(scope)?.loading) reads += 1;
        });
        try {
            await screen.update(page(null));
            await act(async () => { publishHomeAccountChange(scope.serverId); });
            expect(reads).toBe(0);
            expect(getHomeSettingsSnapshot(scope)).toMatchObject({ settings, loading: false, stale: true });
        } finally {
            stop();
            await screen.unmount();
        }
    });
});
