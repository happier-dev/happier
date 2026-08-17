import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

const nativeSessionDependencies = vi.hoisted(() => ({
  registerGlobals: vi.fn(),
  setSetupStrategy: vi.fn(),
  createConnection: vi.fn(),
  setupWebRTCSession: vi.fn(),
}));

vi.mock('@livekit/react-native', () => ({
  registerGlobals: nativeSessionDependencies.registerGlobals,
}));

vi.mock('@elevenlabs/client/internal', () => ({
  createConnection: nativeSessionDependencies.createConnection,
  setSetupStrategy: nativeSessionDependencies.setSetupStrategy,
  setupWebRTCSession: nativeSessionDependencies.setupWebRTCSession,
}));

import { VOICE_PROVIDER_PRESENTATIONS } from './index.native.js';
import {
  activate as activateWebRuntime,
  createElevenLabsVoiceProviderRuntime as createWebRuntime,
} from './runtime.js';

describe('ElevenLabs native voice entry', () => {
  it('installs native setup before exposing the web runtime rather than retaining an inert presentation-only path', async () => {
    expect(nativeSessionDependencies.registerGlobals).toHaveBeenCalledTimes(1);
    expect(nativeSessionDependencies.setSetupStrategy).toHaveBeenCalledTimes(1);

    expect(VOICE_PROVIDER_PRESENTATIONS[0]?.providerId)
      .toBe('happier.voice.elevenlabs/realtime-elevenlabs');
    expect(VOICE_PROVIDER_PRESENTATIONS[0]?.legacySettingsMigration)
      .toBeDefined();
    expect(VOICE_PROVIDER_PRESENTATIONS[0]).not.toHaveProperty('declaration');

    const nativeEntry = await import('./index.native.js');
    expect(nativeEntry.activate).toBe(activateWebRuntime);
    expect(nativeEntry.createElevenLabsVoiceProviderRuntime).toBe(createWebRuntime);

    const source = await readFile(new URL('./index.native.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("from './index.js'");
  });
});
