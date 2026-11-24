export const CODERABBIT_ACCOUNT_SERVICE_ID = 'coderabbit-account';
export const CODERABBIT_ACCOUNT_PURPOSE = 'coderabbit';
export const CODERABBIT_AUTH_FILE = '.coderabbit/auth.json';

export const CODERABBIT_STATE_SHARING = {
  nativeHome: { environmentKey: 'HOME', defaultRelativePath: '.', materializedDirectoryName: 'coderabbit-home',
    purposes: [CODERABBIT_ACCOUNT_PURPOSE] },
  providerSupportStatus: 'supported',
  config: { supported: false, modes: ['isolated'], entries: [] },
  state: { supported: false, modes: ['isolated'], entries: [], symlinkUnavailableDegradePolicy: 'block_continuity' },
  authIsolation: { mode: 'materialized_home', secretEntries: [CODERABBIT_AUTH_FILE] },
} as const;
