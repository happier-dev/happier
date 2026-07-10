import {
  ANTIGRAVITY_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
  ANTIGRAVITY_SUPPORTED_CONNECTED_SERVICE_IDS,
  antigravityConnectedServiceStateSharingDescriptor,
  createAntigravityAuthMaterializationInput,
  materializeAntigravityAuthEnvironment,
  readAntigravityConnectedServiceId,
} from '../connectedServices/index.js';
import { ANTIGRAVITY_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';

export const ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'antigravity',
  cliSessionCommand: {
    agentIdForAccountSettings: 'antigravity',
    providerInfoCommandPrefixes: [['models']],
  },
  preflightSessionControls: ANTIGRAVITY_PREFLIGHT_SESSION_CONTROLS,
  connectedServices: {
    serviceIds: ANTIGRAVITY_SUPPORTED_CONNECTED_SERVICE_IDS,
    materializedHomeCredentialEntries: ANTIGRAVITY_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
    readConnectedServiceId: readAntigravityConnectedServiceId,
    createAuthMaterializationInput: createAntigravityAuthMaterializationInput,
    materializeAuthEnvironment: materializeAntigravityAuthEnvironment,
    stateSharingDescriptor: antigravityConnectedServiceStateSharingDescriptor,
    recoveryCapabilities: {
      predictiveSoftSwitch: { mode: 'unsupported' },
    },
    shouldRestartForServiceSwitch: (selection: unknown) => readAntigravityConnectedServiceId(selection) !== null,
    restartRematerializeRequiredReason: 'antigravity_auth_environment_rematerialization_required',
  },
} as const);
