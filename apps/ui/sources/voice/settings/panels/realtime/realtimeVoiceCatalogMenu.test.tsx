import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createElevenLabsSettingsRuntimeTestHarness, createVoiceSettingsAccountTestHarness } from '../voiceSettingsAccountTestHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { saveAndUseAccountVoiceCredential } from '@/voice/credentials/accountVoiceCredential';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import 'fake-indexeddb/auto';
// The actual settings HTTP operation needs no vendor conversation SDK start.
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: () => { throw new Error('Unexpected ElevenLabs conversation start'); } } }));

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
const audio = vi.hoisted(() => ({ play: vi.fn(), remove: vi.fn() }));
// OS playback is the boundary; catalog declarations and Action admission remain real.
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: async () => {} },
  createAudioPlayer: () => ({ play: audio.play, remove: audio.remove,
    addListener: () => ({ remove: () => {} }) }) }));
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useRealtimeVoiceCatalog, useRealtimeCatalogMenuItems, useRealtimeCatalogPreview } = await import('./realtimeVoiceCatalogMenu');
const { createBundledConversationUi } = await import('@/voice/credentials/bundledConversationClient');
const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
const { readDeclaredVoiceSettingsCatalog } = await import('./voiceCatalog');
const { getPreferredLanguage, preloadTranslationsForSettings, setPreferredLanguageFromSettings, t, tLoose } = await import('@/text');
const initialLanguage = getPreferredLanguage();
const initialStorage = storage.getState();

let runtime: ReturnType<typeof createElevenLabsSettingsRuntimeTestHarness>;
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
beforeEach(async () => {
  await preloadTranslationsForSettings('en');
  setPreferredLanguageFromSettings('en');
  account = await createVoiceSettingsAccountTestHarness(settingsParse({
    voice: { providerId: 'happier.voice.elevenlabs/realtime-elevenlabs' },
  }));
  runtime = createElevenLabsSettingsRuntimeTestHarness();
  const settingsVersion = storage.getState().settingsVersion;
  if (settingsVersion === null) throw new Error('Expected hydrated Account Settings version');
  account.replaceSettings(saveAndUseAccountVoiceCredential({
    settings: account.settings,
    contribution: { pluginId: runtime.entry.pluginId, localId: runtime.entry.declaration.id },
    credentialSlotId: 'api_key', currentDeclaration: runtime.entry.declaration,
    expectedSettingsVersion: settingsVersion,
    value: 'test-only-catalog-key', generateId: () => 'catalog-secret', now: 1,
    expectedSecretId: null, expectedSecretUpdatedAt: null,
  }).settings);
  await refreshSavedSecretCatalog(account.scope);
  await runtime.register();
  const ui = createBundledConversationUi(runtime.registration.providerId);
  if (!ui?.client) throw new Error('Shipped provider catalog client missing');
});
afterEach(async () => { standardCleanup(); await runtime.dispose(); await account.dispose(); storage.setState(initialStorage, true); });
afterAll(() => { setPreferredLanguageFromSettings(initialLanguage); });

