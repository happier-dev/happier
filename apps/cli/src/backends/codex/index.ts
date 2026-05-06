import { AGENTS_CORE } from '@happier-dev/agents';
import { resolveCodexSessionBackendMode } from '@happier-dev/agents';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import { checklists } from './cli/checklists';
import { supportsCodexVendorResume } from './resume/vendorResumeSupport';
import { codexDaemonSpawnHooks } from './daemon/spawnHooks';
import { readCodexEnvironmentAuthState } from './cli/auth/readCodexEnvironmentAuthState';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.codex.id,
  cliSubcommand: AGENTS_CORE.codex.cliSubcommand,
  getCliCommandHandler: async () => (await import('./cli/command')).handleCodexCliCommand,
  getCliCapabilityOverride: async () => (await import('./cli/capability')).cliCapability,
  getCapabilities: async () => (await import('./cli/extraCapabilities')).capabilities,
  getCliDetect: async () => (await import('./cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('./cli/auth/codexCliAuthSpec')).codexCliAuthSpec,
  getCloudConnectTarget: async () => (await import('./cloud/connect')).codexCloudConnect,
  getDaemonSpawnHooks: async () => codexDaemonSpawnHooks,
  getDirectSessionProviderOps: async () => (await import('./externalSessions/providerOps')).codexDirectSessionProviderOps,
  getConnectedServicesMaterializer: async () =>
    (await import('./connectedServices/createCodexConnectedServicesMaterializer'))
      .createCodexConnectedServicesMaterializer(),
  getRuntimeCore: async () => (await import('./runtimeCore')).createCodexRuntimeCore,
  getSessionHandoffProviderOps: async () => (await import('./handoff/providerOps')).codexSessionHandoffProviderOps,
  getTerminalRuntimeOps: async () => (await import('./terminalRuntime/codexTerminalRuntimeOps')).codexTerminalRuntimeOps,
  vendorResumeSupport: AGENTS_CORE.codex.resume.vendorResume,
  getVendorResumeSupport: async () => supportsCodexVendorResume,
  getAcpBackendFactory: async () => {
    const { createCodexAcpBackend } = await import('./acp/backend');
    return (opts) => createCodexAcpBackend(opts);
  },
  getAcpForkContinuationHandler: async () => (await import('./acp/forkContinuationHandler')).codexAcpForkContinuationHandler,
  getProviderNativeForkHandler: async () => (await import('./appServer/providerNativeForkHandler')).codexAppServerProviderNativeForkHandler,
  needsAccountSettingsForProbes: true,
  resolveModelsProbeVariant: ({ accountSettings }) => {
    // Keep dynamic model probes cache-partitioned by runtime flavor (appServer vs ACP vs MCP).
    const backendMode =
      resolveCodexSessionBackendMode({ metadata: null, accountSettings: accountSettings ?? null }) ?? 'appServer';
    // Speed eligibility is auth-dependent; include auth method to avoid stale modelOptions.
    const authMethod = readCodexEnvironmentAuthState().method ?? 'unknown';
    return `codex:${backendMode}:${authMethod}`;
  },
  getPreflightSessionControlsProbeAdapter: async () =>
    (await import('./preflight/codexPreflightSessionControlsProbeAdapter')).codexPreflightSessionControlsProbeAdapter,
  checklists,
  runtimeInstallableKeys: [INSTALLABLE_KEYS.CODEX_ACP],
} satisfies AgentCatalogEntry;
