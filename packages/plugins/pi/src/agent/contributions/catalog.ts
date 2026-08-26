import {
  createPiAuthMaterializationInput,
  materializePiAuthEnvironment,
  PI_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
  PI_SUPPORTED_CONNECTED_SERVICE_IDS,
  readPiConnectedServiceId,
} from '../auth/services/materialization.js';
export {
  PI_AUTH_ENV_KEYS_TO_NEUTRALIZE,
} from '../auth/services/materialization.js';
import { resolvePiConnectedServiceCandidatePersistedSessionFile } from '../connectedServices/candidateSessionFile.js';
import { verifyResumeReachablePi } from '../connectedServices/reachability.js';
import { createPiConnectedServiceRuntimeAuthAdapter } from '../connectedServices/runtimeAuthAdapter.js';
import { piConnectedServiceStateSharingDescriptor } from '../connectedServices/stateSharingDescriptor.js';
import {
  PI_REQUEST_AUTH_USES,
} from '../auth/services/requestAuth/purposes.js';

export const PI_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'pi',
  connectedServices: {
    serviceIds: PI_SUPPORTED_CONNECTED_SERVICE_IDS,
    requestAuthUses: PI_REQUEST_AUTH_USES,
    materializedHomeCredentialEntries: PI_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
    readConnectedServiceId: readPiConnectedServiceId,
    createAuthMaterializationInput: createPiAuthMaterializationInput,
    materializeAuthEnvironment: materializePiAuthEnvironment,
    stateSharingDescriptor: piConnectedServiceStateSharingDescriptor,
    runtimeAuthAdapter: createPiConnectedServiceRuntimeAuthAdapter(),
    shouldRestartForServiceSwitch: (selection: unknown) => readPiConnectedServiceId(selection) !== null,
    sameAuthGroupRequiresResumeReachability: true,
    connectedSwitchSharedStateRequiredReason: 'pi_exact_connected_service_selection_required',
    nativeSwitchSharedStateRequiredReason: 'pi_session_state_sharing_required',
    verifyResumeReachable: verifyResumeReachablePi,
    resolveCandidatePersistedSessionFile: resolvePiConnectedServiceCandidatePersistedSessionFile,
    recoveryCapabilities: {
      predictiveSoftSwitch: { mode: 'unsupported' },
      generationApplicationScope: 'request_time_auth',
    },
    usageLimitRecovery: {
      agentId: 'pi',
      fallbackBackoffEnvKey: 'HAPPIER_PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS',
      maxAttemptsEnvKey: 'HAPPIER_PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS',
      defaultFallbackBackoffMs: 600_000,
      defaultMaxAttempts: 3,
    },
  },
} as const);
