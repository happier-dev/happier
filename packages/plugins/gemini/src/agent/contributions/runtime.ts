import {
  createGeminiAuthMaterializationInput,
  GEMINI_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
  GEMINI_SUPPORTED_CONNECTED_SERVICE_IDS,
  materializeGeminiAuthEnvironment,
  readGeminiConnectedServiceId,
} from '../auth/services/materialization.js';
import { geminiConnectedServiceQuotaFetcherContribution } from '../auth/services/quota/contribution.js';
import { geminiConnectedServiceStateSharingDescriptor } from '../connectedServices/descriptor.js';
import { verifyResumeReachableGemini } from '../connectedServices/reachability.js';
import { createGeminiConnectedServiceRuntimeAuthAdapter } from '../connectedServices/runtimeAuthAdapter.js';

export const GEMINI_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'gemini',
  builtInAcpCatalog: true,
  cliSessionCommand: {
    backendIdForSessionRuntime: 'gemini',
    agentIdForAccountSettings: 'gemini',
  },
  cloudConnect: {
    displayName: 'Gemini',
    vendorDisplayName: 'Google Gemini',
    vendorKey: 'gemini',
    status: 'wired',
    customAuthenticator: {
      authenticate: async () => ({
        ok: false,
        code: 'unsupported',
        diagnostics: [{
          code: 'gemini_token_auth_required',
          message: 'Gemini uses API-key or Vertex token setup through connected-account credentials.',
        }],
      }),
    },
  },
  connectedServices: {
    serviceIds: GEMINI_SUPPORTED_CONNECTED_SERVICE_IDS,
    materializedHomeCredentialEntries: GEMINI_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
    readConnectedServiceId: readGeminiConnectedServiceId,
    createAuthMaterializationInput: createGeminiAuthMaterializationInput,
    materializeAuthEnvironment: materializeGeminiAuthEnvironment,
    stateSharingDescriptor: geminiConnectedServiceStateSharingDescriptor,
    quotaFetcherDescriptor: geminiConnectedServiceQuotaFetcherContribution,
    runtimeAuthAdapter: createGeminiConnectedServiceRuntimeAuthAdapter(),
    recoveryCapabilities: {
      predictiveSoftSwitch: { mode: 'unsupported' },
      generationApplicationScope: 'per_session_runtime',
    },
    shouldRestartForServiceSwitch: (selection: unknown) => readGeminiConnectedServiceId(selection) !== null,
    restartRematerializeRequiredReason: 'gemini_auth_environment_rematerialization_required',
    verifyResumeReachable: verifyResumeReachableGemini,
  },
} as const);
