import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import { opencodeDaemonSpawnHooks } from '@/backends/opencode/daemon/spawnHooks';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.opencode.id,
  cliSubcommand: AGENTS_CORE.opencode.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/opencode/cli/command')).handleOpenCodeCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/opencode/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/opencode/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/opencode/cli/auth/opencodeCliAuthSpec')).opencodeCliAuthSpec,
  getDaemonSpawnHooks: async () => opencodeDaemonSpawnHooks,
  getDirectSessionProviderOps: async () => (await import('@/backends/opencode/directSessions/providerOps')).openCodeDirectSessionProviderOps,
  getProviderAttachOps: async () => (await import('@/backends/opencode/attach/providerAttachOps')).openCodeProviderAttachOps,
  vendorResumeSupport: AGENTS_CORE.opencode.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createOpenCodeBackend } = await import('@/backends/opencode/acp/backend');
    return (opts) => ({ backend: createOpenCodeBackend(opts as any) });
  },
  getAcpForkContinuationHandler: async () => (await import('@/backends/opencode/acp/forkContinuationHandler')).openCodeAcpForkContinuationHandler,
  getProviderNativeForkHandler: async () => (await import('@/backends/opencode/server/providerNativeForkHandler')).openCodeProviderNativeForkHandler,
  checklists,
} satisfies AgentCatalogEntry;
