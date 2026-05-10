import type { AgentCatalogEntry } from '../types';

import { createBuiltInEntry } from '@/agent/acp/catalog/builtIn/entry';

export const agent = createBuiltInEntry('ohMyPi', {
  getExternalSessionProviderOps: async () =>
    (await import('@/backends/ohMyPi/externalSessions/providerOps')).ohMyPiExternalSessionProviderOps,
  getConnectedServicesMaterializer: async () =>
    (await import('@/backends/ohMyPi/connectedServices/createOhMyPiConnectedServicesMaterializer'))
      .createOhMyPiConnectedServicesMaterializer(),
  getTerminalRuntimeOps: async () =>
    (await import('@/backends/ohMyPi/terminalRuntime/ohMyPiTerminalRuntimeOps')).ohMyPiTerminalRuntimeOps,
}) satisfies AgentCatalogEntry;
