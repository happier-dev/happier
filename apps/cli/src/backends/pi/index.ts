import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.pi.id,
  cliSubcommand: AGENTS_CORE.pi.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/pi/cli/command')).handlePiCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/pi/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/pi/cli/detect')).cliDetect,
  vendorResumeSupport: AGENTS_CORE.pi.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createPiBackend } = await import('@/backends/pi/acp/backend');
    return (opts) => ({ backend: createPiBackend(opts as any) });
  },
  checklists,
} satisfies AgentCatalogEntry;
