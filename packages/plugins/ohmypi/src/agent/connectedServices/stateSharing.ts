import type { AgentConnectedAccountStateSharingDescriptorV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES } from '../auth/services/accountPurposes.js';

export const ohMyPiConnectedServiceStateSharingDescriptor = Object.freeze({
  nativeHome: {
    environmentKey: 'PI_CODING_AGENT_DIR',
    defaultRelativePath: '.omp/agent',
    purposes: OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.map(row => row.purpose),
    materializedRootOverlay: {
      // Preserve native YAML, extensions and skills without inheriting login or model selection.
      privateEntries: ['.env', 'models.yml', 'auth.json', 'agent.db', 'agent.db-wal', 'agent.db-shm',
        'history.db', 'history.db-wal', 'history.db-shm', 'sessions'],
    },
  },
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
    entries: [{ path: 'sessions', mode: 'linked', createIfMissing: 'directory' }],
    sharedStatePrivacyRiskAcknowledgementRequired: true,
    symlinkUnavailableDegradePolicy: 'block_continuity',
  },
  authIsolation: {
    mode: 'materialized_home',
    // Native auth stays in the selected process environment; ADC files use the host file owner.
    secretEntries: [],
  },
} satisfies AgentConnectedAccountStateSharingDescriptorV1);
