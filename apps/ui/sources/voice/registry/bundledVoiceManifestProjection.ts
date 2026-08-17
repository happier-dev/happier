import {
  PluginManifestV2Schema,
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';

import type { VoiceProviderPresentation } from './voiceProviderPresentation';

export type BundledVoiceManifestContribution = Readonly<{
  pluginId: string;
  providerId: string;
  declaration: VoiceProviderContribution;
}>;

export function projectBundledVoiceManifestContributions(
  manifest: unknown,
): readonly BundledVoiceManifestContribution[] {
  const parsed = PluginManifestV2Schema.parse(manifest);
  return Object.freeze(parsed.contributes.voiceProviders.map((declaration) => Object.freeze({
    pluginId: parsed.id,
    providerId: buildQualifiedPluginContributionKey(createPluginContributionIdentity({
      pluginId: parsed.id,
      localId: declaration.id,
    })),
    declaration,
  })));
}
export function indexVoiceProviderPresentations(
  presentations: readonly VoiceProviderPresentation[],
): ReadonlyMap<string, VoiceProviderPresentation> {
  const indexed = new Map<string, VoiceProviderPresentation>();
  for (const presentation of presentations) {
    if (indexed.has(presentation.providerId)) {
      throw new Error(`duplicate_voice_provider_presentation:${presentation.providerId}`);
    }
    indexed.set(presentation.providerId, Object.freeze(presentation));
  }
  return indexed;
}
