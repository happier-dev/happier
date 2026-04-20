import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import { geminiDaemonSpawnHooks } from './daemon/spawnHooks';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.gemini.id,
  cliSubcommand: AGENTS_CORE.gemini.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/gemini/cli/command')).handleGeminiCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/gemini/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/gemini/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/gemini/cli/auth/geminiCliAuthSpec')).geminiCliAuthSpec,
  getCloudConnectTarget: async () => (await import('@/backends/gemini/cloud/connect')).geminiCloudConnect,
  getDaemonSpawnHooks: async () => geminiDaemonSpawnHooks,
  getConnectedServicesMaterializer: async () =>
    (await import('@/backends/gemini/connectedServices/createGeminiConnectedServicesMaterializer'))
      .createGeminiConnectedServicesMaterializer(),
  getBindings: async () => {
    const { createGeminiBindings } = await import('@/backends/gemini/bindings/index');
    return () => createGeminiBindings();
  },
  vendorResumeSupport: AGENTS_CORE.gemini.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createGeminiBackend } = await import('@/backends/gemini/acp/backend');
    return (opts) => createGeminiBackend(opts);
  },
  checklists,
} satisfies AgentCatalogEntry;
