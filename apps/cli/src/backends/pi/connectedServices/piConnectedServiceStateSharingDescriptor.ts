import type { ConnectedServiceStateSharingDescriptor } from '@/backends/types';

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
      { path: 'sessions', mode: 'linked' },
    ],
    sharedStatePrivacyRiskAcknowledgementRequired: true,
    symlinkUnavailableDegradePolicy: 'block_continuity',
  },
  authIsolation: {
    mode: 'materialized_home',
    secretEntries: ['auth.json'],
  },
} satisfies ConnectedServiceStateSharingDescriptor;