describe('the shared realtime voice catalog', () => {
  it('publishes no equal provider catalog rows to passive readers and retains unaffected voices', async () => {
    const params = { providerId: runtime.entry.providerId, catalogAvailable: true, credentialUsable: true,
      targetKey: 'equal-provider-catalog-voice-perf-1106' };
    const voices = [{ voice_id: 'sage', name: 'Sage' }, { voice_id: 'maple', name: 'Maple' }];
    runtime.fetch.mockImplementation(async () => runtime.response({ voices }));
    const active = await renderHook(() => useRealtimeVoiceCatalog(params));
    const publications = vi.fn();
    const passive = await renderHook(() => {
      const catalog = useRealtimeVoiceCatalog(params);
      React.useEffect(() => { publications(); }, [catalog.lastKnownRows]);
      return catalog;
    });
    const refresh = async () => {
      await act(async () => active.getCurrent().requestCatalog());
      await waitForTestEvent(active.subscribe, active.getCurrent, value => value.catalog.phase === 'ready');
    };
    await refresh();
    const initial = passive.getCurrent().lastKnownRows;
    expect(initial).toHaveLength(2);
    publications.mockClear();
    for (let read = 0; read < 5; read += 1) await refresh();
    expect(publications).toHaveBeenCalledTimes(0);
    expect(passive.getCurrent().lastKnownRows).toBe(initial);
    voices[0]!.name = 'Updated Sage';
    await refresh();
    expect(publications).toHaveBeenCalledTimes(1);
    expect(passive.getCurrent().lastKnownRows?.find(row => row.id === 'sage')).toMatchObject({ name: 'Updated Sage' });
    expect(passive.getCurrent().lastKnownRows?.find(row => row.id === 'maple')).toBe(initial?.find(row => row.id === 'maple'));
  });

  it('admits explicit catalog open and retry through Settings Actions before contacting the provider', async () => {
    const picker = await renderHook(() => useRealtimeVoiceCatalog({ providerId: runtime.entry.providerId, catalogAvailable: true, credentialUsable: true,
      targetKey: 'admitted-catalog-open' }));
    account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: { v: 1,
      actions: { 'settings.invoke': { enabled: false } } } }));
    await act(async () => picker.getCurrent().requestCatalog());
    await waitForTestEvent(picker.subscribe, picker.getCurrent, value => value.catalog.phase !== 'loading');
    expect(picker.getCurrent().catalog.phase).not.toBe('loading');
    expect(runtime.fetch).not.toHaveBeenCalled();
    expect(picker.getCurrent().catalog.phase).toBe('error');
    account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: { v: 1,
      actions: { 'settings.invoke': { enabled: true } }, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } } }));
    await act(async () => picker.getCurrent().requestCatalog());
    await waitForTestEvent(picker.subscribe, picker.getCurrent, value => value.catalog.phase !== 'loading');
    expect(picker.getCurrent().catalog.phase).toBe('ready');
    expect(picker.getCurrent().lastKnownRows?.[0]?.name).toBe('Happier voice');
  });
  it('honors Settings Action admission for picker Preview and Stop while cleanup always releases playback', async () => {
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    const providerId = runtime.entry.providerId;
    const row = { id: 'voice-catalog-preview', name: 'Sage', previewUrl: 'https://preview.example.test/sage.mp3' };
    runtime.fetch.mockImplementation(async () => runtime.response({ voices: [
      { voice_id: row.id, name: row.name, preview_url: row.previewUrl },
    ] }));
    audio.play.mockClear(); audio.remove.mockClear();
    const playbackStarted = createDeferred<void>();
    audio.play.mockImplementationOnce(() => playbackStarted.resolve());
    const picker = await renderHook(() => useRealtimeCatalogPreview(providerId));
    account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: { v: 1,
      actions: { 'settings.invoke': { enabled: false } } } }));
    await act(async () => picker.getCurrent().playPreview(row));
    expect(audio.play).not.toHaveBeenCalled();
    account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: { v: 1,
      actions: { 'settings.invoke': { enabled: true } }, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } } }));
    await act(async () => picker.getCurrent().playPreview(row));
    await playbackStarted.promise;
    expect(audio.play).toHaveBeenCalledOnce();
    expect(picker.getCurrent().previewingId).toBe(row.id);
    account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: { v: 1,
      actions: { 'settings.invoke': { enabled: false } } } }));
    await act(async () => picker.getCurrent().stopPreview());
    expect(audio.remove).not.toHaveBeenCalled();
    await picker.unmount();
    expect(audio.remove).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
  it('says one sentence and offers one Retry when the catalog cannot load, instead of a bare text row', async () => {
    const onRetry = vi.fn();
    const items = await renderHook(() => useRealtimeCatalogMenuItems({
      catalog: { phase: 'error' }, credentialUsable: true, credentialUnavailableDetail: '', previewingId: null,
      onPreview: () => {}, onRetry,
    }));
    const [failed, ...rest] = items.getCurrent().statusRows;
    expect(rest).toEqual([]);
    expect(failed).toMatchObject({ id: '__retry__', title: tLoose('settingsVoice.realtimeProviders.catalog.loadFailed') });
    const retry = failed!.rightElement as React.ReactElement<{ title: string; onPress: (event?: { stopPropagation?: () => void }) => void }>;
    expect(retry.props.title).toBe(t('common.retry'));
    const stopPropagation = vi.fn();
    retry.props.onPress({ stopPropagation });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('leads a voice row with its preview control and keeps the right edge for the in-use mark', async () => {
    const rows = [{ id: 'af_maple', name: 'Maple', subtitle: 'American English · female' }, { id: 'af_sol', name: 'Sol' }];
    const render = (inUseId: string | null) => renderHook(() => useRealtimeCatalogMenuItems({
      catalog: { phase: 'ready', rows }, credentialUsable: true, credentialUnavailableDetail: '', previewingId: null,
      onPreview: () => {}, canPreview: true, inUseId,
    }));
    const idle = (await render(null)).getCurrent().catalogRows;
    // Every voice has the same leading control: no empty leading column, nothing competing on the right.
    expect(idle.map((row) => row.icon != null)).toEqual([true, true]);
    expect(idle.map((row) => row.rightElement)).toEqual([undefined, undefined]);
    expect(idle[0]).toMatchObject({ title: 'Maple', subtitle: 'American English · female' });
    const inUse = (await render('af_sol')).getCurrent().catalogRows;
    expect(inUse[1]!.rightElement).toBeDefined();
    expect(inUse[0]!.rightElement).toBeUndefined();
    expect(inUse[1]!.icon).toBeDefined();
  });

  it('uses a provider-declared static catalog without contacting the catalog transport', async () => {
    const entry = createDefaultVoiceProviderRegistry().list().find(candidate => 'declaration' in candidate && candidate.declaration?.id === 'realtime-openai');
    if (!entry || !('declaration' in entry) || !entry.declaration) throw new Error('OpenAI Voice declaration missing');
    const rows = readDeclaredVoiceSettingsCatalog(entry.declaration);
    if (!rows?.length) throw new Error('Provider-declared voice options missing');
    runtime.fetch.mockRejectedValue(new Error('static catalog must not request transport'));
    account.replaceSettings(settingsParse({ ...account.settings, voice: { ...account.settings.voice, providerId: entry.providerId } }));
    const params = { providerId: entry.providerId, catalogAvailable: true, credentialUsable: true, targetKey: 'declared-static-catalog', declaredRows: rows };
    const picker = await renderHook(() => useRealtimeVoiceCatalog(params));
    expect(picker.getCurrent().catalog).toEqual({ phase: 'ready', rows });
    await act(async () => picker.getCurrent().requestCatalog());
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it('retains names for a closed picker across remounts without fetching, scoped to its target', async () => {
    runtime.fetch.mockImplementation(async () => runtime.response({ voices: [{ voice_id: 'voice-catalog-1', name: 'Sage' }] }));
    const params = { providerId: runtime.entry.providerId, catalogAvailable: true, credentialUsable: true, targetKey: 'retained-catalog-target' };
    const picker = await renderHook(() => useRealtimeVoiceCatalog(params));
    expect(runtime.fetch).not.toHaveBeenCalled();
    await act(async () => picker.getCurrent().requestCatalog());
    await waitForTestEvent(picker.subscribe, picker.getCurrent, value => value.catalog.phase === 'ready');
    expect(picker.getCurrent().catalog.phase).toBe('ready');
    await picker.unmount();

    const closed = await renderHook((targetKey: string) => useRealtimeVoiceCatalog({ ...params, targetKey }), {
      initialProps: params.targetKey,
    });
    expect(closed.getCurrent().lastKnownRows).toEqual([{ id: 'voice-catalog-1', name: 'Sage', previewAvailable: false }]);
    const voiceRequests = () => runtime.fetch.mock.calls.filter(([request, init]) =>
      init?.method === 'GET' && new URL(request instanceof Request ? request.url : String(request)).pathname === '/v1/voices');
    expect(voiceRequests()).toHaveLength(1);
    await closed.rerender('different-credential-target');
    expect(closed.getCurrent().lastKnownRows).toBeNull();
    expect(voiceRequests()).toHaveLength(1);
  });

  it('updates a closed reader through the same owner and keeps the known name after a failed refresh', async () => {
    runtime.fetch.mockImplementation(async () => runtime.response({ voices: [{ voice_id: 'voice-catalog-2', name: 'Marin' }] }));
    const params = { providerId: runtime.entry.providerId, catalogAvailable: true, credentialUsable: true, targetKey: 'shared-catalog-target' };
    const closed = await renderHook(() => useRealtimeVoiceCatalog(params));
    const picker = await renderHook(() => useRealtimeVoiceCatalog(params));
    await act(async () => picker.getCurrent().requestCatalog());
    await waitForTestEvent(closed.subscribe, closed.getCurrent, value => value.lastKnownRows?.[0]?.name === 'Marin');
    expect(closed.getCurrent().lastKnownRows?.[0]?.name).toBe('Marin');
    runtime.fetch.mockRejectedValueOnce(new Error('catalog transport unavailable'));
    await act(async () => picker.getCurrent().requestCatalog());
    await waitForTestEvent(picker.subscribe, picker.getCurrent, value => value.catalog.phase === 'error');
    expect(picker.getCurrent().catalog.phase).toBe('error');
    expect(closed.getCurrent().lastKnownRows?.[0]?.name).toBe('Marin');
    expect(picker.getCurrent().lastKnownRows?.[0]?.name).toBe('Marin');
    await act(async () => picker.getCurrent().resetCatalog());
    expect(closed.getCurrent().lastKnownRows).toBeNull();
  });
});
