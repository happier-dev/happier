import { AGENTS_CORE } from '@happier-dev/agents';
import { resolveCodexSessionBackendMode } from '@happier-dev/agents';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import { checklists } from './cli/checklists';
import { supportsCodexVendorResume } from './resume/vendorResumeSupport';
import { codexConnectedServiceStateSharingDescriptor } from '@/backends/codex/connectedServices/codexConnectedServiceStateSharingDescriptor';
import { createCodexConnectedServiceRuntimeAuthAdapter } from '@/backends/codex/connectedServices/createCodexConnectedServiceRuntimeAuthAdapter';
import { createCodexConnectedServicesMaterializer } from '@/backends/codex/connectedServices/createCodexConnectedServicesMaterializer';
import { materializeCodexConnectedServiceRuntimeAuthSelection } from '@/backends/codex/connectedServices/materializeCodexConnectedServiceRuntimeAuthSelection';
import { resolveCodexConnectedServiceSwitchContinuity } from '@/backends/codex/connectedServices/resolveCodexConnectedServiceSwitchContinuity';
import { resolveCodexConnectedServiceCandidatePersistedSessionFile } from '@/backends/codex/connectedServices/resolveCodexConnectedServiceCandidatePersistedSessionFile';
import { openAiCodexQuotaFetcherDescriptor } from '@/backends/codex/connectedServices/quotaFetcher';
import { codexDaemonSpawnHooks } from '@/backends/codex/daemon/spawnHooks';
import { readCodexEnvironmentAuthState } from '@/backends/codex/cli/auth/readCodexEnvironmentAuthState';
import { codexAppServerCatalogControlAdapter } from '@/backends/codex/appServer/catalogControl/codexAppServerCatalogControlAdapter';
import { codexAppServerGoalControlAdapter } from '@/backends/codex/appServer/goalControl/codexAppServerGoalControlAdapter';
import { codexAppServerUsageLimitRecoveryControlAdapter } from '@/backends/codex/appServer/usageLimitRecoveryControl/codexAppServerUsageLimitRecoveryControlAdapter';
import { buildCodexRuntimeLocalHandoffMetadata } from '@/backends/codex/sessionHandoff/runtimeLocalMetadata';
import { reconcileStableCodexHomesAtStartup } from '@/backends/codex/connectedServices/reconcileStableCodexHomes';
import type { AgentCatalogEntry } from '../types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

const codexConnectedServiceCredentialLifecycleDescriptor: ConnectedServiceCredentialLifecycleDescriptor = {
  providerId: 'codex',
  serviceIds: AGENTS_CORE.codex.connectedServices.supportedServiceIds,
  spawnPreflightOauthRefresh: { mode: 'expiry_window' },
  refreshedCredentialApplication: {
    mode: 'hot_apply',
  },
  predictiveSoftSwitch: { mode: 'supported' },
  sameAccountFanoutStrategy: 'provider_account_id',
  generationApplicationScope: 'per_session_runtime',
  runtimeAuthApply: {
    directLiveHotAuth: {
      supportsInTurnApply: true,
      requiresExactRuntimeIdentity: true,
      refreshSelectionResync: 'required',
      authMode: {
        kind: 'external_token_injection',
        surface: 'codex_chatgpt_auth_tokens',
      },
    },
  },
  buildLiveGenerationCurrentTruthRequest: ({ serviceId, currentTruth }) => ({
    serviceId,
    reason: 'diagnostic',
    authGeneration: currentTruth,
  }),
  materializedHomeMaintenance: {
    // Triage #4: stable codex homes are not refresh-target bound, so nothing else keeps their auth
    // store format-valid or in sync with the store record. The startup reconcile owner drives this.
    reconcileStableHomesAtStartup: reconcileStableCodexHomesAtStartup,
  },
};

function resolveCodexProbeConnectedServicesIdentity(
  connectedServices?: ConnectedServiceBindingsV1 | null,
): string {
  const binding = connectedServices?.bindingsByServiceId['openai-codex'] ?? null;
  if (!binding || binding.source === 'native') return 'cs=native';
  if (binding.selection === 'group') return `cs=group:${binding.groupId}`;
  return `cs=profile:${binding.profileId}`;
}

