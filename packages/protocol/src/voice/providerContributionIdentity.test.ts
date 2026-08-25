import { describe, expect, it } from 'vitest';

import {
  normalizePredecessorVoiceProviderIdV1,
  resolvePredecessorVoiceProviderContributionIdentityV1,
} from './providerContributionIdentity.js';

describe('Voice predecessor contribution identity', () => {
  it.each([
    ['realtime_elevenlabs', 'happier.voice.elevenlabs', 'realtime-elevenlabs'],
    ['google_gemini', 'happier.voice.google', 'gemini-stt'],
    ['google_cloud', 'happier.voice.google', 'google-cloud-tts'],
  ] as const)(
    'resolves predecessor id %s to its canonical qualified contribution',
    (predecessorId, pluginId, localId) => {
      expect(resolvePredecessorVoiceProviderContributionIdentityV1(predecessorId))
        .toEqual({ pluginId, localId });
      expect(normalizePredecessorVoiceProviderIdV1(predecessorId))
        .toBe(`${pluginId}/${localId}`);
    },
  );

  it.each(['realtime_openai', 'realtime_codex', 'realtime_grok'] as const)(
    'does not preserve never-released predecessor id %s',
    (providerId) => {
      expect(resolvePredecessorVoiceProviderContributionIdentityV1(providerId)).toBeNull();
      expect(normalizePredecessorVoiceProviderIdV1(providerId)).toBe(providerId);
    },
  );

  it('preserves unknown provider ids outside the released predecessor mapping', () => {
    expect(resolvePredecessorVoiceProviderContributionIdentityV1('openai_compat')).toBeNull();
    expect(resolvePredecessorVoiceProviderContributionIdentityV1('unknown')).toBeNull();
    expect(normalizePredecessorVoiceProviderIdV1('acme.voice/conversation')).toBe(
      'acme.voice/conversation',
    );
  });
});
