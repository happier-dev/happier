import type { AgentCatalogEntry } from '@/backends/types';

import { createCatalogDefinedAcpEntry } from './createCatalogDefinedAcpEntry';

export const BUILT_IN_CATALOG_DEFINED_ACP_AGENTS = {
  customAcp: createCatalogDefinedAcpEntry('customAcp'),
  kiro: createCatalogDefinedAcpEntry('kiro'),
  ohMyPi: createCatalogDefinedAcpEntry('ohMyPi', {
    getDirectSessionProviderOps: async () =>
      (await import('@/backends/ohMyPi/directSessions/providerOps')).ohMyPiDirectSessionProviderOps,
    getConnectedServicesSpawnMaterializer: async () =>
      (await import('@/backends/ohMyPi/connectedServices/createOhMyPiConnectedServicesSpawnMaterializer'))
        .createOhMyPiConnectedServicesSpawnMaterializer(),
    getTerminalRuntimeOps: async () =>
      (await import('@/backends/ohMyPi/terminalRuntime/ohMyPiTerminalRuntimeOps')).ohMyPiTerminalRuntimeOps,
  }),
} as const satisfies Record<'customAcp' | 'kiro' | 'ohMyPi', AgentCatalogEntry>;
