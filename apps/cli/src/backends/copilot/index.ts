import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.copilot.id,
  cliSubcommand: AGENTS_CORE.copilot.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/copilot/cli/command')).handleCopilotCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/copilot/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/copilot/cli/detect')).cliDetect,
  vendorResumeSupport: AGENTS_CORE.copilot.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createCopilotBackend } = await import('@/backends/copilot/acp/backend');
    return (opts) => ({ backend: createCopilotBackend(opts as any) });
  },
  checklists,
} satisfies AgentCatalogEntry;
