import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from './terminal/terminalRouteTestHelpers';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';

installTerminalRouteCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: '/', segments: ['(app)'],
    }).module,
});
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
await initializeTerminalRouteRuntimeForTests();
const RootLayout = (await import('@/app/(app)/_layout')).default;

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let pendingFeatures: ReturnType<typeof createDeferred<Response>> | undefined;
beforeEach(() => { resetServerFeaturesClientForTests(); });
afterEach(async () => {
    pendingFeatures?.resolve(new Response('{}', { status: 503 }));
    pendingFeatures = undefined;
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
    resetServerFeaturesClientForTests();
});

async function arrangeVoiceHome(supported: boolean) {
    const state = { supported, defer: false, pendingObserved: false };
    pendingFeatures = createDeferred<Response>();
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://voice-gate.example.test', accountId: 'voice-viewer',
        request: async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' && state.defer) {
                state.pendingObserved = true;
                return pendingFeatures!.promise;
            }
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                features: {
                    pets: { companion: { enabled: true } },
                    voice: { enabled: state.supported, happierVoice: { enabled: state.supported } },
                },
            }));
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            return new Response('{}', { status: 404 });
        },
    });
    storage.setState({
        settings: {
            ...settingsDefaults, petsEnabled: true,
            voice: {
                ...settingsDefaults.voice,
                providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                providers: {
                    ...settingsDefaults.voice.providers,
                    'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 2, config: { billingMode: 'happier' } },
                },
            },
        },
        localSettings: { ...localSettingsDefaults, activityBadgesEnabled: false },
    });
    const configuredVoice = storage.getState().settings.voice;
    const render = () => renderScreen(<InjectedAuthProvider credentials={connection!.credentials}><RootLayout /></InjectedAuthProvider>);
    return { state, configuredVoice, render, home: connection.home };
}

describe('RootLayout voice gating', () => {
    it('mounts the enabled in-window pet companion for an ordinary web client', async () => {
        const { render, home } = await arrangeVoiceHome(false);
        expect((await getServerFeaturesSnapshot({ serverId: home.id, force: true })).status).toBe('ready');
        const screen = await render();
        await vi.waitFor(() => expect(screen.findByTestId('pet-app-shell-companion-root')).not.toBeNull());
    });

    it('keeps a configured hosted voice selection inert when the Home reports voice unsupported', async () => {
        const { configuredVoice, render, home } = await arrangeVoiceHome(false);
        const observed = await getServerFeaturesSnapshot({ serverId: home.id, force: true });
        expect(observed).toMatchObject({ status: 'ready', features: { features: { voice: { happierVoice: { enabled: false } } } } });
        await render();
        expect(storage.getState().settings.voice).toBe(configuredVoice);
    });

    it('does not permanently disable hosted Voice while the real feature observation is pending', async () => {
        const { configuredVoice, render, state } = await arrangeVoiceHome(true);
        state.defer = true;
        resetServerFeaturesClientForTests();
        await render();
        await vi.waitFor(() => expect(state.pendingObserved).toBe(true));
        expect(storage.getState().settings.voice).toBe(configuredVoice);
    });

    it('retains the configured selection when the exact Home feature observation changes after mount', async () => {
        const { configuredVoice, render, state, home } = await arrangeVoiceHome(true);
        expect(await getServerFeaturesSnapshot({ serverId: home.id, force: true })).toMatchObject({
            status: 'ready', features: { features: { voice: { happierVoice: { enabled: true } } } },
        });
        await render();
        state.supported = false;
        expect(await getServerFeaturesSnapshot({ serverId: home.id, force: true })).toMatchObject({
            status: 'ready', features: { features: { voice: { happierVoice: { enabled: false } } } },
        });
        expect(storage.getState().settings.voice).toBe(configuredVoice);
    });
});
