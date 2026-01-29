import { AGENTS_CORE } from '@happy/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.kimi.id,
  cliSubcommand: AGENTS_CORE.kimi.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/kimi/cli/command')).handleKimiCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/kimi/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/kimi/cli/detect')).cliDetect,
  vendorResumeSupport: AGENTS_CORE.kimi.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createKimiBackend } = await import('@/backends/kimi/acp/backend');
    return (opts) => ({ backend: createKimiBackend(opts as any) });
  },
  checklists,
} satisfies AgentCatalogEntry;

