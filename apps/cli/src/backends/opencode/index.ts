import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import { createOpenCodeConnectedServiceRuntimeAuthAdapter } from '@/backends/opencode/connectedServices/createOpenCodeConnectedServiceRuntimeAuthAdapter';
import { createOpenCodeConnectedServicesMaterializer } from '@/backends/opencode/connectedServices/createOpenCodeConnectedServicesMaterializer';
import { materializeOpenCodeConnectedServiceRuntimeAuthSelection } from '@/backends/opencode/connectedServices/materializeOpenCodeConnectedServiceRuntimeAuthSelection';
import { openCodeConnectedServiceStateSharingDescriptor } from '@/backends/opencode/connectedServices/openCodeConnectedServiceStateSharingDescriptor';
import { openCodeUsageLimitRecoveryControlAdapter } from '@/backends/opencode/connectedServices/openCodeUsageLimitRecoveryControlAdapter';
import { resolveOpenCodeConnectedServiceSwitchContinuity } from '@/backends/opencode/connectedServices/resolveOpenCodeConnectedServiceSwitchContinuity';
import { opencodeDaemonSpawnHooks } from '@/backends/opencode/daemon/spawnHooks';
import { buildOpenCodeRuntimeLocalHandoffMetadata } from '@/backends/opencode/sessionHandoff/runtimeLocalMetadata';
import type { AgentCatalogEntry } from '../types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';

const openCodeConnectedServiceCredentialLifecycleDescriptor: ConnectedServiceCredentialLifecycleDescriptor = {
  providerId: 'opencode',
  serviceIds: AGENTS_CORE.opencode.connectedServices.supportedServiceIds,
  spawnPreflightOauthRefresh: { mode: 'expiry_window' },
  refreshedCredentialApplication: {
    mode: 'restart_required',
    noRestartRequiredServiceIds: ['openai-codex', 'claude-subscription'],
  },
  predictiveSoftSwitch: { mode: 'supported' },
  sameAccountFanoutStrategy: 'shared_group_auth_surface',
  generationApplicationScope: 'per_session_runtime',
  runtimeAuthApply: {
    directLiveHotAuth: {
      supportsInTurnApply: false,
      requiresExactRuntimeIdentity: false,
      refreshSelectionResync: 'not_applicable',
      authMode: {
        kind: 'provider_owned',
        name: 'broker_selection_indirection',
      },
    },
  },
};

export const agent = {
  id: AGENTS_CORE.opencode.id,
  cliSubcommand: AGENTS_CORE.opencode.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/opencode/cli/command')).handleOpenCodeCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/opencode/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/opencode/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/opencode/cli/auth/opencodeCliAuthSpec')).opencodeCliAuthSpec,
  getDaemonSpawnHooks: async () => opencodeDaemonSpawnHooks,
  reconcileDaemonResources: async () =>
    await (await import('@/backends/opencode/server/sharedManagedServer')).reapUnusedSharedManagedOpenCodeServersBestEffort(),
  getConnectedServiceMaterializer: async () => createOpenCodeConnectedServicesMaterializer(),
  getConnectedServiceRuntimeAuthAdapter: async () => createOpenCodeConnectedServiceRuntimeAuthAdapter(),
  materializeConnectedServiceRuntimeAuthSelection: materializeOpenCodeConnectedServiceRuntimeAuthSelection,
  getConnectedServiceCredentialLifecycleDescriptor: async () => openCodeConnectedServiceCredentialLifecycleDescriptor,
  getConnectedServiceStateSharingDescriptor: async () => openCodeConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceSwitchContinuity: async (params) => await resolveOpenCodeConnectedServiceSwitchContinuity(params),
  verifyResumeReachable: async (input) =>
    await (await import('@/backends/opencode/connectedServices/verifyResumeReachableOpenCode')).verifyResumeReachableOpenCode(input),
  getSessionUsageLimitRecoveryControlAdapter: async () => openCodeUsageLimitRecoveryControlAdapter,
  getDirectSessionProviderOps: async () => (await import('@/backends/opencode/directSessions/providerOps')).openCodeDirectSessionProviderOps,
  getProviderAttachOps: async () => (await import('@/backends/opencode/attach/providerAttachOps')).openCodeProviderAttachOps,
  vendorResumeSupport: AGENTS_CORE.opencode.resume.vendorResume,
  buildRuntimeLocalHandoffMetadata: buildOpenCodeRuntimeLocalHandoffMetadata,
  getAcpBackendFactory: async () => {
    const { createOpenCodeBackend } = await import('@/backends/opencode/acp/backend');
    return (opts) => ({ backend: createOpenCodeBackend(opts as any) });
  },
  getAcpForkContinuationHandler: async () => (await import('@/backends/opencode/acp/forkContinuationHandler')).openCodeAcpForkContinuationHandler,
  getProviderNativeForkHandler: async () => (await import('@/backends/opencode/server/providerNativeForkHandler')).openCodeProviderNativeForkHandler,
  getSessionCatalogControlAdapter: async () =>
    (await import('@/backends/opencode/server/catalogControl/openCodeServerCatalogControlAdapter')).openCodeServerCatalogControlAdapter,
  getPreflightSessionControlsProbeAdapter: async () =>
    (await import('@/backends/opencode/preflight/openCodePreflightSessionControlsProbeAdapter')).openCodePreflightSessionControlsProbeAdapter,
  checklists,
} satisfies AgentCatalogEntry;
