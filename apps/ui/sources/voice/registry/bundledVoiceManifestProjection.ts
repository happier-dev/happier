import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import type { VoiceProviderContribution, VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import type { z } from 'zod/mini';

import type { VoiceProviderPresentation, VoiceSpeechSettingsPresentation } from './voiceProviderPresentation';

export type BundledVoiceManifestContribution = Readonly<{
  pluginId: string;
  providerId: string;
  declaration: VoiceProviderContribution;
}>;

/** The generator admits the manifest; runtime consumers need only this projection. */
export type BundledVoiceManifestProjection = Readonly<{
  id: string;
  contributes: Readonly<{ voiceProviders: readonly VoiceProviderContribution[] }>;
}>;

/** Serialized declarations lose the nominal types established by generator admission. */
export type BundledVoiceManifestProjectionInput = Readonly<{
  id: string;
  contributes: Readonly<{ voiceProviders: readonly z.input<typeof VoiceProviderContributionSchema>[] }>;
}>;

export function projectBundledVoiceManifestContributions(
  manifest: BundledVoiceManifestProjection,
): readonly BundledVoiceManifestContribution[] {
  return Object.freeze(manifest.contributes.voiceProviders.map((declaration) => Object.freeze({
    pluginId: manifest.id,
    providerId: buildQualifiedPluginContributionKey(createPluginContributionIdentity({
      pluginId: manifest.id,
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
