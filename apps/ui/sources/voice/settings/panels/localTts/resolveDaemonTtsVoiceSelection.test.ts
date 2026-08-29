import { describe, expect, it } from 'vitest';

import type { DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol';

import { resolveDaemonTtsVoiceSelection } from './resolveDaemonTtsVoiceSelection';

function status(overrides: Partial<DaemonVoiceInferenceModelStatus> = {}): DaemonVoiceInferenceModelStatus {
  return {
    packId: 'acme.voice/tts-pack',
    pluginIdentity: { pluginId: 'acme.voice', packId: 'tts-pack' },
    kind: 'tts_sherpa',
    model: 'kokoro',
    version: '1',
    executionSupport: ['daemon'],
    runtimeFamily: 'sherpa_kokoro_offline',
    runtimeSupported: true,
    installState: 'installed',
    progress: null,
    lastError: null,
    updatedAtMs: 1,
    voices: [
      { id: 'calm', title: 'Calm', sid: 4 },
      { id: 'bright', title: 'Bright', subtitle: 'English', sid: 7 },
    ],
    defaultVoiceId: 'bright',
    ...overrides,
  };
}

describe('resolveDaemonTtsVoiceSelection', () => {
  it('uses the selected pack declared catalog and declared default when no voice is stored', () => {
    expect(resolveDaemonTtsVoiceSelection({
      packId: 'acme.voice/tts-pack',
      configuredVoiceId: null,
      statuses: [status()],
    })).toEqual({
      voices: [
        { id: 'calm', title: 'Calm', sid: 4 },
        { id: 'bright', title: 'Bright', subtitle: 'English', sid: 7 },
      ],
      selectedVoiceId: 'bright',
    });
  });

  it('fails closed when the stored voice disappeared instead of falling back to the declared default', () => {
    expect(resolveDaemonTtsVoiceSelection({
      packId: 'acme.voice/tts-pack',
      configuredVoiceId: 'retired',
      statuses: [status()],
    })).toEqual({
      voices: status().voices,
      selectedVoiceId: null,
    });
  });

  it('publishes no catalog or selection when exact selected-pack status is unavailable or malformed', () => {
    expect(resolveDaemonTtsVoiceSelection({
      packId: 'acme.voice/tts-pack',
      configuredVoiceId: null,
      statuses: [status({ packId: 'other/pack' })],
    })).toEqual({ voices: [], selectedVoiceId: null });

    expect(resolveDaemonTtsVoiceSelection({
      packId: 'acme.voice/tts-pack',
      configuredVoiceId: null,
      statuses: [status({ defaultVoiceId: 'retired' })],
    })).toEqual({ voices: status().voices, selectedVoiceId: null });
  });
});
