import type { AgentCatalogEntry } from '../types';

import { createBuiltInEntry } from '@/agent/acp/catalog/builtIn/entry';

export const agent = createBuiltInEntry('ohMyPi', {
  getDirectSessionProviderOps: async () =>
    (await import('@/backends/ohMyPi/directSessions/providerOps')).ohMyPiDirectSessionProviderOps,
  getConnectedServicesMaterializer: async () =>
    (await import('@/backends/ohMyPi/connectedServices/createOhMyPiConnectedServicesMaterializer'))
      .createOhMyPiConnectedServicesMaterializer(),
  getTerminalRuntimeOps: async () =>
    (await import('@/backends/ohMyPi/terminalRuntime/ohMyPiTerminalRuntimeOps')).ohMyPiTerminalRuntimeOps,
}) satisfies AgentCatalogEntry;
