import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { VoiceProviderContribution } from '@happier-dev/plugin-sdk/voice';

import { projectBundledVoiceManifestContributions } from './bundledVoiceManifestProjection';

export type BundledConversationRuntimeEntry = Readonly<{
  pluginId: string;
  providerId: string;
  declaration: Extract<VoiceProviderContribution, Readonly<{ kind: 'conversation' }>>;
  activate(api: Pick<PluginApi, 'voiceProviders'>): void;
}>;

/**
 * Dependency-neutral generated projection. Keep this separate from runtime
 * composition so settings initialization never imports the live Voice host.
 */
export function createBundledConversationRuntimeEntries(
  manifest: unknown,
  activate: BundledConversationRuntimeEntry['activate'],
): readonly BundledConversationRuntimeEntry[] {
  return Object.freeze(projectBundledVoiceManifestContributions(manifest).flatMap((entry) => (
    entry.declaration.kind === 'conversation'
      ? [Object.freeze({
          pluginId: entry.pluginId,
          providerId: entry.providerId,
          declaration: entry.declaration,
          activate,
        })]
      : []
  )));
}
