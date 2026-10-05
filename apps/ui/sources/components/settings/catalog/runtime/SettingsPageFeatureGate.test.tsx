import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { Text } from 'react-native';
import type { ReactTestRenderer } from 'react-test-renderer';

import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { t, tLoose } from '@/text';

// The route is an environment boundary; catalog, store and feature admission stay real.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/settings/voice/conversations', params: () => ({}) }).module;
});

await import('../settingsPageDeclarations');
const { storage } = await import('@/sync/domains/state/storage');

function renderedText(tree: ReactTestRenderer): string {
    return tree.root.findAllByType(Text).map((node) => React.Children.toArray(node.props.children as React.ReactNode).join('')).join(' | ');
}

async function selectHome(name: string, serverUrl: string) {
    const beforeStorage = storage.getState();
    onTestFinished(() => storage.setState(beforeStorage, true));
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(null);
    onTestFinished(() => { vi.restoreAllMocks(); });
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const priorView = profiles.loadHomeViewState();
    const home = await profiles.upsertServerProfile({ name, serverUrl });
    onTestFinished(async () => {
        if (priorView) await profiles.saveHomeViewState(priorView);
        await profiles.removeServerProfile(home.id);
    });
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    onTestFinished(() => resetServerFeaturesClientForTests());
    await profiles.saveHomeViewState({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: home.id });
    storage.setState({ settings: settingsParse({ ...settingsDefaults }) });
    return home;
}

it('does not claim the service is off while the server answer is still loading', async () => {
    await selectHome('Loading gate', 'https://loading-gate.example');
    // The network is the boundary: the server's features answer has not arrived yet.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    const { SettingsPageFeatureGate } = await import('./SettingsPageFeatureGate');
    const view = await renderWithAppProviders(<SettingsPageFeatureGate pageId="voiceConversations"><Text>page body</Text></SettingsPageFeatureGate>);
    onTestFinished(() => view.unmount());
    const text = renderedText(view.tree);
    expect(text).not.toContain(tLoose('voice.readiness.server_feature_disabled'));
    expect(text).not.toContain('page body');
});

it('explains a server that has Voice off once its answer arrives', async () => {
    const home = await selectHome('Disabled gate', 'https://disabled-gate.example');
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { voice: { enabled: false } }, capabilities: {} }) } });
    const { SettingsPageFeatureGate } = await import('./SettingsPageFeatureGate');
    const view = await renderWithAppProviders(<SettingsPageFeatureGate pageId="voiceConversations"><Text>page body</Text></SettingsPageFeatureGate>);
    onTestFinished(() => view.unmount());
    const text = renderedText(view.tree);
    expect(text).toContain(tLoose('voice.readiness.server_feature_disabled'));
    expect(text).toContain(t('settings.voiceAssistant'));
    expect(text).not.toContain('page body');
});
