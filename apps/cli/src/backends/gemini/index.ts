import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import { createGeminiConnectedServiceRuntimeAuthAdapter } from '@/backends/gemini/connectedServices/createGeminiConnectedServiceRuntimeAuthAdapter';
import { createGeminiConnectedServicesMaterializer } from '@/backends/gemini/connectedServices/createGeminiConnectedServicesMaterializer';
import { geminiConnectedServiceStateSharingDescriptor } from '@/backends/gemini/connectedServices/geminiConnectedServiceStateSharingDescriptor';
import { geminiUsageLimitRecoveryControlAdapter } from '@/backends/gemini/connectedServices/geminiUsageLimitRecoveryControlAdapter';
import { geminiQuotaFetcherDescriptor } from '@/backends/gemini/connectedServices/quotaFetcher';
import { resolveGeminiConnectedServiceSwitchContinuity } from '@/backends/gemini/connectedServices/resolveGeminiConnectedServiceSwitchContinuity';
import type { AgentCatalogEntry } from '../types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';

const geminiConnectedServiceCredentialLifecycleDescriptor: ConnectedServiceCredentialLifecycleDescriptor = {
  providerId: 'gemini',
  serviceIds: AGENTS_CORE.gemini.connectedServices.supportedServiceIds,
  spawnPreflightOauthRefresh: { mode: 'expiry_window' },
  refreshedCredentialApplication: { mode: 'restart_required' },
  predictiveSoftSwitch: { mode: 'unsupported' },
  sameAccountFanoutStrategy: 'none',
  generationApplicationScope: 'per_session_runtime',
  runtimeAuthApply: { directLiveHotAuth: 'unsupported' },
};

export const agent = {
  id: AGENTS_CORE.gemini.id,
  cliSubcommand: AGENTS_CORE.gemini.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/gemini/cli/command')).handleGeminiCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/gemini/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/gemini/cli/detect')).cliDetect,
  getPreflightSessionControlsProbeAdapter: async () => ({ connectedServiceAuth: 'materialized-env' as const }),
  getCliAuthSpec: async () => (await import('@/backends/gemini/cli/auth/geminiCliAuthSpec')).geminiCliAuthSpec,
  getCloudConnectTarget: async () => (await import('@/backends/gemini/cloud/connect')).geminiCloudConnect,
  getConnectedServiceMaterializer: async () => createGeminiConnectedServicesMaterializer(),
  getConnectedServiceRuntimeAuthAdapter: async () => createGeminiConnectedServiceRuntimeAuthAdapter(),
  getConnectedServiceCredentialLifecycleDescriptor: async () => geminiConnectedServiceCredentialLifecycleDescriptor,
  getConnectedServiceStateSharingDescriptor: async () => geminiConnectedServiceStateSharingDescriptor,
  connectedServiceQuotaFetcherDescriptor: geminiQuotaFetcherDescriptor,
  resolveConnectedServiceSwitchContinuity: async (params) => await resolveGeminiConnectedServiceSwitchContinuity(params),
  verifyResumeReachable: async (input) =>
    await (await import('@/backends/gemini/connectedServices/verifyResumeReachableGemini')).verifyResumeReachableGemini(input),
  getSessionUsageLimitRecoveryControlAdapter: async () => geminiUsageLimitRecoveryControlAdapter,
  vendorResumeSupport: AGENTS_CORE.gemini.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createGeminiBackend } = await import('@/backends/gemini/acp/backend');
    return (opts) => createGeminiBackend(opts as any);
  },
  checklists,
} satisfies AgentCatalogEntry;
