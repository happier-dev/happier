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
import { resolveGeminiDaemonSpawnPrerequisites } from '../lifecycle/spawnHooks.js';

async function resolveGeminiCatalogDaemonSpawnPrerequisites(
  params: Parameters<typeof resolveGeminiDaemonSpawnPrerequisites>[0],
) {
  const result = await resolveGeminiDaemonSpawnPrerequisites(params);
  return result.allowed
    ? { ok: true as const }
    : {
      ok: false as const,
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
      errorMessage: result.errorMessage ?? 'Gemini ACP credentials are unavailable.',
    };
}

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
  daemonSpawnHooks: {
    resolveRuntimePrerequisites: resolveGeminiCatalogDaemonSpawnPrerequisites,
  },
  connectedServices: {
    serviceIds: GEMINI_SUPPORTED_CONNECTED_SERVICE_IDS,
    materializedHomeCredentialEntries: GEMINI_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
    readConnectedServiceId: readGeminiConnectedServiceId,
    createAuthMaterializationInput: createGeminiAuthMaterializationInput,
    materializeAuthEnvironment: materializeGeminiAuthEnvironment,
    stateSharingDescriptor: geminiConnectedServiceStateSharingDescriptor,
    quotaFetcherDescriptor: geminiConnectedServiceQuotaFetcherContribution,
    recoveryCapabilities: {
      predictiveSoftSwitch: { mode: 'unsupported' },
    },
    shouldRestartForServiceSwitch: (selection: unknown) => readGeminiConnectedServiceId(selection) !== null,
    restartRematerializeRequiredReason: 'gemini_auth_environment_rematerialization_required',
  },
  runtimeControl: {
    connectedServices: {
      verifyResumeReachable: verifyResumeReachableGemini,
    },
  },
} as const);
