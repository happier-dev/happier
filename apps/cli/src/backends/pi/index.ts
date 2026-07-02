import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import { createPiConnectedServiceRuntimeAuthAdapter } from './connectedServices/createPiConnectedServiceRuntimeAuthAdapter';
import { createPiConnectedServicesMaterializer } from './connectedServices/createPiConnectedServicesMaterializer';
import { piConnectedServiceStateSharingDescriptor } from './connectedServices/piConnectedServiceStateSharingDescriptor';
import { piUsageLimitRecoveryControlAdapter } from './connectedServices/piUsageLimitRecoveryControlAdapter';
import { resolvePiConnectedServiceCandidatePersistedSessionFile } from './connectedServices/resolvePiConnectedServiceCandidatePersistedSessionFile';
import { resolvePiConnectedServiceSwitchContinuity } from './connectedServices/resolvePiConnectedServiceSwitchContinuity';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.pi.id,
  cliSubcommand: AGENTS_CORE.pi.cliSubcommand,
  getCliCommandHandler: async () => (await import('./cli/command')).handlePiCliCommand,
  getCliCapabilityOverride: async () => (await import('./cli/capability')).cliCapability,
  getCliDetect: async () => (await import('./cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('./cli/auth/piCliAuthSpec')).piCliAuthSpec,
  getConnectedServicesMaterializer: async () => createPiConnectedServicesMaterializer(),
  getConnectedServiceRuntimeAuthAdapter: async () => createPiConnectedServiceRuntimeAuthAdapter(),
  getConnectedServiceStateSharingDescriptor: async () => piConnectedServiceStateSharingDescriptor,
  // Pi account switching is restart/rematerialize-only: predictive (soft-threshold)
  // switches are suppressed by declared contract.
  getConnectedServiceRecoveryCapabilities: async () => ({ predictiveSoftSwitch: { mode: 'unsupported' } }),
  getSessionUsageLimitRecoveryControlAdapter: async () => piUsageLimitRecoveryControlAdapter,
  resolveConnectedServiceSwitchContinuity: async (params) => resolvePiConnectedServiceSwitchContinuity(params),
  resolveConnectedServiceCandidatePersistedSessionFile: ({ metadata }) =>
    resolvePiConnectedServiceCandidatePersistedSessionFile({ metadata }),
  verifyResumeReachable: async (input) =>
    (await import('./connectedServices/verifyResumeReachablePi')).verifyResumeReachablePi(input),
  vendorResumeSupport: AGENTS_CORE.pi.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createPiRpcBackend } = await import('./rpc/backend');
    return (opts) => ({ backend: createPiRpcBackend(opts) });
  },
  checklists,
} satisfies AgentCatalogEntry;
