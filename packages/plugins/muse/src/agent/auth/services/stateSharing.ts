import { MUSE_NATIVE_HOME } from '../../../connectedAccounts/declarations.js';

export const museStateSharingDescriptor = {
  nativeHome: MUSE_NATIVE_HOME,
  providerId: 'muse', providerSupportStatus: 'supported',
  config: {
    supported: true, modes: ['linked', 'copied', 'isolated'],
    entries: [
      { path: 'muse/settings.json', mode: 'linked_or_copied' },
      { path: 'muse/trust.json', mode: 'linked_or_copied' },
    ],
  },
  state: { supported: false },
  authIsolation: { mode: 'materialized_home', secretEntries: ['muse/auth.json'] },
} as const;
