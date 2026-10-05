import { expect, it, onTestFinished, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { projectBundledVoiceManifestContributions } from '@/voice/registry/bundledVoiceManifestProjection';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { t } from '@/text';

// The route is an environment boundary; catalog, store, registry and feature admission stay real.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/settings/voice/conversations', params: () => ({}) }).module;
});

// Initialize declarations before the real store's app-context import graph.
await import('../settingsPageDeclarations');
const { storage } = await import('@/sync/domains/state/storage');

it('refreshes the root language search label when the same selected service envelope becomes unavailable', async () => {
    const beforeStorage = storage.getState();
    onTestFinished(() => storage.setState(beforeStorage, true));
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    // No persisted credential is needed to exercise an already observed feature response.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(null);
    onTestFinished(() => { vi.restoreAllMocks(); });
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const priorView = profiles.loadHomeViewState();
    const home = await profiles.upsertServerProfile({ name: 'Language catalog', serverUrl: 'https://language-catalog.example' });
    onTestFinished(async () => {
        if (priorView) await profiles.saveHomeViewState(priorView);
        await profiles.removeServerProfile(home.id);
    });
    const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { voice: { enabled: true } }, capabilities: {} }) } });
    onTestFinished(() => resetServerFeaturesClientForTests());
    await profiles.saveHomeViewState({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: home.id });
    const { PLUGIN_MANIFEST } = await import('../../../../../../../packages/plugins/elevenlabs/src/manifest');
    const { VOICE_PROVIDER_PRESENTATIONS } = await import('../../../../../../../packages/plugins/elevenlabs/src/ui/voice/entries');
    const registry = createVoiceProviderRegistry({ bundledContributions: projectBundledVoiceManifestContributions(PLUGIN_MANIFEST), bundledPresentations: VOICE_PROVIDER_PRESENTATIONS });
    const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
    const entry = registry.get(providerId);
    if (!entry) throw new Error('Missing current language contribution');
    const token = {};
    commitExternalVoiceProviderRegistration({ token, pluginId: entry.pluginId, localId: 'realtime-elevenlabs', providerId, descriptor: entry, adapter: null });
    onTestFinished(() => removeExternalVoiceProviderRegistration(token));
    const { voice: _derivedVoice, ...accountDefaults } = settingsDefaults;
    const initial = settingsParse({ ...accountDefaults, experiments: true, featureToggles: { ...settingsDefaults.featureToggles, voice: true }, voiceSettingsV1: { ...settingsDefaults.voice, providerId, assistantLanguage: 'fr' } });
    storage.setState({ settings: initial });
    const { useResolvedSettingsPageCatalog } = await import('./useResolvedSettingsPageCatalog');
    const hook = await renderHook(() => useResolvedSettingsPageCatalog());
    onTestFinished(() => hook.unmount());
    const root = (query: string) => hook.getCurrent().search(query).find((item) => item.setting?.anchor === 'voiceConversations.assistantLanguage');
    expect(root(t('settingsVoice.pages.conversations.iSpeakTitle'))?.setting?.title).toBe(t('settingsVoice.pages.conversations.iSpeakTitle'));
    await act(async () => storage.setState({ settings: { ...initial, voice: { ...initial.voice, providers: {
        ...initial.voice.providers, [providerId]: { schemaVersion: 99, config: { retained: true } },
    } } } }));
    expect(root(t('settingsVoice.pages.conversations.replyInTitle'))?.setting?.title).toBe(t('settingsVoice.pages.conversations.replyInTitle'));
});
