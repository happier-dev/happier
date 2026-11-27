import type { AgentCatalogEntry } from '@/backends/types';
import { createCatalogDefinedAcpEntry } from '@/agent/acp/catalog/createCatalogDefinedAcpEntry';
import { createAgyAcpBackend, type AgyAcpBackendOptions } from './acp/backend';
import { agyDaemonSpawnHooks } from './daemon/spawnHooks';
import { createAgyConnectedServicesMaterializer } from './connectedServices/createAgyConnectedServicesMaterializer';
import { agyConnectedServiceStateSharingDescriptor } from './connectedServices/agyConnectedServiceStateSharingDescriptor';
import { resolveAgyConnectedServiceSwitchContinuity } from './connectedServices/resolveAgyConnectedServiceSwitchContinuity';
import { verifyResumeReachableAgy } from './connectedServices/verifyResumeReachableAgy';
import { materializeAgyConnectedServiceRuntimeAuthSelection } from './connectedServices/materializeAgyConnectedServiceRuntimeAuthSelection';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { createAgyConnectedServiceRuntimeAuthAdapter } from './connectedServices/createAgyConnectedServiceRuntimeAuthAdapter';
import { agyQuotaFetcherDescriptor } from './connectedServices/quotaFetcher';
import { agyUsageLimitRecoveryControlAdapter } from './connectedServices/agyUsageLimitRecoveryControlAdapter';
import { classifyAgyAssistantTurnFailure, reportAgyTurnFailure } from './connectedServices/classifyAgyRuntimeFailure';

const agyCredentialLifecycle = {
  providerId: 'agy', serviceIds: ['antigravity'],
  spawnPreflightOauthRefresh: { mode: 'expiry_window' },
  // A running agy reads its OAuth token file once and then refreshes and rewrites its own copy
  // (`<home>/antigravity-cli/antigravity-oauth-token`, probed live on agy 1.5.18 with
  // AGY_CLI_FORCE_FILE_TOKEN_STORAGE), so a token rotated elsewhere for the same account needs no
  // restart. An account change still restarts: each account has its own home.
  refreshedCredentialApplication: { mode: 'no_restart_required' },
  predictiveSoftSwitch: { mode: 'unsupported' },
  sameAccountFanoutStrategy: 'none', generationApplicationScope: 'per_session_runtime',
  runtimeAuthApply: { directLiveHotAuth: 'unsupported' },
} satisfies ConnectedServiceCredentialLifecycleDescriptor;

export const agent = {
  ...createCatalogDefinedAcpEntry('agy'),
  getCliCommandHandler: async () => (await import('./cli/command')).handleAgyCliCommand,
  getCapabilities: async () => (await import('./cli/extraCapabilities')).capabilities,
  getAcpBackendFactory: async () => {
    return async (opts) => ({ backend: await createAgyAcpBackend(opts as AgyAcpBackendOptions) });
  },
  getAcpRuntimeSessionModelAdapter: async () => (await import('./acp/modelControls')).agyAcpRuntimeSessionModelAdapter,
  getDaemonSpawnHooks: async () => agyDaemonSpawnHooks,
  getCloudConnectTarget: async () => (await import('./cloud/connect')).agyCloudConnect,
  getPreflightSessionControlsProbeAdapter: async () => ({ connectedServiceAuth: 'materialized-env' as const }),
  getConnectedServiceMaterializer: async () => createAgyConnectedServicesMaterializer(),
  getConnectedServiceStateSharingDescriptor: async () => agyConnectedServiceStateSharingDescriptor,
  getConnectedServiceCredentialLifecycleDescriptor: async () => agyCredentialLifecycle,
  getConnectedServiceRuntimeAuthAdapter: async () => createAgyConnectedServiceRuntimeAuthAdapter(),
  getAcpRuntimeTurnHooks: async () => ({
    classifyAssistantTurnFailure: classifyAgyAssistantTurnFailure,
    onTurnFailure: reportAgyTurnFailure,
    createToolCallSidechainResolver: (await import('./acp/agySubagentSidechains')).createAgySubagentSidechainResolver,
  }),
  connectedServiceQuotaFetcherDescriptor: agyQuotaFetcherDescriptor,
  getSessionUsageLimitRecoveryControlAdapter: async () => agyUsageLimitRecoveryControlAdapter,
  resolveConnectedServiceSwitchContinuity: resolveAgyConnectedServiceSwitchContinuity,
  materializeConnectedServiceRuntimeAuthSelection: materializeAgyConnectedServiceRuntimeAuthSelection,
  verifyResumeReachable: verifyResumeReachableAgy,
} satisfies AgentCatalogEntry;
