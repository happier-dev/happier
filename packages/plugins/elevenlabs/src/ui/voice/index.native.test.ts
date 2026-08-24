import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

const nativeSessionDependencies = vi.hoisted(() => ({
  nativeWebRtcModule: {
    audioDeviceModuleSetAutomaticAudioSessionConfiguration: vi.fn(),
    audioDeviceModuleSetEngineCreatedActive: vi.fn(),
    audioDeviceModuleSetWillEnableEngineActive: vi.fn(),
    audioDeviceModuleSetWillStartEngineActive: vi.fn(),
    audioDeviceModuleSetDidStopEngineActive: vi.fn(),
    audioDeviceModuleSetDidDisableEngineActive: vi.fn(),
    audioDeviceModuleSetWillReleaseEngineActive: vi.fn(),
  } as Record<string, unknown>,
  registerGlobals: vi.fn(),
  setSetupStrategy: vi.fn(),
  createConnection: vi.fn(),
  setupWebRTCSession: vi.fn(),
}));

vi.mock('react-native', () => ({
  get NativeModules() {
    return { WebRTCModule: nativeSessionDependencies.nativeWebRtcModule };
  },
  Platform: { OS: 'ios' },
}));

vi.mock('./runtime/liveKitReactNative.js', () => ({
  loadLiveKitRegisterGlobals: () => nativeSessionDependencies.registerGlobals,
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
  it('installs native setup before exposing the web runtime rather than retaining an inert presentation-only path', async () => {
    expect(nativeSessionDependencies.registerGlobals).toHaveBeenCalledTimes(1);
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
  });

  it('reports an incompatible iOS WebRTC bridge through activation instead of evaluating LiveKit', async () => {
    const currentNativeWebRtcModule = nativeSessionDependencies.nativeWebRtcModule;
    nativeSessionDependencies.nativeWebRtcModule = Object.freeze({});
    nativeSessionDependencies.registerGlobals.mockClear();
    nativeSessionDependencies.setSetupStrategy.mockClear();
    vi.resetModules();

    const { activate } = await import('./index.native.js');
    const register = vi.fn();
    let error: unknown;
    try {
      activate({ voiceProviders: { register } });
    } catch (caught) {
      error = caught;
    } finally {
      nativeSessionDependencies.nativeWebRtcModule = currentNativeWebRtcModule;
    }

    expect(error).toMatchObject({ code: 'elevenlabs_native_webrtc_incompatible' });
    expect(register).not.toHaveBeenCalled();
    expect(nativeSessionDependencies.registerGlobals).not.toHaveBeenCalled();
    expect(nativeSessionDependencies.setSetupStrategy).not.toHaveBeenCalled();
  });
});
