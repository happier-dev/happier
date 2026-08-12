import { AGENTS_CORE } from '@happier-dev/agents';

import { createClaudeConnectedServiceRuntimeAuthAdapter } from '@/backends/claude/connectedServices/createClaudeConnectedServiceRuntimeAuthAdapter';
import { createClaudeConnectedServicesMaterializer } from '@/backends/claude/connectedServices/createClaudeConnectedServicesMaterializer';
import { claudeUsageLimitRecoveryControlAdapter } from '@/backends/claude/connectedServices/claudeUsageLimitRecoveryControlAdapter';
import { claudeConnectedServiceStateSharingDescriptor } from '@/backends/claude/connectedServices/claudeConnectedServiceStateSharingDescriptor';
import { claudeConnectedServiceCredentialStorageCleanup } from '@/backends/claude/connectedServices/claudeConnectedServiceCredentialStorageCleanup';
import { hasStaleClaudeMaterializedHomeForBinding } from '@/backends/claude/connectedServices/materializedClaudeHomeFreshness';
import { materializeClaudeConnectedServiceRuntimeAuthSelection } from '@/backends/claude/connectedServices/materializeClaudeConnectedServiceRuntimeAuthSelection';
import { resolveClaudeConnectedServiceSwitchContinuity } from '@/backends/claude/connectedServices/resolveClaudeConnectedServiceSwitchContinuity';
import { resolveClaudeConnectedServiceCandidatePersistedSessionFile } from '@/backends/claude/connectedServices/resolveClaudeConnectedServiceCandidatePersistedSessionFile';
import { verifyClaudeSharedGroupGenerationApplication } from '@/backends/claude/connectedServices/verifyClaudeSharedGroupGenerationApplication';
import { applyClaudeSharedGroupGenerationApplication } from '@/backends/claude/connectedServices/applyClaudeSharedGroupGenerationApplication';
import { claudeSubscriptionQuotaFetcherDescriptor } from '@/backends/claude/connectedServices/quotaFetcher';
import { claudeDaemonSpawnHooks } from '@/backends/claude/daemon/spawnHooks';
import { buildClaudeRuntimeLocalHandoffMetadata } from '@/backends/claude/sessionHandoff/runtimeLocalMetadata';
import type { AgentCatalogEntry } from '../types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';


const claudeConnectedServiceCredentialLifecycleDescriptor: ConnectedServiceCredentialLifecycleDescriptor = {
  providerId: 'claude',
  serviceIds: AGENTS_CORE.claude.connectedServices.supportedServiceIds,
  // expiry_window, NOT force: per-spawn forced rotation burned single-use refresh tokens for
  // hours-fresh credentials and turned refresh-lease contention (right after a daemon restart)
  // into "Failed to resume session" (live incident 2026-07-08 19:39). Near-expiry credentials
  // still refresh at spawn; home staleness is healed by materialization + the canonical
  // freshness net, so forcing a store rotation at spawn adds nothing.
  spawnPreflightOauthRefresh: { mode: 'expiry_window' },
  refreshedCredentialApplication: {
    mode: 'restart_required',
    // Every Claude runner shape reads the stable CLAUDE_CONFIG_DIR home LIVE: the terminal
    // `claude` binary re-reads .credentials.json between requests (live-proven 2026-07-08), and
    // the agent-SDK runner additionally refreshes through the daemon getOAuthToken callback.
    // Refreshed claude-subscription credentials therefore apply WITHOUT restarting sessions —
    // restarts remain only for account SWITCHES (generation applies via the switch coordinator).
    noRestartRequiredServiceIds: ['claude-subscription'],
  },
  predictiveSoftSwitch: {
    mode: 'supported',
    liveSessionRequirement: {
      kind: 'shared_group_auth_surface',
      serviceIds: ['claude-subscription'],
      authEnvKey: 'CLAUDE_CONFIG_DIR',
      authEnvSubpath: ['claude-config'],
    },
  },
  sameAccountFanoutStrategy: 'shared_group_auth_surface',
  generationApplicationScope: 'shared_group_auth_surface',
  sharedGenerationApplicationServiceIds: ['claude-subscription'],
  runtimeAuthApply: {
    directLiveHotAuth: {
      supportsInTurnApply: false,
      requiresExactRuntimeIdentity: false,
      refreshSelectionResync: 'not_applicable',
      authMode: {
        kind: 'provider_owned',
        name: 'claude_shared_group_auth_surface',
      },
    },
  },
  verifyGenerationApplication: verifyClaudeSharedGroupGenerationApplication,
  applySharedGenerationApplication: applyClaudeSharedGroupGenerationApplication,
  buildLiveGenerationCurrentTruthRequest: ({ serviceId, currentTruth, applicationSettled }) => ({
    serviceId,
    reason: 'diagnostic',
    ...(applicationSettled ? { applicationSettled: true as const } : {}),
    authGeneration: currentTruth,
  }),
  credentialStorageCleanup: claudeConnectedServiceCredentialStorageCleanup,
  materializedHomeMaintenance: {
    // RR-9: the generic refresh coordinator consumes this hook instead of importing the Claude
    // freshness function directly. The canonical-group-ownership rule stays entirely Claude-owned.
    hasStaleMaterializedHomeForBinding: hasStaleClaudeMaterializedHomeForBinding,
  },
};

