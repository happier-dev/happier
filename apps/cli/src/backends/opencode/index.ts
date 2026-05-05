import { AGENTS_CORE } from '@happier-dev/agents';

import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.opencode.id,
  cliSubcommand: AGENTS_CORE.opencode.cliSubcommand,
  getCliDetect: async () => (await import('@/agent/acp/catalog/builtIn/detect')).createBuiltInCliDetect('opencode'),
  getCliAuthSpec: async () => (await import('@/agent/acp/catalog/builtIn/auth')).createBuiltInCliAuthSpec('opencode'),
  getDirectSessionProviderOps: async () =>
    (await import('@/session/directSessions/providers/opencode/providerOps'))
      .openCodeDirectSessionProviderOps,
  getConnectedServicesMaterializer: async () =>
    (await import('@/daemon/connectedServices/materialize/providers/opencode/createOpenCodeConnectedServicesMaterializer'))
      .createOpenCodeConnectedServicesMaterializer(),
  getManagedServerLaunchSpec: async () =>
    (await import('@/packagedRuntime/managedTools/requireProviderCliLaunchSpec'))
      .requireProviderCliLaunchSpec('opencode'),
  getManagedServerShutdownCleanup: async () =>
    (await import('@/session/opencode/stopSharedManagedOpenCodeServer'))
      .stopSharedManagedOpenCodeServerBestEffort,
  getProviderAttachOps: async () =>
    (await import('./attach/providerAttachOps'))
      .openCodeProviderAttachOps,
  getProviderNativeForkHandler: async () =>
    (await import('@/session/fork/providers/opencode/providerNativeForkHandler'))
      .openCodeProviderNativeForkHandler,
  getAcpForkContinuationHandler: async () =>
    (await import('@/session/fork/providers/opencode/acpForkContinuationHandler'))
      .openCodeAcpForkContinuationHandler,
  getReplayForkContinuationHandler: async () =>
    (await import('@happier-dev/plugins-opencode'))
      .opencodeReplayForkContinuationHandler,
  getSessionHandoffProviderOps: async () =>
    (await import('@/session/handoff/providers/opencode/providerOps'))
      .openCodeSessionHandoffProviderOps,
  getPreflightSessionControlsProbeAdapter: async () => ({
    failureCacheStrategy: 'cooldown',
    cliModelsCommandArgs: ['models', '--verbose'],
  }),
  vendorResumeSupport: AGENTS_CORE.opencode.resume.vendorResume,
} satisfies AgentCatalogEntry;
