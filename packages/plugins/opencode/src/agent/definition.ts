// IMPORTANT: this must stay JSON-serializable (data-only).
const OPENCODE_AGENT_ID = 'opencode';

export const AGENT_DEFINITION = Object.freeze({
  id: OPENCODE_AGENT_ID,
  core: {
    id: OPENCODE_AGENT_ID,
    cliSubcommand: 'opencode',
    detectKey: 'opencode',
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
    agentId: 'opencode',
    binaryNames: ['opencode'],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  localCli: {
    agentId: 'opencode',
    detectKey: 'opencode',
    machineLoginKey: 'opencode',
    supportKind: 'unsupported',
    loginLaunch: null,
  },
  providerCliRuntime: {
    id: OPENCODE_AGENT_ID,
    title: 'opencode CLI',
    binaryName: 'opencode',
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'none',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
  },
  providerSettings: null,
});
