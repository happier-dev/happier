import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createPlainMachineRowFixture, createRootLayoutFeaturesResponse, createSessionFixture, renderHook, renderScreen as renderTestScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { storage } from '@/sync/domains/state/storage';
import { readLocalConversationVoiceSettings, voiceSettingsParse, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { ModalProvider } from '@/modal';
import { setPreferredLanguageFromSettings, t, tLoose } from '@/text';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { VoiceProviderCatalogResponseSchema } from '@happier-dev/protocol/voice/providerOperations';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { useBundledConversationProviderSettings } from '@/voice/settings/panels/realtime/useBundledConversationProviderSettings';
import { useRealtimeVoiceCatalog } from '@/voice/settings/panels/realtime/realtimeVoiceCatalogMenu';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';

// The browser locale and native presentation SDKs are external boundaries;
// translation, modal lifecycle, storage and provider/catalog owners stay real.
vi.hoisted(() => {
  vi.stubGlobal('navigator', { ...globalThis.navigator, language: 'en-US', languages: ['en-US'] });
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Install the genuine transport boundary before eager Account harness imports.
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const catalogRequests: Array<Readonly<{ method: string; params: unknown }>> = [];
installDisconnectedServerSocketBoundary(socket => {
  socket.connect = vi.fn<typeof socket.connect>(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    const request = payload as Readonly<{ method: string; params: unknown }>;
    if (request.method !== `catalog-machine:${RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG}`) {
      return { ok: false, error: 'RPC_METHOD_NOT_AVAILABLE' };
    }
    catalogRequests.push(request);
    return { ok: true, result: VoiceProviderCatalogResponseSchema.parse({ ok: true,
      items: [{ id: 'en-US-Neural2-C', name: 'Neural C' }] }) };
  });
});
async function renderScreen(element: React.ReactElement) {
  return await renderTestScreen(<ModalProvider>{element}</ModalProvider>);
}
const initialState = storage.getState();
beforeEach(() => { setPreferredLanguageFromSettings('en'); catalogRequests.length = 0; });
afterEach(() => { standardCleanup(); resetServerFeaturesClientForTests(); storage.setState(initialState, true); });
afterAll(() => { setPreferredLanguageFromSettings(null); vi.unstubAllGlobals(); });
const { SessionVoiceSection } = await import('./SessionVoiceSection');

describe('Work voice source display', () => {
  it('names the OpenAI default from its declaration before the catalog picker opens', async () => {
    const voice = voiceSettingsParse({ providerId: 'happier.voice.openai/realtime-openai' });
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({
      experiments: true, featureToggles: { voice: true }, voiceSettingsV1: voice,
    }));
    try {
      await updateEffectiveHomeViewState(() => ({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: account.scope.serverId }), { scope: 'device' });
      expect(await getServerFeaturesSnapshot({ serverId: account.scope.serverId, force: true })).toMatchObject({ status: 'ready' });
      const screen = await renderScreen(<SessionVoiceSection session={createSessionFixture({ serverId: account.scope.serverId })} serverId={account.scope.serverId} />);
      await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)).toHaveLength(1));
      const picker = screen.findByType(DropdownMenu);
      expect(picker.props.open).toBe(false);
      expect(picker.props.itemTrigger.detailFormatter()).toBe(`${t('sessionVoice.followAccount')} ·\u00A0Marin`);
    } finally { await account.dispose(); }
  });

  it('uses the retained provider catalog name in the closed field before this picker opens', async () => {
    const providerId = 'happier.voice.google/google-cloud-tts';
    const entry = createDefaultVoiceProviderRegistry().get(providerId);
    if (!entry?.providerSettings) throw new Error('Google settings declaration missing');
    const base = voiceSettingsParse({ providerId: 'local_conversation', providers: {
      [providerId]: { schemaVersion: entry.providerSettings.schemaVersion,
        config: { ...entry.providerSettings.defaultConfig, voiceName: 'en-US-Neural2-C' } },
    } });
    const config = readLocalConversationVoiceSettings(base);
    const voice = voiceSettingsParse({
      ...writeLocalConversationVoiceSettings(base, { ...config, tts: { ...config.tts, provider: providerId } }),
      executionMachine: { mode: 'fixed', machineId: 'catalog-machine', autoMachineId: null },
    });
    const features = createRootLayoutFeaturesResponse();
    features.features.machines.liveStream.serverRouted.enabled = true;
    features.capabilities.machines.liveStream.serverRouted = { caps: {}, disabledReason: null };
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({
      experiments: true, featureToggles: { voice: true }, voiceSettingsV1: voice,
    }), { features });
    try {
      const machineRow = createPlainMachineRowFixture({ id: 'catalog-machine', accountId: account.scope.accountId });
      storage.getState().applyMachines([createMachineFixture({ id: 'catalog-machine',
        activeAt: Date.now(), access: machineRow.access })]);
      const homeRequest = account.request.getMockImplementation();
      if (!homeRequest) throw new Error('Home HTTP boundary missing');
      account.request.mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(
          JSON.parse(String(init.body)), id => id === machineRow.id ? machineRow : null);
        if (path === '/v1/machines/catalog-machine') return Response.json({ machine: machineRow });
        return await homeRequest(input, init);
      });
      await updateEffectiveHomeViewState(() => ({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: account.scope.serverId }), { scope: 'device' });
      expect(await getServerFeaturesSnapshot({ serverId: account.scope.serverId, force: true })).toMatchObject({ status: 'ready' });
      const settings = await renderHook(() => useBundledConversationProviderSettings(voice));
      const choice = settings.getCurrent().sessionChoice;
      if (!choice) throw new Error('Session voice choice missing');
      // Actual catalog client crosses the daemon RPC transport, then the shared owner retains its row.
      const previousPicker = await renderHook(() => useRealtimeVoiceCatalog({
        providerId: choice.providerId, catalogAvailable: choice.catalogAvailable, credentialUsable: true, targetKey: choice.targetKey,
      }));
      await act(async () => previousPicker.getCurrent().requestCatalog());
      await vi.waitFor(() => expect(previousPicker.getCurrent().catalog.phase).toBe('ready'));
      await previousPicker.unmount();
      const screen = await renderScreen(<SessionVoiceSection session={createSessionFixture({ serverId: account.scope.serverId })} serverId={account.scope.serverId} />);
      await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)).toHaveLength(1));
      const picker = screen.findByType(DropdownMenu);
      expect(picker.props.open).toBe(false);
      expect(picker.props.itemTrigger.detailFormatter()).toBe(`${t('sessionVoice.followAccount')} ·\u00A0Neural C`);
      expect(catalogRequests).toEqual([expect.objectContaining({ params: {
        target: { pluginId: 'happier.voice.google', localId: 'google-cloud-tts' }, catalog: 'voices',
      } })]);
    } finally { await account.dispose(); }
  });

  it('says the voice as the one row\'s description, never as a row title, and names the search for the provider\'s voices', async () => {
    const voice = voiceSettingsParse({ providerId: 'happier.voice.openai/realtime-openai' });
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({
      experiments: true, featureToggles: { voice: true }, voiceSettingsV1: voice,
    }));
    try {
      await updateEffectiveHomeViewState(() => ({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: account.scope.serverId }), { scope: 'device' });
      expect(await getServerFeaturesSnapshot({ serverId: account.scope.serverId, force: true })).toMatchObject({ status: 'ready' });
      const screen = await renderScreen(<SessionVoiceSection session={createSessionFixture({ serverId: account.scope.serverId })} serverId={account.scope.serverId} />);
      await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)).toHaveLength(1));
      const picker = screen.findByType(DropdownMenu);
      // One row: the line is the row's description beside the field, with no title band above it.
      expect(picker.props.itemTrigger.title).toBe('');
      expect(picker.props.itemTrigger.subtitle).toBe(t('sessionVoice.idleVoice', { voice: 'Marin' }));
      expect(screen.getTextContent()).toContain(t('sessionVoice.idleVoice', { voice: 'Marin' }));
      expect(typeof picker.props.searchPlaceholder).toBe('string');
      expect(picker.props.searchPlaceholder).not.toBe('');
      expect(picker.props.items[0].id).toBe('__follow__');
    } finally { await account.dispose(); }
  });

  it.each([
    { voiceId: 'en-US-Neural2-A', displayName: undefined, expectedName: 'en-US-Neural2-A' },
    { voiceId: 'en-US-Neural2-D', displayName: 'Neural D', expectedName: 'Neural D' },
  ])('names the closed Google speech choice without requiring its catalog ($expectedName)', async ({ voiceId, displayName, expectedName }) => {
    const providerId = 'happier.voice.google/google-cloud-tts';
    const entry = createDefaultVoiceProviderRegistry().get(providerId);
    if (!entry?.providerSettings) throw new Error('Google settings declaration missing');
    const base = voiceSettingsParse({ providerId: 'local_conversation', providers: {
      [providerId]: { schemaVersion: entry.providerSettings.schemaVersion,
        config: { ...entry.providerSettings.defaultConfig, voiceName: voiceId } },
    } });
    const config = readLocalConversationVoiceSettings(base);
    const voice = writeLocalConversationVoiceSettings(base, { ...config, tts: { ...config.tts, provider: providerId } });
    resetServerFeaturesClientForTests();
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({
      experiments: true, featureToggles: { voice: true }, voiceSettingsV1: voice,
    }));
    try {
      await updateEffectiveHomeViewState(() => ({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: account.scope.serverId }), { scope: 'device' });
      expect(await getServerFeaturesSnapshot({ serverId: account.scope.serverId, force: true })).toMatchObject({ status: 'ready' });
      const session = createSessionFixture({ serverId: account.scope.serverId });
      if (displayName) {
        session.metadata = { ...session.metadata!, work: { voicePreference: {
          providerContributionId: providerId, settingFieldPath: 'voiceName', value: voiceId, displayName,
        } } };
      }
      const screen = await renderScreen(<SessionVoiceSection session={session} serverId={account.scope.serverId} />);
      await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)).toHaveLength(1));
      const picker = screen.findByType(DropdownMenu);
      const provider = tLoose('settingsVoice.local.googleCloudTts.provider.title');
      expect(picker.props.itemTrigger.detailFormatter()).toBe(displayName
        ? `${expectedName} ·\u00A0${provider}` : `${t('sessionVoice.followAccount')} ·\u00A0${expectedName}`);
      expect(picker.props.items.find((item: { id: string }) => item.id === '__follow__').subtitle)
        .toBe(t('sessionVoice.accountVoice', { voice: expectedName, provider }));
    } finally { await account.dispose(); }
  });
});