export const agent = {
  id: AGENTS_CORE.codex.id,
  cliSubcommand: AGENTS_CORE.codex.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/codex/cli/command')).handleCodexCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/codex/cli/capability')).cliCapability,
  getCapabilities: async () => (await import('@/backends/codex/cli/extraCapabilities')).capabilities,
  getCliDetect: async () => (await import('@/backends/codex/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/codex/cli/auth/codexCliAuthSpec')).codexCliAuthSpec,
  getCloudConnectTarget: async () => (await import('@/backends/codex/cloud/connect')).codexCloudConnect,
  getDaemonSpawnHooks: async () => codexDaemonSpawnHooks,
  getConnectedServiceMaterializer: async () => createCodexConnectedServicesMaterializer(),
  getConnectedServiceStateSharingDescriptor: async () => codexConnectedServiceStateSharingDescriptor,
  connectedServiceQuotaFetcherDescriptor: openAiCodexQuotaFetcherDescriptor,
  getConnectedServiceRuntimeAuthAdapter: async () => createCodexConnectedServiceRuntimeAuthAdapter(),
  materializeConnectedServiceRuntimeAuthSelection: materializeCodexConnectedServiceRuntimeAuthSelection,
  getConnectedServiceCredentialLifecycleDescriptor: async () => codexConnectedServiceCredentialLifecycleDescriptor,
  resolveConnectedServiceSwitchContinuity: async (params) => await resolveCodexConnectedServiceSwitchContinuity(params),
  verifyResumeReachable: async (input) =>
    await (await import('@/backends/codex/connectedServices/verifyResumeReachableCodex')).verifyResumeReachableCodex(input),
  resolveConnectedServiceCandidatePersistedSessionFile: ({ metadata }) =>
    resolveCodexConnectedServiceCandidatePersistedSessionFile({ metadata }),
  // Codex persists no transcript path, so the handoff brief can only name its log
  // by deriving it from the vendor resume id the caller already resolved.
  resolveAgentNativeSessionLogPath: async ({ vendorResumeId }) =>
    await (await import('@/backends/codex/utils/resolveCodexNativeSessionLogPath'))
      .resolveCodexNativeSessionLogPath({ vendorResumeId }),
  getDirectSessionProviderOps: async () => (await import('@/backends/codex/directSessions/providerOps')).codexDirectSessionProviderOps,
  getSessionGoalControlAdapter: async () => codexAppServerGoalControlAdapter,
  getSessionCatalogControlAdapter: async () => codexAppServerCatalogControlAdapter,
  getSessionUsageLimitRecoveryControlAdapter: async () => codexAppServerUsageLimitRecoveryControlAdapter,
  vendorResumeSupport: AGENTS_CORE.codex.resume.vendorResume,
  buildRuntimeLocalHandoffMetadata: buildCodexRuntimeLocalHandoffMetadata,
  getVendorResumeSupport: async () => supportsCodexVendorResume,
  getAcpBackendFactory: async () => {
    const { createCodexAcpBackend } = await import('@/backends/codex/acp/backend');
    return (opts) => createCodexAcpBackend(opts as any);
  },
  getAcpForkContinuationHandler: async () => (await import('@/backends/codex/acp/forkContinuationHandler')).codexAcpForkContinuationHandler,
  getProviderNativeForkHandler: async () => (await import('@/backends/codex/appServer/providerNativeForkHandler')).codexAppServerProviderNativeForkHandler,
  needsAccountSettingsForProbes: true,
  resolveModelsProbeVariant: ({ accountSettings, connectedServices }) => {
    // Keep dynamic model probes cache-partitioned by runtime flavor (appServer vs ACP vs MCP).
    const backendMode =
      resolveCodexSessionBackendMode({ metadata: null, accountSettings: accountSettings ?? null }) ?? 'appServer';
    // Speed eligibility is auth-dependent; include auth method to avoid stale modelOptions.
    const authMethod = readCodexEnvironmentAuthState().method ?? 'unknown';
    return `codex:${backendMode}:${authMethod}:${resolveCodexProbeConnectedServicesIdentity(connectedServices)}`;
  },
  getPreflightSessionControlsProbeAdapter: async () =>
    (await import('@/backends/codex/preflight/codexPreflightSessionControlsProbeAdapter')).codexPreflightSessionControlsProbeAdapter,
  checklists,
  runtimeInstallableKeys: [INSTALLABLE_KEYS.CODEX_ACP],
} satisfies AgentCatalogEntry;
