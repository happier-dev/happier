import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.pi.id,
  cliSubcommand: AGENTS_CORE.pi.cliSubcommand,
  getCliCommandHandler: async () => (await import('./cli/command')).handlePiCliCommand,
  getCliCapabilityOverride: async () => (await import('./cli/capability')).cliCapability,
  getCliDetect: async () => (await import('./cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('./cli/auth/piCliAuthSpec')).piCliAuthSpec,
  getRuntimeCore: async () => (await import('./runtimeCore/index')).createPiRuntimeCore(),
  getConnectedServicesMaterializer: async () =>
    (await import('./connectedServices/createPiConnectedServicesMaterializer'))
      .createPiConnectedServicesMaterializer(),
  vendorResumeSupport: AGENTS_CORE.pi.resume.vendorResume,
  getPreflightSessionControlsProbeAdapter: async () =>
    (await import('./preflight/piPreflightModelsProbeAdapter')).piPreflightModelsProbeAdapter,
  getAcpBackendFactory: async () => {
    const { createPiRpcBackend } = await import('./rpc/backend');
    return (opts) => ({ backend: createPiRpcBackend(opts) });
  },
  checklists,
} satisfies AgentCatalogEntry;