export const agent = {
  id: AGENTS_CORE.claude.id,
  cliSubcommand: AGENTS_CORE.claude.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/claude/cli/command')).handleClaudeCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/claude/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/claude/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/claude/cli/auth/claudeCliAuthSpec')).claudeCliAuthSpec,
  getCloudConnectTarget: async () => (await import('@/backends/claude/cloud/connect')).claudeCloudConnect,
  getDaemonSpawnHooks: async () => claudeDaemonSpawnHooks,
  getConnectedServiceMaterializer: async () => createClaudeConnectedServicesMaterializer(),
  getConnectedServiceRuntimeAuthAdapter: async () => createClaudeConnectedServiceRuntimeAuthAdapter(),
  materializeConnectedServiceRuntimeAuthSelection: materializeClaudeConnectedServiceRuntimeAuthSelection,
  getConnectedServiceCredentialLifecycleDescriptor: async () => claudeConnectedServiceCredentialLifecycleDescriptor,
  getConnectedServiceStateSharingDescriptor: async () => claudeConnectedServiceStateSharingDescriptor,
  connectedServiceQuotaFetcherDescriptor: claudeSubscriptionQuotaFetcherDescriptor,
  getSessionUsageLimitRecoveryControlAdapter: async () => claudeUsageLimitRecoveryControlAdapter,
  getSessionGoalControlAdapter: async () => (await import('./goalControl/claudeGoalControlAdapter')).claudeGoalControlAdapter,
  resolveConnectedServiceSwitchContinuity: async (params) => await resolveClaudeConnectedServiceSwitchContinuity(params),
  resolveConnectedServiceCandidatePersistedSessionFile: ({ metadata }) =>
    resolveClaudeConnectedServiceCandidatePersistedSessionFile({ metadata }),
  // Claude's underlying probe takes a `{ vendorResumeId, processEnv, ... }` shape rather than the
  // normalized `VerifyResumeReachableInput`. Adapt here — the materialized target env is the
  // process env Claude reads; the persisted candidate hint and the §2 strict flag pass through
  // (RD-MAT-5: the probe consults the candidate file the switch WILL import, except target-strict).
  verifyResumeReachable: async (input) =>
    await (await import('@/backends/claude/connectedServices/verifyResumeReachableClaude')).verifyResumeReachableClaude({
      vendorResumeId: input.vendorResumeId,
      processEnv: input.targetMaterializedEnv as NodeJS.ProcessEnv,
      candidatePersistedSessionFile: input.candidatePersistedSessionFile ?? null,
      targetStrict: input.targetStrict === true,
    }),
  getDirectSessionProviderOps: async () => (await import('@/backends/claude/directSessions/providerOps')).claudeDirectSessionProviderOps,
  onTerminalAttachmentRetired: async ({ happyHomeDir, sessionId, attachmentInfo }) => {
    const result = await (await import('./endpointRecovery/claudeEndpointArtifacts'))
      .retireClaudeEndpointArtifactsForTerminalAttachment({
        happyHomeDir,
        sessionId,
        retiredAttachmentId: attachmentInfo.attachmentId,
      });
    if (result.status === 'retained') {
      throw new Error(`Claude endpoint artifacts retained after terminal retirement: ${result.reason}`);
    }
  },
  hasTerminalAttachmentControlDescriptor: async (params) =>
    await (await import('./endpointRecovery/claudeEndpointArtifacts'))
      .hasClaudeEndpointDescriptorForSession(params),
  vendorResumeSupport: AGENTS_CORE.claude.resume.vendorResume,
  buildRuntimeLocalHandoffMetadata: buildClaudeRuntimeLocalHandoffMetadata,
  needsAccountSettingsForProbes: true,
  getPreflightSessionControlsProbeAdapter: async () => (await import('@/backends/claude/preflight/claudePreflightModelsProbeAdapter')).claudePreflightModelsProbeAdapter,
  getHeadlessTmuxArgvTransform: async () => (await import('@/backends/claude/startup/headlessTmuxArgs')).ensureClaudeHeadlessTmuxStartingModeArgs,
} satisfies AgentCatalogEntry;
