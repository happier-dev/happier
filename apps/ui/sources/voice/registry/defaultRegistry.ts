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
  listExternalVoiceProviderProjectionDescriptors,
  subscribeExternalVoiceProviderRegistrations,
} from './externalVoiceProviderRegistrations';

let bundledBaseRegistry: VoiceProviderRegistry | undefined;

function getBundledBaseRegistry(): VoiceProviderRegistry {
  // Generated inputs are module-owned and normalized descriptors are deeply
  // frozen. Live enablement and occurrence authority stay in each projection.
  return bundledBaseRegistry ??= createVoiceProviderRegistry({
    builtIn: BUILT_IN_VOICE_UI_ENTRIES,
    bundledContributions: BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
    bundledPresentations: BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS,
  });
}

export function createDefaultVoiceProviderRegistry(input: Readonly<{
  enabledPluginIds?: ReadonlySet<string> | null;
}> = {}): VoiceProviderRegistry {
  const base = getBundledBaseRegistry();
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
      if (entry.source.kind === 'bundled' && enabledPluginIds !== null && !enabledPluginIds.has(entry.pluginId)) continue;
      if (entry.source.kind === 'bundled' && projectionAuthority !== null) continue;
      byProviderId.set(entry.providerId, entry);
    }
    for (const descriptor of listExternalVoiceProviderProjectionDescriptors()) {
      if (enabledPluginIds !== null && !enabledPluginIds.has(descriptor.pluginId)) continue;
      const bundled = base.get(descriptor.providerId);
      byProviderId.set(descriptor.providerId, bundled?.source.kind === 'bundled'
        && bundled.pluginId === descriptor.pluginId ? bundled : descriptor);
    }
    for (const registration of listExternalVoiceProviderRegistrations()) {
      if (enabledPluginIds !== null && !enabledPluginIds.has(registration.pluginId)) continue;
      const bundled = base.get(registration.providerId);
      // The static client bridge delegates its descriptor to the generated
      // owner and has a client-host occurrence, not an installed daemon one.
      const isBundledRuntime = registration.descriptor === null
        && registration.adapter !== null
        && bundled?.source.kind === 'bundled'
        && bundled.pluginId === registration.pluginId;
      if (projectionAuthority !== null) {
        const occurrenceId = projectionAuthority.get(registration.providerId);
        if (!occurrenceId || (!isBundledRuntime && registration.occurrenceId !== occurrenceId)) continue;
      }
      // Occurrence admission above decides availability. First-party descriptor
      // and presentation ownership stays with the plugin's generated declaration,
      // even when its installed activation supplies a generic descriptor. Other
      // plugins own their installed descriptors.
      const descriptor = bundled?.source.kind === 'bundled' && bundled.pluginId === registration.pluginId
        ? bundled
        : registration.descriptor;
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
