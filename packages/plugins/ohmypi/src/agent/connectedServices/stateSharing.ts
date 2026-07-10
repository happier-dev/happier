export const ohMyPiConnectedServiceStateSharingDescriptor = Object.freeze({
  providerId: 'ohMyPi',
  providerSupportStatus: 'unsupported',
  config: {
    supported: false,
    modes: ['isolated'],
    entries: [],
    unavailableReason: 'not_implemented',
  },
  state: {
    supported: false,
    modes: ['isolated'],
    entries: [],
    symlinkUnavailableDegradePolicy: 'block_continuity',
    unavailableReason: 'not_implemented',
  },
  authIsolation: {
    mode: 'process_env',
    secretEntries: [
      'OPENAI_CODEX_OAUTH_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
    ],
  },
} as const);
