import type { PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';

const PREDECESSOR_VOICE_PROVIDER_CONTRIBUTIONS = Object.freeze({
  realtime_elevenlabs: Object.freeze({
    pluginId: 'happier.voice.elevenlabs',
    localId: 'realtime-elevenlabs',
  }),
  google_gemini: Object.freeze({
    pluginId: 'happier.voice.google',
    localId: 'gemini-stt',
  }),
  google_cloud: Object.freeze({
    pluginId: 'happier.voice.google',
    localId: 'google-cloud-tts',
  }),
} satisfies Readonly<Record<string, PluginContributionIdentityV1>>);

/**
 * Resolves only the provenance-pinned Voice provider ids that predate
 * contribution-qualified identity. Unknown ids and context-dependent
 * `openai_compat` speech selections deliberately have no mapping here.
 */
export function resolvePredecessorVoiceProviderContributionIdentityV1(
  providerId: string,
): PluginContributionIdentityV1 | null {
  return Object.hasOwn(PREDECESSOR_VOICE_PROVIDER_CONTRIBUTIONS, providerId)
    ? PREDECESSOR_VOICE_PROVIDER_CONTRIBUTIONS[
      providerId as keyof typeof PREDECESSOR_VOICE_PROVIDER_CONTRIBUTIONS
    ]
    : null;
}

/**
 * Converts a provenance-pinned predecessor provider id to the public
 * contribution-qualified key. Already-qualified and unknown ids are preserved.
 */
export function normalizePredecessorVoiceProviderIdV1(providerId: string): string {
  const canonical = resolvePredecessorVoiceProviderContributionIdentityV1(providerId);
  return canonical ? `${canonical.pluginId}/${canonical.localId}` : providerId;
}

/**
 * Normalizes a historical Voice identity only when both its predecessor local
 * id and owning plugin match. This prevents third-party lookalike local ids
 * from being appropriated by a bundled contribution.
 */
export function normalizePredecessorVoiceProviderContributionIdentityV1<
  TIdentity extends PluginContributionIdentityV1,
>(identity: TIdentity): PluginContributionIdentityV1 | TIdentity {
  const canonical = resolvePredecessorVoiceProviderContributionIdentityV1(
    identity.localId,
  );
  return canonical?.pluginId === identity.pluginId ? canonical : identity;
}
