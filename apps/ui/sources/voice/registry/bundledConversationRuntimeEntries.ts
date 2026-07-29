import type {
  BundledVoiceConversationUiEntry,
  BundledVoiceUiEntry,
} from '@happier-dev/bundled-voice-runtime-contract';
import type { PluginApi } from '@happier-dev/plugin-sdk';

export type BundledConversationRuntimeEntry = Readonly<{
  uiEntry: BundledVoiceConversationUiEntry & Readonly<{
    declaration: NonNullable<BundledVoiceConversationUiEntry['declaration']>;
  }>;
  activate(api: Pick<PluginApi, 'voiceProviders'>): void;
}>;

/**
 * Dependency-neutral generated projection. Keep this separate from runtime
 * composition so settings initialization never imports the live Voice host.
 */
export function createBundledConversationRuntimeEntries(
  entries: readonly BundledVoiceUiEntry[],
  activate: BundledConversationRuntimeEntry['activate'],
): readonly BundledConversationRuntimeEntry[] {
  return Object.freeze(entries.flatMap((entry) => (
    entry.kind === 'voice.conversation-provider.v1' && entry.declaration
      ? [Object.freeze({
          uiEntry: entry as BundledConversationRuntimeEntry['uiEntry'],
          activate,
        })]
      : []
  )));
}
