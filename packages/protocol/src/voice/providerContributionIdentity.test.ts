import { describe, expect, it } from 'vitest';

import {
  normalizePredecessorVoiceProviderIdV1,
  normalizePredecessorVoiceProviderContributionIdentityV1,
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
      expect(normalizePredecessorVoiceProviderContributionIdentityV1({
        pluginId,
        localId: predecessorId,
      })).toEqual({ pluginId, localId });
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

  it('preserves canonical and unknown identities and does not appropriate lookalike plugins', () => {
    const canonical = { pluginId: 'happier.voice.openai', localId: 'realtime-openai' };
    const unknown = { pluginId: 'acme.voice', localId: 'unknown-conversation' };
    const lookalike = { pluginId: 'acme.voice', localId: 'realtime_openai' };

    expect(normalizePredecessorVoiceProviderContributionIdentityV1(canonical)).toBe(canonical);
    expect(normalizePredecessorVoiceProviderContributionIdentityV1(unknown)).toBe(unknown);
    expect(normalizePredecessorVoiceProviderContributionIdentityV1(lookalike)).toBe(lookalike);
    expect(resolvePredecessorVoiceProviderContributionIdentityV1('openai_compat')).toBeNull();
    expect(resolvePredecessorVoiceProviderContributionIdentityV1('unknown')).toBeNull();
    expect(normalizePredecessorVoiceProviderIdV1('acme.voice/conversation')).toBe(
      'acme.voice/conversation',
    );
  });
});
