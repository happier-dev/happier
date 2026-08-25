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

describe('ElevenLabs native voice entry', () => {
  it('installs only the provider media strategy before exposing the web runtime', async () => {
    expect(nativeSessionDependencies.setSetupStrategy).toHaveBeenCalledTimes(1);

    expect(VOICE_PROVIDER_PRESENTATIONS[0]?.providerId)
      .toBe('happier.voice.elevenlabs/realtime-elevenlabs');
    expect(VOICE_PROVIDER_PRESENTATIONS[0]?.legacySettingsMigration)
      .toBeDefined();
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
