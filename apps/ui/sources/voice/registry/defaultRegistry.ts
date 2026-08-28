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
import {
  getExternalVoiceProviderRegistrationsRevision,
  getExternalVoiceProviderProjectionAuthority,
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
  let cachedRevision = -1;
  let cachedEntries: readonly VoiceProviderRegistryEntry[] = Object.freeze([]);
  let cachedEntriesByProviderId = new Map<string, VoiceProviderRegistryEntry>();
  const refreshEntries = () => {
    const revision = getExternalVoiceProviderRegistrationsRevision();
    if (cachedRevision === revision) return;
    const projectionAuthority = getExternalVoiceProviderProjectionAuthority();
    const byProviderId = new Map<string, VoiceProviderRegistryEntry>();
    for (const entry of base.list()) {
      if (entry.source.kind === 'bundled' && projectionAuthority !== null) continue;
      byProviderId.set(entry.providerId, entry);
    }
    for (const registration of listExternalVoiceProviderRegistrations()) {
      if (enabledPluginIds !== null && !enabledPluginIds.has(registration.pluginId)) continue;
      if (projectionAuthority !== null) {
        const generation = projectionAuthority.get(registration.providerId);
        if (!generation || registration.projectionGeneration !== generation) continue;
      }
      // The live projection is the installed/enabled/generation authority. Its
      // exact descriptor replaces generated fallback metadata for the same ID.
      // A bundled conversation registration deliberately carries no duplicate
      // descriptor: its live registration still admits the one generated
      // descriptor for that exact ID. Without a live registration it remains
      // absent, so fallback bytes never bypass enablement or activation.
      const descriptor = registration.descriptor ?? base.get(registration.providerId);
      if (!descriptor || descriptor.pluginId !== registration.pluginId) continue;
      byProviderId.set(registration.providerId, descriptor);
    }
    cachedRevision = revision;
    cachedEntriesByProviderId = byProviderId;
    cachedEntries = Object.freeze([...byProviderId.values()].sort((left, right) => (
      left.providerId.localeCompare(right.providerId)
    )));
  };
  return Object.freeze({
    get(providerId: string) {
      const normalizedProviderId = providerId.trim();
      if (!normalizedProviderId) return null;
      refreshEntries();
      return cachedEntriesByProviderId.get(normalizedProviderId) ?? null;
    },
    list() {
      refreshEntries();
      return cachedEntries;
    },
    getRevision: getExternalVoiceProviderRegistrationsRevision,
    subscribe: subscribeExternalVoiceProviderRegistrations,
  });
}
