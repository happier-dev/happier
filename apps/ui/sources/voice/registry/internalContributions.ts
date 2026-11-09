import {
  BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
  BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS,
} from './generatedBundledVoiceEntries';
import { BUILT_IN_VOICE_UI_ENTRIES } from './builtInEntries';
import {
  createVoiceProviderRegistry,
  type VoiceProviderRegistry,
  type VoiceProviderRegistryEntry,
} from './providerRegistry';

let bundledBaseRegistry: VoiceProviderRegistry | undefined;

/**
 * The one normalization of the generated bundled declarations. Generated inputs are module-owned and
 * normalized descriptors are deeply frozen, so every registry projection and internal lookup shares it.
 */
export function getBundledBaseVoiceProviderRegistry(): VoiceProviderRegistry {
  return bundledBaseRegistry ??= createVoiceProviderRegistry({
    builtIn: BUILT_IN_VOICE_UI_ENTRIES,
    bundledContributions: BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
    bundledPresentations: BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS,
  });
}

/**
 * Internal build-time executable contribution lookup. This is deliberately not
 * part of the public plugin SDK or manifest projection. A physically absent or
 * reservation-only first-party package yields null and all consumers fail closed.
 */
export function getBundledVoiceProviderEntry(providerId: string): VoiceProviderRegistryEntry | null {
  const entry = getBundledBaseVoiceProviderRegistry().get(providerId);
  return entry?.source.kind === 'bundled' ? entry : null;
}
