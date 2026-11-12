import { PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES } from '../auth/services/qualifiedPurposes.js';

export const piConnectedServiceStateSharingDescriptor = {
  providerId: 'pi',
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
    entries: [
      { path: 'sessions', mode: 'linked', createIfMissing: 'directory' },
    ],
    sharedStatePrivacyRiskAcknowledgementRequired: true,
    symlinkUnavailableDegradePolicy: 'block_continuity',
  },
  authIsolation: {
    mode: 'materialized_home',
    secretEntries: ['auth.json', ...PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES.flatMap(row => 'serviceAccount' in row.native ? [row.native.serviceAccount.fileId] : [])],
  },
} as const;
