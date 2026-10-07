import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import type { VoiceProviderContribution } from '@happier-dev/protocol/plugins/contributions/voice';

import type { VoiceProviderPresentation, VoiceSpeechSettingsPresentation } from './voiceProviderPresentation';

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

/** Restores the existing presentation callback from published data, without importing a plugin leaf. */
export function createBundledVoiceProviderPresentations(
  presentations: readonly (Omit<VoiceProviderPresentation, 'createSettingsSpec'> & Readonly<{
    settingsSpec?: VoiceSpeechSettingsPresentation;
  }>)[],
): readonly VoiceProviderPresentation[] {
  return Object.freeze(presentations.map(({ settingsSpec, ...presentation }) => Object.freeze({
    ...presentation,
    ...(settingsSpec ? { createSettingsSpec: () => settingsSpec } : {}),
  })));
}
