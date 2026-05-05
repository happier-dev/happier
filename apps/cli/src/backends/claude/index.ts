import { AGENTS_CORE } from '@happier-dev/agents';

import { claudeDaemonSpawnHooks } from './daemon/spawnHooks';
import { normalizeClaudeHappyCliSessionControlPermissionMode } from './utils/permissionMode';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.claude.id,
  cliSubcommand: AGENTS_CORE.claude.cliSubcommand,
  getCliCommandHandler: async () => (await import('./cli/command')).handleClaudeCliCommand,
  getCliCapabilityOverride: async () => (await import('./cli/capability')).cliCapability,
  getCliDetect: async () => (await import('./cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('./cli/auth/claudeCliAuthSpec')).claudeCliAuthSpec,
  getCloudConnectTarget: async () => (await import('./cloud/connect')).claudeCloudConnect,
  getDaemonSpawnHooks: async () => claudeDaemonSpawnHooks,
  getDirectSessionProviderOps: async () => (await import('./directSessions/providerOps')).claudeDirectSessionProviderOps,
  getConnectedServicesMaterializer: async () =>
    (await import('./connectedServices/createClaudeConnectedServicesMaterializer'))
      .createClaudeConnectedServicesMaterializer(),
  getRuntimeCore: async () => (await import('./runtimeCore/index')).createClaudeRuntimeCore,
  getSessionHandoffProviderOps: async () => (await import('./handoff/providerOps')).claudeSessionHandoffProviderOps,
  normalizeSessionControlPermissionMode: normalizeClaudeHappyCliSessionControlPermissionMode,
  getTerminalRuntimeOps: async () => (await import('./terminalRuntime/claudeTerminalRuntimeOps')).claudeTerminalRuntimeOps,
  vendorResumeSupport: AGENTS_CORE.claude.resume.vendorResume,
  getPreflightSessionControlsProbeAdapter: async () => (await import('./preflight/claudePreflightModelsProbeAdapter')).claudePreflightModelsProbeAdapter,
  getHeadlessTmuxArgvTransform: async () => (await import('../../terminal/tmux/headlessArgs')).ensureHeadlessTmuxRemoteStartingModeArgs,
} satisfies AgentCatalogEntry;
