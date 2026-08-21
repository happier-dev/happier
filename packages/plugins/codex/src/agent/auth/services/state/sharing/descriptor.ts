export const codexStateSharingDescriptor = {
  providerId: 'codex',
  providerSupportStatus: 'supported',
  config: {
    supported: true,
    modes: ['linked', 'copied', 'isolated'],
    entries: [
      { path: 'config.toml', mode: 'force_copied' },
      { path: 'environments.toml', mode: 'linked_or_copied' },
      { path: 'hooks.json', mode: 'linked_or_copied' },
      { path: 'AGENTS.md', mode: 'linked_or_copied' },
      { path: 'AGENTS.override.md', mode: 'linked_or_copied' },
      { path: 'instructions.md', mode: 'linked_or_copied' },
      { path: 'prompts', mode: 'linked_or_copied' },
      { path: 'agents', mode: 'linked_or_copied' },
      { path: 'skills', mode: 'linked_or_copied' },
      { path: 'rules', mode: 'linked_or_copied' },
    ],
  },
  state: {
    supported: true,
    modes: ['isolated', 'shared'],
    entries: [
      { path: 'sessions', mode: 'linked' },
      { path: 'archived_sessions', mode: 'linked' },
      { path: 'session_index.jsonl', mode: 'linked' },
      { path: 'history.jsonl', mode: 'linked' },
      { path: 'memories', mode: 'linked' },
    ],
    sharedStatePrivacyRiskAcknowledgementRequired: true,
    symlinkUnavailableDegradePolicy: 'degrade_to_isolated',
  },
  authIsolation: {
    mode: 'materialized_home',
    secretEntries: ['auth.json', 'accounts'],
  },
  transforms: [
    {
      entry: 'config.toml',
      kind: 'rewrite_toml',
      spec: {
        setStringValues: {
          cli_auth_credentials_store: 'file',
        },
      },
    },
  ],
} as const;
