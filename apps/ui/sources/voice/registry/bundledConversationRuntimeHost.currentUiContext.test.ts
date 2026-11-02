import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import * as React from 'react';
import { SessionLookupByTagsRequestV2Schema, SessionLookupByTagsResponseV2Schema } from '@happier-dev/protocol';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, usePublishCurrentUiContext, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { setFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { getVoiceAdapterRegistry, registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionRuntimeStateForTests } from '@/voice/session/voiceSessionStore';
import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { getVoiceSessionLifecycleController, setVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { createBuiltinVoiceAdapterAssembly } from '@/dev/testkit/harness/builtinVoiceAdapters';
import { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@/voice/persistence/voiceTranscriptHistorySession';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from './generatedBundledVoiceRuntimeEntries';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
const sdk = vi.hoisted(() => ({ startSession: vi.fn(), endSession: vi.fn(), sendContextualUpdate: vi.fn() }));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: sdk.startSession } }));
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: sdk.startSession } }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: vi.fn(async () => undefined) } }));
const route = vi.hoisted(() => ({ segments: ['(app)', 'session', '[id]'], pathname: '/session/ui-context-target' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
  segments: () => route.segments, pathname: () => route.pathname, params: { id: 'ui-context-target' },
}).module);
await loadSyncSingletonForTests();

