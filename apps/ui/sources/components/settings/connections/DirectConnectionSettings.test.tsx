import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import {
    DEFAULT_PEER_MEDIATION_PREFERENCES_V1,
    PeerMediationFlowKindV1Schema} from '@happier-dev/protocol/account/settings/peerMediationPreferencesV1';
import {
    tryWriteServerEnabledBitInPlace,
} from '@happier-dev/protocol/features/serverEnabledBit';

import { createDeferred, flushHookEffects, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { AccountDirectConnectionsSection } = await import('./DirectConnectionSettings');

const DIRECT_FEATURES = [
    'machines.rpc.directPeer',
    'machines.transfer.directPeer',
    'machines.tunnel.directPeer',
    'machines.liveStream.directPeer',
] as const;

const originalState = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
let pendingFeatures: ReturnType<typeof createDeferred<Response>> | undefined;
async function arrangeAccount(enabled: boolean) {
    const features = createRootLayoutFeaturesResponse();
    for (const feature of DIRECT_FEATURES) expect(tryWriteServerEnabledBitInPlace(features, feature, enabled)).toBe(true);
    account = await createSecretSettingsTestHarness({ features, settings: settingsParse({
        peerMediationPreferencesV1: DEFAULT_PEER_MEDIATION_PREFERENCES_V1,
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
    }) });
    return features;
}

afterEach(async () => {
    pendingFeatures?.resolve(Response.json(createRootLayoutFeaturesResponse()));
    pendingFeatures = undefined;
    await standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(originalState, true);
});

describe('Account › Connections', () => {
    it('turns direct connections off for every flow when the switch is turned off', async () => {
        await arrangeAccount(true);
        const screen = await renderSettingsView(<AccountDirectConnectionsSection />);

        const toggle = screen.findByTestId('settings-account-direct-connections-switch');
        expect(toggle?.props.value).toBe(true);
        await act(async () => { toggle?.props.onValueChange(false); });

        await vi.waitFor(() => {
            for (const flow of PeerMediationFlowKindV1Schema.options) {
                expect(account!.persistedSettings.peerMediationPreferencesV1.flows[flow]?.direct).toBe('disabled');
            }
        });
        expect(screen.findByTestId('settings-account-direct-connections-switch')?.props.value).toBe(false);
    });

    it('says the server decides, and offers no switch that would do nothing, when the server allows no direct route', async () => {
        await arrangeAccount(false);
        const screen = await renderSettingsView(<AccountDirectConnectionsSection />);

        await vi.waitFor(() => expect(screen.findByTestId('settings-account-direct-connections-switch')?.props.disabled).toBe(true));
        expect(screen.getTextContent()).toContain(t('settingsConnections.serverDenied'));
        expect(account!.settingsWrites).toEqual([]);
    });

    it('does not claim the server forbids it while the server has not answered yet', async () => {
        const features = await arrangeAccount(true);
        const respond = account!.request.getMockImplementation()!;
        const heldFeatures = createDeferred<Response>();
        pendingFeatures = heldFeatures;
        // Hold only the real feature HTTP boundary. Decisions and the mounted row stay real.
        account!.request.mockImplementation((input, init) => new URL(String(input)).pathname.startsWith('/v1/features')
            ? heldFeatures.promise.then(response => response.clone()) : respond(input, init));
        resetServerFeaturesClientForTests();
        const screen = await renderSettingsView(<AccountDirectConnectionsSection />);

        expect(screen.getTextContent()).not.toContain(t('settingsConnections.serverDenied'));
        expect(screen.findByTestId('settings-account-direct-connections-switch')?.props.disabled).toBe(false);
        await act(async () => { pendingFeatures!.resolve(Response.json(features)); await flushHookEffects({ cycles: 2, turns: 2 }); });
        expect(screen.findByTestId('settings-account-direct-connections-switch')?.props.value).toBe(true);
    });
});
