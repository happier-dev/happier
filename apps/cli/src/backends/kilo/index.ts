import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';
import type { PreflightModelsProbeAdapter } from '@/capabilities/probes/preflightModelsProbeAdapterTypes';

export const agent = {
  id: AGENTS_CORE.kilo.id,
  cliSubcommand: AGENTS_CORE.kilo.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/kilo/cli/command')).handleKiloCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/kilo/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/kilo/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/kilo/cli/auth/kiloCliAuthSpec')).kiloCliAuthSpec,
  vendorResumeSupport: AGENTS_CORE.kilo.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createKiloBackend } = await import('@/backends/kilo/acp/backend');
    return (opts) => ({ backend: createKiloBackend(opts as any) });
  },
  getPreflightModelsProbeAdapter: async () => {
    const adapter: PreflightModelsProbeAdapter = {
      failureCacheStrategy: 'cooldown',
      cliModelsCommandArgs: ['models'],
    };
    return adapter;
  },
  checklists,
} satisfies AgentCatalogEntry;
