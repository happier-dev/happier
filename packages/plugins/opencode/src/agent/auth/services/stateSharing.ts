export const OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR = Object.freeze({
  providerId: 'opencode',
  providerSupportStatus: { supportLevel: 'unsupported' },
  configSharing: {
    mode: 'unsupported',
    mergeStrategy: 'none',
  },
  stateSharing: {
    mode: 'unsupported',
    resumeStrategy: 'none',
  },
  authIsolation: {
    mode: 'process_env',
    env: ['OPENCODE_AUTH_CONTENT'],
    secretEntries: ['OPENCODE_AUTH_CONTENT', 'auth.json'],
  },
} as const);
