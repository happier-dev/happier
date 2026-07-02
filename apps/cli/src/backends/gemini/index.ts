import { checklists } from './cli/checklists';
import { createGeminiConnectedServiceRuntimeAuthAdapter } from './connectedServices/createGeminiConnectedServiceRuntimeAuthAdapter';
import { createGeminiConnectedServicesMaterializer } from './connectedServices/createGeminiConnectedServicesMaterializer';
import { geminiConnectedServiceStateSharingDescriptor } from './connectedServices/geminiConnectedServiceStateSharingDescriptor';
import { geminiUsageLimitRecoveryControlAdapter } from './connectedServices/geminiUsageLimitRecoveryControlAdapter';
import { resolveGeminiConnectedServiceSwitchContinuity } from './connectedServices/resolveGeminiConnectedServiceSwitchContinuity';
import { geminiDaemonSpawnHooks } from './daemon/spawnHooks';
import type { AgentCatalogEntry } from '../types';

/**
 * Gemini Agent Catalog Entry
 */
export const agent = {
  id: 'gemini',
  cliSubcommand: 'gemini',
  getCliCommandHandler: async () => (await import('@/backends/gemini/cli/command')).handleGeminiCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/gemini/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/gemini/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/gemini/cli/auth/geminiCliAuthSpec')).geminiCliAuthSpec,
  getCloudConnectTarget: async () => (await import('@/backends/gemini/cloud/connect')).geminiCloudConnect,
  getDaemonSpawnHooks: async () => geminiDaemonSpawnHooks,
  getConnectedServicesMaterializer: async () => createGeminiConnectedServicesMaterializer(),
  getConnectedServiceStateSharingDescriptor: async () => geminiConnectedServiceStateSharingDescriptor,
  // Gemini account switching is restart/rematerialize-only: predictive (soft-threshold)
  // switches are suppressed by declared contract.
  getConnectedServiceRecoveryCapabilities: async () => ({ predictiveSoftSwitch: { mode: 'unsupported' } }),
  getConnectedServiceRuntimeAuthAdapter: async () => createGeminiConnectedServiceRuntimeAuthAdapter(),
  resolveConnectedServiceSwitchContinuity: async (params) => resolveGeminiConnectedServiceSwitchContinuity(params),
  getSessionUsageLimitRecoveryControlAdapter: async () => geminiUsageLimitRecoveryControlAdapter,
  verifyResumeReachable: async (input) =>
    (await import('@/backends/gemini/connectedServices/verifyResumeReachableGemini')).verifyResumeReachableGemini(input),
  vendorResumeSupport: 'supported',
  checklists,
} satisfies AgentCatalogEntry;
