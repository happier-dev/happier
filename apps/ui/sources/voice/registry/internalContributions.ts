import {
  BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
  BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS,
} from './generatedBundledVoiceEntries';
import {
  createVoiceProviderRegistry,
  type VoiceProviderRegistryEntry,
} from './providerRegistry';

const bundledVoiceProviderRegistry = createVoiceProviderRegistry({
  bundledContributions: BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
  bundledPresentations: BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS,
});

/**
 * Internal build-time executable contribution lookup. This is deliberately not
 * part of the public plugin SDK or manifest projection. A physically absent or
 * reservation-only first-party package yields null and all consumers fail closed.
 */
export function getBundledVoiceProviderEntry(providerId: string): VoiceProviderRegistryEntry | null {
  const entry = bundledVoiceProviderRegistry.get(providerId);
  return entry?.source.kind === 'bundled' ? entry : null;
}
