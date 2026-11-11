export const OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR = Object.freeze({
  nativeHome: { environmentKey: 'XDG_DATA_HOME', defaultRelativePath: '.local/share' },
  providerSupportStatus: 'supported',
  config: {
    supported: false,
    modes: ['isolated'],
    entries: [],
    unavailableReason: 'not_implemented',
  },
  state: {
    supported: true,
    modes: ['isolated', 'shared'],
    entries: [{ path: 'opencode/opencode.db', mode: 'linked' }],
    sharedStatePrivacyRiskAcknowledgementRequired: true,
    symlinkUnavailableDegradePolicy: 'block_continuity',
  },
  authIsolation: {
    mode: 'process_env',
    secretEntries: ['OPENCODE_AUTH_CONTENT', 'opencode/auth.json'],
  },
} as const);
