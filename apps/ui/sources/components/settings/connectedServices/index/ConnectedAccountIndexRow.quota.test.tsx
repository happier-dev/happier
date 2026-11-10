import * as React from 'react';
import { expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { __resetConnectedServiceQuotaSnapshotStore } from '@/hooks/server/connectedServices/connectedServiceQuotaSnapshotStore';
import { createQualifiedQuotaTestHarness } from '@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ConnectedAccountIndexLiveFacts, ConnectedAccountIndexActions, ConnectedAccountIndexStatusLines } from './ConnectedAccountIndexRow';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

// Home HTTP is the boundary; the feature decision, hook, store and row remain real.
const legacyFetchedAt = vi.hoisted(() => Date.now() - 1_000);
const requestLegacyRefresh = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/api/account/apiAccountEncryptionMode')>(),
    fetchAccountEncryptionMode: async () => ({ mode: 'plain' }),
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
    getConnectedServiceQuotaSnapshotPlain: async () => ({
        metadata: { fetchedAt: legacyFetchedAt, staleAfterMs: 30 * 60_000, status: 'ok', refreshRequestedAt: legacyFetchedAt },
        snapshot: {
        v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: legacyFetchedAt,
        staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [],
        },
    }),
    requestConnectedServiceQuotaSnapshotRefreshV3: requestLegacyRefresh,
}));

it('projects the real legacy refresh state into its account row', async () => {
    const boundary = await createQualifiedQuotaTestHarness();
    const describe = boundary.control.getMockImplementation();
    if (!describe) throw new Error('Missing daemon boundary fixture');
    boundary.control.mockImplementation(async (service) => {
        const result = await describe(service);
        return result.status === 'described'
            ? { ...result, operationTransport: { kind: 'legacy', peerClass: 'revisioned_v2_v3', serviceId: 'openai-codex' } }
            : result;
    });
    storage.getState().applySettingsLocal({ featureToggles: { connectedServices: true, 'connectedServices.quotas': true } });
    const serverId = getActiveServerSnapshot().serverId;
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
    try {
        screen = await renderScreen(<InjectedAuthProvider credentials={boundary.account.credentials}>
            <ConnectedAccountIndexLiveFacts identity={{ kind: 'legacy', serviceId: 'openai-codex', profileId: 'work' }}
                status="connected" billedPerUse={false} showsUsage signedOut={false}
                render={(facts) => <>
                    <ConnectedAccountIndexActions testID="legacy" star={null} refresh={facts.refresh} refreshing={facts.refreshing} />
                    <ConnectedAccountIndexStatusLines testID="legacy" facts={facts} now={Date.now()} />
                </>}
            />
        </InjectedAuthProvider>);
        await flushHookEffects();
        await screen.pressByTestIdAsync('legacy:refresh');
        await flushHookEffects();
        expect(requestLegacyRefresh).toHaveBeenCalled();
        expect(screen.findByTestId('legacy:refresh-status')).toBeTruthy();
        expect(screen.findByTestId('legacy:refresh')?.props.disabled).toBe(true);
        expect(screen.findByTestId('legacy:as-of')).toBeTruthy();
    } finally {
        await screen?.unmount();
        __resetConnectedServiceQuotaSnapshotStore();
        deleteServerFeaturesSnapshot({ serverId });
        await boundary.dispose();
    }
});

it('shows pending usage in account rows and cards while retaining the snapshot timestamp', async () => {
    const screen = await renderScreen(<ConnectedAccountIndexStatusLines testID="account" now={2_000} facts={{
        usage: { kind: 'none' }, planLabel: null, subscription: null, recoveryCredits: null,
        fetchedAt: 1_000, staleSince: null, refreshing: true, refresh: vi.fn(),
    }} />);
    expect(screen.findByTestId('account:refresh-status')).toBeTruthy();
    expect(screen.findByTestId('account:as-of')).toBeTruthy();
});

it('leaves a settled fresh card\'s time to the page header, which already says it once', async () => {
    const screen = await renderScreen(<ConnectedAccountIndexStatusLines testID="account" now={2_000} facts={{
        usage: { kind: 'meters', meters: [] }, planLabel: null, subscription: null, recoveryCredits: null,
        fetchedAt: 1_000, staleSince: null, refreshing: false, refresh: vi.fn(),
    }} />);
    expect(screen.findByTestId('account:as-of')).toBeFalsy();
});

it('shows a failed refresh beside retained account usage instead of silently clearing pending', async () => {
    const screen = await renderScreen(<ConnectedAccountIndexStatusLines testID="account" now={2_000} facts={{
        usage: { kind: 'meters', meters: [], error: 'Refresh failed' }, planLabel: null, subscription: null, recoveryCredits: null,
        fetchedAt: 1_000, staleSince: null, refreshing: false, refresh: vi.fn(),
    }} />);
    expect(screen.findByTestId('account:refresh-error')).toBeTruthy();
    expect(screen.findByTestId('account:as-of')).toBeTruthy();
});

it('gives a failed usage refresh its Retry on the row (QA-CONFIG D3)', async () => {
    const refresh = vi.fn();
    const screen = await renderScreen(<ConnectedAccountIndexStatusLines testID="account" now={2_000} facts={{
        usage: { kind: 'meters', meters: [], error: 'Refresh failed' }, planLabel: null, subscription: null, recoveryCredits: null,
        fetchedAt: 1_000, staleSince: null, refreshing: false, refresh,
    }} />);
    await screen.pressByTestIdAsync('account:refresh-error-action');
    expect(refresh).toHaveBeenCalledTimes(1);
});
