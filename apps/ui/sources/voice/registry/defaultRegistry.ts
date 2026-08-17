import {
  BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
  BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS,
} from './generatedBundledVoiceEntries';
import { BUILT_IN_VOICE_UI_ENTRIES } from './builtInEntries';
import { createVoiceProviderRegistry, type VoiceProviderRegistry } from './providerRegistry';
import {
  getExternalVoiceProviderRegistrationsRevision,
  listExternalVoiceProviderRegistrations,
  subscribeExternalVoiceProviderRegistrations,
} from './externalVoiceProviderRegistrations';

export function createDefaultVoiceProviderRegistry(input: Readonly<{
  enabledPluginIds?: ReadonlySet<string> | null;
}> = {}): VoiceProviderRegistry {
  const base = createVoiceProviderRegistry({
    builtIn: BUILT_IN_VOICE_UI_ENTRIES,
    bundledContributions: BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
    bundledPresentations: BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS,
    enabledPluginIds: input.enabledPluginIds ?? null,
  });
  const enabledPluginIds = input.enabledPluginIds ?? null;
  const externalEntries = () => listExternalVoiceProviderRegistrations()
    .filter((registration) => enabledPluginIds === null || enabledPluginIds.has(registration.pluginId))
    .flatMap((registration) => registration.descriptor ? [registration.descriptor] : []);
  return Object.freeze({
    get(providerId: string) {
      const builtIn = base.get(providerId);
      if (builtIn) return builtIn;
      return externalEntries().find((entry) => entry.providerId === providerId) ?? null;
    },
    list() {
      return Object.freeze([...base.list(), ...externalEntries()].sort((left, right) => (
        left.providerId.localeCompare(right.providerId)
      )));
    },
    getRevision: getExternalVoiceProviderRegistrationsRevision,
    subscribe: subscribeExternalVoiceProviderRegistrations,
  });
}
