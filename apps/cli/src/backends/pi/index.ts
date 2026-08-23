import { AGENTS_CORE } from '@happier-dev/agents';

import { PI_BROKER_SELECTIONS_ENV, parsePiBrokerSelections } from '@/backends/pi/brokerExtension';
import { checklists } from './cli/checklists';
import { createPiConnectedServiceRuntimeAuthAdapter } from '@/backends/pi/connectedServices/createPiConnectedServiceRuntimeAuthAdapter';
import { createPiConnectedServicesMaterializer } from '@/backends/pi/connectedServices/createPiConnectedServicesMaterializer';
import { materializePiConnectedServiceRuntimeAuthSelection } from '@/backends/pi/connectedServices/materializePiConnectedServiceRuntimeAuthSelection';
import { piConnectedServiceStateSharingDescriptor } from '@/backends/pi/connectedServices/piConnectedServiceStateSharingDescriptor';
import { piUsageLimitRecoveryControlAdapter } from '@/backends/pi/connectedServices/piUsageLimitRecoveryControlAdapter';
import { resolvePiConnectedServiceCandidatePersistedSessionFile } from '@/backends/pi/connectedServices/resolvePiConnectedServiceCandidatePersistedSessionFile';
import { resolvePiConnectedServiceSwitchContinuity } from '@/backends/pi/connectedServices/resolvePiConnectedServiceSwitchContinuity';
import type { AgentCatalogEntry } from '../types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { piDaemonSpawnHooks } from '@/backends/pi/daemon/spawnHooks';

const piConnectedServiceCredentialLifecycleDescriptor: ConnectedServiceCredentialLifecycleDescriptor = {
  providerId: 'pi',
  serviceIds: AGENTS_CORE.pi.connectedServices.supportedServiceIds,
  spawnPreflightOauthRefresh: { mode: 'expiry_window' },
  refreshedCredentialApplication: {
    mode: 'restart_required',
    // openai-codex is OAuth-only ⇒ always brokered ⇒ unconditional no-restart. claude-subscription is
    // credential-shape-specific: the OAuth shape is brokered (no restart — the daemon re-feeds tokens),
    // but a SETUP-TOKEN materializes as a raw api_key with no broker, so it must restart to pick up a
    // reconnected credential. Narrow the no-restart claim to the actually-brokered shape.
    noRestartRequiredServiceIds: ['openai-codex'],
    noRestartRequiredWhenBrokeredServiceIds: ['claude-subscription'],
    isTargetBrokeredForBinding: ({ serviceId, environmentVariables }) => {
      // Broker-backed for this binding iff the running session carries a Pi broker selection whose
      // service id matches — the same signal the switch-continuity resolver gates hot-apply on.
      const selections = parsePiBrokerSelections(environmentVariables[PI_BROKER_SELECTIONS_ENV]);
      return Object.values(selections).some((selection) => selection?.serviceId === serviceId);
    },
  },
  predictiveSoftSwitch: { mode: 'unsupported' },
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
  id: AGENTS_CORE.pi.id,
  cliSubcommand: AGENTS_CORE.pi.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/pi/cli/command')).handlePiCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/pi/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/pi/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/pi/cli/auth/piCliAuthSpec')).piCliAuthSpec,
  getConnectedServiceMaterializer: async () => createPiConnectedServicesMaterializer(),
  getConnectedServiceStateSharingDescriptor: async () => piConnectedServiceStateSharingDescriptor,
  getConnectedServiceRuntimeAuthAdapter: async () => createPiConnectedServiceRuntimeAuthAdapter(),
  getConnectedServiceCredentialLifecycleDescriptor: async () => piConnectedServiceCredentialLifecycleDescriptor,
  materializeConnectedServiceRuntimeAuthSelection: materializePiConnectedServiceRuntimeAuthSelection,
  resolveConnectedServiceSwitchContinuity: async (params) => await resolvePiConnectedServiceSwitchContinuity(params),
  resolveConnectedServiceCandidatePersistedSessionFile: resolvePiConnectedServiceCandidatePersistedSessionFile,
  verifyResumeReachable: async (input) =>
    await (await import('@/backends/pi/connectedServices/verifyResumeReachablePi')).verifyResumeReachablePi(input),
  getDirectSessionProviderOps: async () => (await import('./directSessions/providerOps')).piDirectSessionProviderOps,
  getSessionUsageLimitRecoveryControlAdapter: async () => piUsageLimitRecoveryControlAdapter,
  getDaemonSpawnHooks: async () => piDaemonSpawnHooks,
  vendorResumeSupport: AGENTS_CORE.pi.resume.vendorResume,
  getPreflightSessionControlsProbeAdapter: async () =>
    (await import('@/backends/pi/preflight/piPreflightModelsProbeAdapter')).piPreflightModelsProbeAdapter,
  getAcpBackendFactory: async () => {
    const { createPiBackend } = await import('@/backends/pi/acp/backend');
    return (opts) => ({ backend: createPiBackend(opts as any) });
  },
  checklists,
} satisfies AgentCatalogEntry;
