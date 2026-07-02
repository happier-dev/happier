import type { AgentCatalogEntry } from '../types';

import { createBuiltInEntry } from '@/agent/acp/catalog/builtIn/entry';
import { createOhMyPiConnectedServiceRuntimeAuthAdapter } from '@/backends/ohMyPi/connectedServices/createOhMyPiConnectedServiceRuntimeAuthAdapter';
import { createOhMyPiConnectedServicesMaterializer } from '@/backends/ohMyPi/connectedServices/createOhMyPiConnectedServicesMaterializer';
import { ohMyPiConnectedServiceStateSharingDescriptor } from '@/backends/ohMyPi/connectedServices/ohMyPiConnectedServiceStateSharingDescriptor';
import { resolveOhMyPiConnectedServiceSwitchContinuity } from '@/backends/ohMyPi/connectedServices/resolveOhMyPiConnectedServiceSwitchContinuity';

export const agent = createBuiltInEntry('ohMyPi', {
  getExternalSessionProviderOps: async () =>
    (await import('@/backends/ohMyPi/externalSessions/providerOps')).ohMyPiExternalSessionProviderOps,
  getConnectedServicesMaterializer: async () => createOhMyPiConnectedServicesMaterializer(),
  getConnectedServiceRuntimeAuthAdapter: async () => createOhMyPiConnectedServiceRuntimeAuthAdapter(),
  getConnectedServiceStateSharingDescriptor: async () => ohMyPiConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceSwitchContinuity: async (params) => resolveOhMyPiConnectedServiceSwitchContinuity(params),
  verifyResumeReachable: async (input) =>
    (await import('@/backends/ohMyPi/connectedServices/verifyResumeReachableOhMyPi')).verifyResumeReachableOhMyPi(input),
  getTerminalRuntimeOps: async () =>
    (await import('@/backends/ohMyPi/terminalRuntime/ohMyPiTerminalRuntimeOps')).ohMyPiTerminalRuntimeOps,
}) satisfies AgentCatalogEntry;
