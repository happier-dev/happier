import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import type { AgentCatalogEntry } from '@/backends/types';
import { createCatalogDefinedAcpEntry } from '@/agent/acp/catalog/createCatalogDefinedAcpEntry';
import { createAgyAcpBackend, type AgyAcpBackendOptions } from './acp/backend';
import { agyDaemonSpawnHooks } from './daemon/spawnHooks';
import { createAgyConnectedServicesMaterializer } from './connectedServices/createAgyConnectedServicesMaterializer';
import { agyConnectedServiceStateSharingDescriptor } from './connectedServices/agyConnectedServiceStateSharingDescriptor';
import { resolveAgyConnectedServiceSwitchContinuity } from './connectedServices/resolveAgyConnectedServiceSwitchContinuity';
import { verifyResumeReachableAgy } from './connectedServices/verifyResumeReachableAgy';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { createAgyConnectedServiceRuntimeAuthAdapter } from './connectedServices/createAgyConnectedServiceRuntimeAuthAdapter';
import { agyQuotaFetcherDescriptor } from './connectedServices/quotaFetcher';
import { agyUsageLimitRecoveryControlAdapter } from './connectedServices/agyUsageLimitRecoveryControlAdapter';
import { classifyAgyAssistantTurnFailure, reportAgyTurnFailure } from './connectedServices/classifyAgyRuntimeQuotaFailure';

const agyCredentialLifecycle = {
  providerId: 'agy', serviceIds: ['antigravity'],
  spawnPreflightOauthRefresh: { mode: 'expiry_window' },
  refreshedCredentialApplication: { mode: 'restart_required' },
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
  getDaemonSpawnHooks: async () => agyDaemonSpawnHooks,
  getCloudConnectTarget: async () => (await import('./cloud/connect')).agyCloudConnect,
  getPreflightSessionControlsProbeAdapter: async () => ({ connectedServiceAuth: 'materialized-env' as const }),
  getConnectedServiceMaterializer: async () => createAgyConnectedServicesMaterializer(),
  getConnectedServiceStateSharingDescriptor: async () => agyConnectedServiceStateSharingDescriptor,
  getConnectedServiceCredentialLifecycleDescriptor: async () => agyCredentialLifecycle,
  getConnectedServiceRuntimeAuthAdapter: async () => createAgyConnectedServiceRuntimeAuthAdapter(),
  getAcpRuntimeTurnHooks: async () => ({ classifyAssistantTurnFailure: classifyAgyAssistantTurnFailure, onTurnFailure: reportAgyTurnFailure }),
  connectedServiceQuotaFetcherDescriptor: agyQuotaFetcherDescriptor,
  getSessionUsageLimitRecoveryControlAdapter: async () => agyUsageLimitRecoveryControlAdapter,
  resolveConnectedServiceSwitchContinuity: resolveAgyConnectedServiceSwitchContinuity,
  verifyResumeReachable: verifyResumeReachableAgy,
  runtimeInstallableKeys: [INSTALLABLE_KEYS.AGY_ACP_SERVER],
} satisfies AgentCatalogEntry;
