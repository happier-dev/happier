import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { VoiceProviderContribution } from '@happier-dev/plugin-sdk/voice';

import { projectBundledVoiceManifestContributions } from './bundledVoiceManifestProjection';
import type { BundledVoiceManifestProjection } from './bundledVoiceManifestProjection';

type BundledConversationActivate = (api: Pick<PluginApi, 'voiceProviders'>) => void;

export type BundledConversationRuntimeEntry = Readonly<{
  pluginId: string;
  providerId: string;
  declaration: Extract<VoiceProviderContribution, Readonly<{ kind: 'conversation' }>>;
}> & (Readonly<{ activate: BundledConversationActivate; loadActivate?: never }>
  | Readonly<{ loadActivate(): Promise<BundledConversationActivate>; activate?: never }>);

/**
 * Dependency-neutral generated projection. Keep this separate from runtime
 * composition so settings initialization never imports the live Voice host.
 */
export function createBundledConversationRuntimeEntries(
  manifest: BundledVoiceManifestProjection,
  loadActivate: () => Promise<BundledConversationActivate>,
): readonly BundledConversationRuntimeEntry[] {
  return Object.freeze(projectBundledVoiceManifestContributions(manifest).flatMap((entry) => (
    entry.declaration.kind === 'conversation'
      ? [Object.freeze({
          pluginId: entry.pluginId,
          providerId: entry.providerId,
          declaration: entry.declaration,
          loadActivate,
        })]
      : []
  )));
}
