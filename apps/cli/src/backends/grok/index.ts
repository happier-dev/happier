import { AGENTS_CORE } from '@happier-dev/agents';

import { createCatalogDefinedCliDetect } from '@/agent/acp/catalog/createCatalogDefinedCliDetect';
import type { AgentCatalogEntry } from '@/backends/types';

import type { GrokBackendOptions } from './acp/backend';

export const agent = {
  id: AGENTS_CORE.grok.id,
  cliSubcommand: AGENTS_CORE.grok.cliSubcommand,
  getCliCommandHandler: async () => async (context) => {
    const { handleCatalogDefinedAcpCliCommand } = await import(
      '@/agent/acp/catalog/handleCatalogDefinedAcpCliCommand'
    );
    await handleCatalogDefinedAcpCliCommand('grok', context);
  },
  getCliDetect: async () => createCatalogDefinedCliDetect('grok'),
  getCliAuthSpec: async () => (await import('./cli/auth/grokCliAuthSpec')).grokCliAuthSpec,
  getCliCapabilityOverride: async () => (await import('./cli/capability')).cliCapability,
  vendorResumeSupport: AGENTS_CORE.grok.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createGrokBackend } = await import('./acp/backend');
    return (options) => ({ backend: createGrokBackend(options as GrokBackendOptions) });
  },
  getAcpRuntimeBackendOptionsResolver: async () => {
    const { createGrokSessionNotificationObserverForSession } = await import(
      './acp/sessionNotificationRuntime'
    );
    return ({ session }) => ({
      sessionNotificationObserver: createGrokSessionNotificationObserverForSession(session),
    });
  },
} satisfies AgentCatalogEntry;
