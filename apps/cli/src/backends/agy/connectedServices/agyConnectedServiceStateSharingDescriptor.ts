import type { ConnectedServiceStateSharingDescriptor } from '@/backends/types';

export const agyConnectedServiceStateSharingDescriptor = {
  providerId: 'agy',
  providerSupportStatus: 'supported',
  config: {
    supported: true,
    modes: ['linked', 'copied', 'isolated'],
    entries: [
      { path: 'config/skills', mode: 'linked_or_copied' },
      { path: 'antigravity-cli/skills', mode: 'linked_or_copied' },
      { path: 'config/hooks.json', mode: 'linked_or_copied' },
      { path: 'config/mcp_config.json', mode: 'linked_or_copied' },
    ],
  },
  state: {
    supported: true,
    modes: ['isolated', 'shared'],
    entries: [
      { path: 'antigravity-cli/conversations', mode: 'linked' },
      { path: 'antigravity-cli/brain', mode: 'linked' },
      // Conversation titles live here; without it a shared conversation lists under another title.
      { path: 'antigravity-cli/annotations', mode: 'linked' },
    ],
    sharedStatePrivacyRiskAcknowledgementRequired: true,
    symlinkUnavailableDegradePolicy: 'block_continuity',
  },
  authIsolation: {
    mode: 'materialized_home',
    secretEntries: ['antigravity-cli/antigravity-oauth-token'],
  },
} satisfies ConnectedServiceStateSharingDescriptor;
