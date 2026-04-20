import type { AgentDefinition } from '@happier-dev/agents';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION: AgentDefinition = Object.freeze({
  id: '__extensionId__',
  core: {
    id: '__extensionId__',
    cliSubcommand: '__extensionId__',
    detectKey: '__extensionId__',
    resume: { vendorResume: 'unsupported', vendorResumeIdField: null },
    sessionStorage: { direct: false, persisted: false },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'unsupported', support: 'unsupported' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: false,
    nonAcpApplyScope: 'spawn_only',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  authProbeConfig: {
    agentId: '__extensionId__',
    binaryNames: ['__extensionId__'],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  localCli: {
    agentId: '__extensionId__',
    detectKey: '__extensionId__',
    machineLoginKey: '__extensionId__',
    supportKind: 'unsupported',
    loginLaunch: null,
  },
  providerCliRuntime: {
    id: '__extensionId__',
    title: '__extensionId__ CLI',
    binaryName: '__extensionId__',
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'none',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
  },
  providerSettings: null,
});
