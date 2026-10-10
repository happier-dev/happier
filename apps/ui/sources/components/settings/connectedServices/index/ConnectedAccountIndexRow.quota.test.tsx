import * as React from 'react';
import { expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from '@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { ConnectedAccountIndexLiveFacts, ConnectedAccountIndexActions } from './ConnectedAccountIndexRow';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

// Home HTTP is the boundary; the feature decision, hook, store and row remain real.
const readQuota = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/sync/api/account/apiQualifiedConnectedAccountsV4', () => ({
    getQualifiedConnectedAccountQuotaV4: readQuota,
}));

it('offers an enabled index Refresh after the first quota read has no snapshot', async () => {
    const previousState = storage.getState();
    const previousServer = getActiveServerSnapshot();
    const profile = await upsertAndActivateServer({ serverUrl: 'https://quota-index.test', name: 'Quota index' });
    const account = { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'new-account' };
    __resetQualifiedConnectedAccountQuotaSnapshotStore();
    storage.getState().applySettingsLocal({ featureToggles: { connectedServices: true, 'connectedServices.quotas': true } });
    primeServerFeaturesSnapshot({ serverId: profile.id, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
    try {
        screen = await renderScreen(<InjectedAuthProvider credentials={{ token: 'token' }}>
            <ConnectedAccountIndexLiveFacts
                identity={{ kind: 'qualified', account }} status="connected" billedPerUse={false}
                showsUsage signedOut={false}
                render={(facts) => <ConnectedAccountIndexActions testID="new-account" star={null} refresh={facts.refresh} refreshing={facts.refreshing} />}
            />
        </InjectedAuthProvider>);
        await flushHookEffects();
        expect(readQuota).toHaveBeenCalled();
        const refresh = screen.findByTestId('new-account:refresh');
        expect(refresh).not.toBeNull();
        expect(refresh?.props.disabled).toBe(false);
    } finally {
        await screen?.unmount();
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        deleteServerFeaturesSnapshot({ serverId: profile.id });
        storage.setState(previousState);
        await setActiveServer({ serverId: previousServer.serverId });
        await removeServerProfile(profile.id);
    }
});
