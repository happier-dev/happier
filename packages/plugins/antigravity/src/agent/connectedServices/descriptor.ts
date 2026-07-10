import { ANTIGRAVITY_AUTH_ISOLATION_ENV_KEYS } from './auth.js';

export const antigravityConnectedServiceStateSharingDescriptor = Object.freeze({
  providerId: 'antigravity',
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
    secretEntries: ANTIGRAVITY_AUTH_ISOLATION_ENV_KEYS,
  },
} as const);
