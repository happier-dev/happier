import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen as renderTestScreen, standardCleanup } from '@/dev/testkit';
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
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

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

describe('Work voice › a choice that met a newer Session', () => {
  it.each(['apply', 'keep'] as const)('holds the choice as a quiet conflict naming the current voice, then %s resolves it through the real Action executor', async decision => {
    const providerId = 'happier.voice.google/google-cloud-tts';
    const entry = createDefaultVoiceProviderRegistry().get(providerId);
    if (!entry?.providerSettings) throw new Error('Google settings declaration missing');
    const base = voiceSettingsParse({ providerId: 'local_conversation', providers: {
      [providerId]: { schemaVersion: entry.providerSettings.schemaVersion,
        config: { ...entry.providerSettings.defaultConfig, voiceName: 'en-US-Neural2-A' } },
    } });
    const config = readLocalConversationVoiceSettings(base);
    const voice = writeLocalConversationVoiceSettings(base, { ...config, tts: { ...config.tts, provider: providerId } });
    resetServerFeaturesClientForTests();
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({
      experiments: true, featureToggles: { voice: true }, voiceSettingsV1: voice,
    }), { mode: 'plain' });
    try {
      const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
      const sessionRequest = createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init));
      const request = account.request.getMockImplementation();
      if (!request) throw new Error('Voice Account HTTP boundary missing');
      account.request.mockImplementation(async (input, init) => await sessionRequest(input, init) ?? request(input, init));
      await updateEffectiveHomeViewState(() => ({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: account.scope.serverId }), { scope: 'device' });
      expect(await getServerFeaturesSnapshot({ serverId: account.scope.serverId, force: true })).toMatchObject({ status: 'ready' });
      const sessionAt = (metadataVersion: number) => {
        const session = createSessionFixture({ serverId: account.scope.serverId, metadataVersion });
        session.metadata = { ...session.metadata!, work: { voicePreference: {
          providerContributionId: providerId, settingFieldPath: 'voiceName', value: 'en-US-Neural2-D', displayName: 'Neural D',
        } } };
        return session;
      };
      const current = sessionAt(5);
      storage.setState({ sessions: { ...storage.getState().sessions, [current.id]: current } });
      const stale = { ...current, metadataVersion: 4 };
      const element = (session: typeof stale) => <SessionVoiceSection session={session} serverId={account.scope.serverId} />;
      const screen = await renderScreen(element(stale));
      await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)).toHaveLength(1));
      await act(async () => { screen.findByType(DropdownMenu).props.onSelect('__follow__'); });
      await vi.waitFor(() => expect(screen.findByTestId('session-work-voice.conflict')).toBeTruthy());
      expect(sessionHttp.writes).toEqual([]);
      // A stale basis is a change to review, not a refusal, and the picker still shows the current choice.
      expect(screen.getTextContent()).not.toContain(t('sessionVoice.refused'));
      expect(screen.getTextContent()).toContain(t('sessionIntentConflict.changedNow', { subject: t('sessionVoice.title'), current: 'Neural D' }));
      expect(screen.findByType(DropdownMenu).props.itemTrigger.detailFormatter()).toBe(`Neural D ·\u00A0${tLoose('settingsVoice.local.googleCloudTts.provider.title')}`);
      await screen.update(<ModalProvider>{element(current)}</ModalProvider>);
      await screen.pressByTestIdAsync(`session-work-voice.conflict.${decision}`);
      await vi.waitFor(() => expect(screen.findByTestId('session-work-voice.conflict')).toBeNull());
      if (decision === 'apply') {
        await vi.waitFor(() => expect(sessionHttp.writes).toEqual([current.id]));
        expect(readSessionOwnerMetadataView(storage.getState().sessions[current.id]!)?.work ?? {}).not.toHaveProperty('voicePreference');
      } else {
        expect(sessionHttp.writes).toEqual([]);
        expect(readSessionOwnerMetadataView(storage.getState().sessions[current.id]!)?.work).toMatchObject({ voicePreference: {
          providerContributionId: providerId, value: 'en-US-Neural2-D', displayName: 'Neural D',
        } });
      }
      await screen.unmount();
    } finally { await account.dispose(); }
  });
});
