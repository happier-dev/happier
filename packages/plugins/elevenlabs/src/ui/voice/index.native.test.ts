import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

const nativeSessionDependencies = vi.hoisted(() => ({
  setSetupStrategy: vi.fn(),
  createConnection: vi.fn(),
  setupWebRTCSession: vi.fn(),
}));

vi.mock('@elevenlabs/client/internal', () => ({
  createConnection: nativeSessionDependencies.createConnection,
  setSetupStrategy: nativeSessionDependencies.setSetupStrategy,
  setupWebRTCSession: nativeSessionDependencies.setupWebRTCSession,
}));

import {
  activate as activateNativeEntry,
  VOICE_PROVIDER_PRESENTATIONS,
} from './index.native.js';
import {
  activate as activateWebRuntime,
  createElevenLabsVoiceProviderRuntime as createWebRuntime,
} from './runtime.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../protocol/voice/index.js';

describe('ElevenLabs native voice entry', () => {
  it.each([
    { welcome: { enabled: false, mode: 'immediate' as const, text: 'Bonjour.' }, firstMessage: '' },
    { welcome: { enabled: true, mode: 'on_first_turn' as const, text: 'Bonjour.' }, firstMessage: '' },
    { welcome: { enabled: true, mode: 'immediate' as const, text: 'Bonjour, je vous écoute — que souhaitez-vous faire ?' }, firstMessage: 'Bonjour, je vous écoute — que souhaitez-vous faire ?' },
    { welcome: { enabled: true, mode: 'immediate' as const }, firstMessage: '' },
  ])('uses only the admitted literal for the native immediate greeting policy %j', async ({ welcome, firstMessage }) => {
    const { createElevenLabsVoiceProviderRuntime } = await import('./index.native.js');
    const runtime = createElevenLabsVoiceProviderRuntime();
    const prepared = await runtime.protocol.prepare({
      controlSessionId: 'native-greeting', attemptId: 1, reason: 'initial',
      request: { initialContext: 'Authorized workspace context.' }, platform: 'ios',
      providerConfig: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      credentials: { phase: 'prepare', mediated: null, raw: null },
      providerConversation: null,
      hostedConversation: {
        start: async () => ({ allowed: true, token: 'ephemeral-token', leaseId: 'lease-native', bindingNonce: 'nonce-native', expiresAtMs: null }),
        complete: async () => {}, abort: async () => {},
      },
      attemptPolicy: { instructions: 'Reply in French using the admitted tools.', assistantLanguage: 'fr-FR', welcome },
      signal: new AbortController().signal,
    });
    expect(prepared).toMatchObject({ kind: 'prepared', session: {
      initialContextDelivery: 'prepared',
      config: {
        overrides: { agent: { firstMessage, language: 'fr', prompt: { prompt: expect.stringContaining('{{initialConversationContext}}') } } },
        dynamicVariables: { initialConversationContext: 'Authorized workspace context.' },
      },
    } });
    expect(prepared).toMatchObject({ session: { config: { overrides: { agent: {
      prompt: { prompt: expect.stringContaining('Reply in French using the admitted tools.') },
    } } } } });
    await runtime.dispose?.();
  });

  it('installs only the provider media strategy before exposing the web runtime', async () => {
    expect(nativeSessionDependencies.setSetupStrategy).toHaveBeenCalledTimes(1);

    expect(VOICE_PROVIDER_PRESENTATIONS[0]?.providerId)
      .toBe('happier.voice.elevenlabs/realtime-elevenlabs');
    expect(VOICE_PROVIDER_PRESENTATIONS[0]).not.toHaveProperty('legacySettingsMigration');
    expect(VOICE_PROVIDER_PRESENTATIONS[0]).not.toHaveProperty('declaration');

    const register = vi.fn();
    activateNativeEntry({ voiceProviders: { register } });
    expect(register).toHaveBeenCalledWith(
      PLUGIN_MANIFEST.contributes.voiceProviders[0]?.id,
      expect.any(Object),
    );

    const nativeEntry = await import('./index.native.js');
    expect(nativeEntry.activate).not.toBe(activateWebRuntime);
    expect(nativeEntry.createElevenLabsVoiceProviderRuntime).toBe(createWebRuntime);

    const source = await readFile(new URL('./index.native.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("from './index.js'");
    expect(source).not.toContain('NativeModules');
    expect(source).not.toContain('loadLiveKitRegisterGlobals');
  });

  it('does not invoke ElevenLabs WebRTC setup after native host admission rejects the connection', async () => {
    const strategy = nativeSessionDependencies.setSetupStrategy.mock.calls.at(-1)?.[0];
    if (typeof strategy !== 'function') throw new Error('native_strategy_not_registered');
    const setupCallsBeforeRejection = nativeSessionDependencies.setupWebRTCSession.mock.calls.length;
    const incompatibleBridge = Object.assign(
      new Error('Voice requires a current iOS WebRTC native module.'),
      { code: 'voice_native_webrtc_incompatible' },
    );
    nativeSessionDependencies.createConnection.mockRejectedValueOnce(incompatibleBridge);

    await expect(strategy({ connectionType: 'webrtc' })).rejects.toMatchObject({
      code: 'voice_native_webrtc_incompatible',
    });
    expect(nativeSessionDependencies.setupWebRTCSession).toHaveBeenCalledTimes(
      setupCallsBeforeRejection,
    );
  });
});
