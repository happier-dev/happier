import { AGENTS_CORE } from '@happier-dev/agents';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import { checklists } from './cli/checklists';
import { supportsCodexVendorResume } from './resume/vendorResumeSupport';
import { codexDaemonSpawnHooks } from '@/backends/codex/daemon/spawnHooks';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.codex.id,
  cliSubcommand: AGENTS_CORE.codex.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/codex/cli/command')).handleCodexCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/codex/cli/capability')).cliCapability,
  getCapabilities: async () => (await import('@/backends/codex/cli/extraCapabilities')).capabilities,
  getCliDetect: async () => (await import('@/backends/codex/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/codex/cli/auth/codexCliAuthSpec')).codexCliAuthSpec,
  getCloudConnectTarget: async () => (await import('@/backends/codex/cloud/connect')).codexCloudConnect,
  getDaemonSpawnHooks: async () => codexDaemonSpawnHooks,
  getDirectSessionProviderOps: async () => (await import('@/backends/codex/directSessions/providerOps')).codexDirectSessionProviderOps,
  vendorResumeSupport: AGENTS_CORE.codex.resume.vendorResume,
  getVendorResumeSupport: async () => supportsCodexVendorResume,
  getAcpBackendFactory: async () => {
    const { createCodexAcpBackend } = await import('@/backends/codex/acp/backend');
    return (opts) => createCodexAcpBackend(opts as any);
  },
  getAcpForkContinuationHandler: async () => (await import('@/backends/codex/acp/forkContinuationHandler')).codexAcpForkContinuationHandler,
  getProviderNativeForkHandler: async () => (await import('@/backends/codex/appServer/providerNativeForkHandler')).codexAppServerProviderNativeForkHandler,
  checklists,
  runtimeInstallableKeys: [INSTALLABLE_KEYS.CODEX_ACP],
} satisfies AgentCatalogEntry;