describe('bundled conversation runtime host current UI lifecycle', () => {
  it('delivers privacy-filtered current UI only after real provider connection and retires delivery with the exact voice attempt', async () => {
    const previousState = storage.getState();
    const previousAdapters = getVoiceAdapterRegistry().list();
    const previousLifecycle = getVoiceSessionLifecycleController();
    const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.pluginId === 'happier.voice.elevenlabs');
    if (!entry) throw new Error('Missing first-party ElevenLabs contribution');
    sdk.sendContextualUpdate.mockReset();
    const contextEvents = new EventTarget();
    const subscribeContext = (notify: () => void) => {
      contextEvents.addEventListener('send', notify);
      return () => contextEvents.removeEventListener('send', notify);
    };
    sdk.sendContextualUpdate.mockImplementation(() => { contextEvents.dispatchEvent(new Event('send')); });
    sdk.endSession.mockReset().mockResolvedValue(undefined);
    const conversation = { endSession: sdk.endSession, setMicMuted() {}, setVolume() {}, sendUserMessage() {}, sendContextualUpdate: sdk.sendContextualUpdate, getId: () => 'ui-context-conversation' };
    let connect: (() => void) | undefined;
    const sdkEntered = createDeferred<void>();
    sdk.startSession.mockReset().mockImplementation(() => new Promise<typeof conversation>(resolve => { connect = () => resolve(conversation); sdkEntered.resolve(); }));
    const history = createSessionFixture({ id: 'ui-voice-history', active: false, metadata: { path: '/voice', host: 'test', ...buildVoiceTranscriptHistorySessionMetadata() } });
    const target = createSessionFixture({ id: 'ui-context-target', metadata: { path: '/private', host: 'test', name: 'private session title' } });
    const sessionHttp = createSessionMetadataHttpBoundary(() => ({ [history.id]: history, [target.id]: target }));
    const readSession = createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init));
    // Seed the existing server-owned history with its canonical current tuple
    // before Sync lists it; a legacy projection cannot answer current create/load.
    const { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } = await import('@happier-dev/protocol');
    const historyOwner = createSessionOwnerMetadataV1({ metadata: history.metadata });
    if (!historyOwner.ok) throw new Error('History owner metadata could not be authored');
    sessionHttp.createSessionFromPost(history.id, {
      method: 'POST',
      body: JSON.stringify({
        tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG, metadataLayoutVersion: 1,
        sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata: history.metadata, agentState: null })) },
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(historyOwner.ownerMetadata),
        agentState: null, dataEncryptionKey: null, encryptionMode: 'plain',
      }),
    });
    const homes = await serveAccountHomes({
      homes: [{ key: 'voice', serverUrl: 'https://voice-ui-context.example.test', accountId: 'account-a', settings: previousState.settings }],
      route: async request => {
        const { path, url } = request;
        const init: RequestInit = { method: request.method, headers: request.headers, signal: request.signal,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) };
        if (path === '/v1/account/profile') {
          const { profileDefaults } = await import('@/sync/domains/profiles/profile');
          return request.accountId ? Response.json({ ...profileDefaults, id: request.accountId })
            : Response.json({}, { status: 401 });
        }
        const preparation = answerVoiceRealtimePreparationHttpRequest(url, storage.getState().settings);
        if (preparation) return preparation;
        if (path === '/health') return Response.json({ status: 'ok' });
        if (path === '/v1/voice/token') return Response.json({ allowed: true, token: 'hosted-token', leaseId: 'ui-lease', bindingNonce: 'ui-nonce', expiresAtMs: Date.now() + 60_000 });
        if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ ok: true });
        if (path === '/v2/sessions/lookup-by-tags') {
          const lookup = SessionLookupByTagsRequestV2Schema.parse(request.body);
          expect(lookup.tags).toEqual([VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG]);
          const detail = sessionHttp.handle(`https://voice-ui-context.example.test/v2/sessions/${history.id}`);
          if (!detail) throw new Error('Missing persisted history detail');
          return Response.json(SessionLookupByTagsResponseV2Schema.parse({ sessions: [(await detail.json()).session] }));
        }
        if (path === '/v1/sessions' && init?.method === 'POST') return sessionHttp.createSessionFromPost(history.id, init);
        const sessionResponse = await readSession(url, init);
        if (sessionResponse) return sessionResponse;
        return new Response('{}', { status: 404 });
      },
    });
    const disconnect = await homes.restoreActiveConnection();
    const home = homes.homes.voice!;
    const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl);
    if (!credentials) throw new Error('Actual Voice Home credentials unavailable');
    // Mount after the real core bootstrap; Account hydration must not retire
    // preferences/publication seeded for this exact Voice attempt.
    await waitForTestEvent(storage.subscribe, () => {
      expect(storage.getState().profileScope?.serverId).toBe(home.id);
      expect(storage.getState().isDataReady).toBe(true);
    });
    const voice = writeVoiceProviderSettingsConfig(previousState.settings.voice, entry.providerId, ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS);
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
      voice: { ...voice, providerId: entry.providerId, privacy: { ...voice.privacy, currentUiContextMode: 'automatic', shareSessionSummary: true } },
    }, storage.getState().settings));
    storage.setState({ sessions: {
      ...previousState.sessions, [history.id]: { ...history, serverId: home.id }, [target.id]: { ...target, serverId: home.id },
    } });
    setFocusedSessionId(target.id, home.id);
    let reader: CurrentUiContextReader | null = null;
    const enrichment = { commands: [] };
    function Publication() {
      reader = useOptionalCurrentUiContextReader();
      usePublishCurrentUiContext(enrichment);
      return null;
    }
    const tree = () => React.createElement(InjectedAuthProvider, { credentials, children:
      React.createElement(MainAppTabStateProvider, { children: React.createElement(AppPaneProvider, { children:
        React.createElement(CurrentUiContextProvider, { children: React.createElement(PluginSurfaceFocusEligibilityProvider,
          { active: true, currentUiContextActive: true, children: React.createElement(Publication) }) }) }) }) });
    const screen = await renderScreen(tree());
    if (!reader) throw new Error('Missing mounted current UI reader');
    const currentReader: CurrentUiContextReader = reader;
    // The mounted producer has private UI data; automatic provider delivery
    // must remove it rather than pass by receiving an already-empty fixture.
    expect(currentReader.readCurrentUiContext()).toMatchObject({ navigation: { title: 'private session title' } });
    const actualPort = createCurrentUiContextVoiceToolPort({ reader: currentReader, readProjection: () => null, readNavigationBinding: () => null });
    // Observe custody without replacing the mounted producer's subscription logic.
    const removals: Array<ReturnType<typeof vi.fn<() => void>>> = [];
    const subscribe = vi.fn((listener: () => void) => {
      const remove = vi.fn(actualPort.subscribe(listener));
      removals.push(remove);
      return remove;
    });
    const currentUiContext = { ...actualPort, subscribe };
    const assembly = (await createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry], currentUiContext }));
    registerVoiceAdapters(assembly.adapters);
    voiceSessionBindingStore.getState().bind({ adapterId: entry.providerId, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: 'ui-voice-history', conversationSessionAddress: { serverId: home.id, sessionId: 'ui-voice-history' }, targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1 });
    const lifecycle = createVoiceSessionLifecycleController();
    setVoiceSessionLifecycleController(lifecycle);
    lifecycle.setConfiguredProviderId(entry.providerId);
    try {
      expect(lifecycle.getConfiguredProviderId()).toBe(entry.providerId);
      const starting = lifecycle.toggle(null);
      await sdkEntered.promise;
      expect(connect).toBeTypeOf('function');
      expect(subscribe).not.toHaveBeenCalled();
      expect(sdk.sendContextualUpdate).not.toHaveBeenCalled();
      connect?.();
      await starting;
      expect(lifecycle.getSnapshot().status).toBe('connected');
      expect(lifecycle.getSnapshot().adapterId).toBe(entry.providerId);
      const received = () => sdk.sendContextualUpdate.mock.calls.map(([value]) => value);
      await waitForTestEvent(subscribeContext, () => expect(received().at(-1)).toBe('CURRENT UI CONTEXT\n\n{"navigation":{"area":"session","screen":"session/:id","presentation":"screen"}}'));
      expect(received().join('\n')).not.toContain('private session title');
      route.segments = ['(app)', 'settings', 'voice'];
      route.pathname = '/settings/voice';
      const firstListener = subscribe.mock.calls[0]?.[0];
      if (!firstListener) throw new Error('Missing current UI subscription');
      await screen.update(tree());
      await waitForTestEvent(subscribeContext, () => {
        const update = received().at(-1);
        expect(update?.startsWith('CURRENT UI CONTEXT\n\n')).toBe(true);
        if (!update?.startsWith('CURRENT UI CONTEXT\n\n')) throw new Error('Missing settings context delivery');
        expect(JSON.parse(update.slice('CURRENT UI CONTEXT\n\n'.length))).toEqual({
          navigation: { area: 'settings', screen: 'settings/voice', presentation: 'screen', title: expect.any(String) },
        });
      });
      expect(received().join('\n')).not.toContain('private session title');
      const delivered = received().length;
      firstListener();
      expect(received()).toHaveLength(delivered);
      await screen.unmount();
      expect(currentReader.readCurrentUiContext()).toBeNull();
      await waitForTestEvent(subscribeContext, () => expect(received().at(-1)).toBe('CURRENT UI CONTEXT\n\n{"navigation":{"state":"unavailable"}}'));
      await lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
      expect(removals[0]).toHaveBeenCalledTimes(1);
      const deliveredAfterStop = received();
      firstListener();
      expect(received()).toEqual(deliveredAfterStop);
      sdk.startSession.mockResolvedValue(conversation);
      await lifecycle.toggle(null);
      const secondListener = subscribe.mock.calls[1]?.[0];
      if (!secondListener) throw new Error('Missing replacement current UI subscription');
      const deliveredBeforeRevoke = received();
      await assembly.dispose();
      secondListener();
      expect(received()).toEqual(deliveredBeforeRevoke);
      expect(removals[1]).toHaveBeenCalledTimes(1);
    } finally {
      await lifecycle.dispose();
      await screen.unmount();
      setFocusedSessionId(null);
      setVoiceSessionLifecycleController(previousLifecycle);
      await assembly.dispose();
      await resetVoiceSessionRuntimeStateForTests();
      registerVoiceAdapters(previousAdapters);
      await disconnect();
      await homes.dispose();
      storage.setState(previousState, true);
      vi.restoreAllMocks();
    }
  });
});
