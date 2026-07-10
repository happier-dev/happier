import {
  createPiAuthMaterializationInput,
  materializePiAuthEnvironment,
  PI_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
  PI_SUPPORTED_CONNECTED_SERVICE_IDS,
  readPiConnectedServiceId,
} from '../auth/services/materialization.js';
import { resolvePiConnectedServiceCandidatePersistedSessionFile } from '../connectedServices/candidateSessionFile.js';
import { verifyResumeReachablePi } from '../connectedServices/reachability.js';
import { createPiConnectedServiceRuntimeAuthAdapter } from '../connectedServices/runtimeAuthAdapter.js';
import { piConnectedServiceStateSharingDescriptor } from '../connectedServices/stateSharingDescriptor.js';
import { resolvePiConnectedServiceSwitchContinuity } from '../connectedServices/switchContinuity.js';
import { PI_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';

export const PI_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'pi',
  builtInAcpCatalog: true,
  checklists: {},
  cliSessionCommand: {
    backendIdForSessionRuntime: 'pi',
    agentIdForAccountSettings: 'pi',
  },
  preflightSessionControls: PI_PREFLIGHT_SESSION_CONTROLS,
  connectedServices: {
    serviceIds: PI_SUPPORTED_CONNECTED_SERVICE_IDS,
    materializedHomeCredentialEntries: PI_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
    readConnectedServiceId: readPiConnectedServiceId,
    createAuthMaterializationInput: createPiAuthMaterializationInput,
    materializeAuthEnvironment: materializePiAuthEnvironment,
    stateSharingDescriptor: piConnectedServiceStateSharingDescriptor,
    recoveryCapabilities: {
      predictiveSoftSwitch: { mode: 'unsupported' },
    },
    usageLimitRecovery: {
      agentId: 'pi',
      fallbackBackoffEnvKey: 'HAPPIER_PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS',
      maxAttemptsEnvKey: 'HAPPIER_PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS',
      defaultFallbackBackoffMs: 600_000,
      defaultMaxAttempts: 3,
    },
  },
  runtimeControl: {
    connectedServices: {
      createRuntimeAuthAdapter: createPiConnectedServiceRuntimeAuthAdapter,
      resolveSwitchContinuity: resolvePiConnectedServiceSwitchContinuity,
      verifyResumeReachable: verifyResumeReachablePi,
      resolveCandidatePersistedSessionFile: resolvePiConnectedServiceCandidatePersistedSessionFile,
    },
  },
} as const);
