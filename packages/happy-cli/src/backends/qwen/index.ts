import { AGENTS_CORE } from '@happy/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.qwen.id,
  cliSubcommand: AGENTS_CORE.qwen.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/qwen/cli/command')).handleQwenCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/qwen/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/qwen/cli/detect')).cliDetect,
  vendorResumeSupport: AGENTS_CORE.qwen.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createQwenBackend } = await import('@/backends/qwen/acp/backend');
    return (opts) => ({ backend: createQwenBackend(opts as any) });
  },
  checklists,
} satisfies AgentCatalogEntry;

