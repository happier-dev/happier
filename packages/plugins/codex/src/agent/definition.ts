// IMPORTANT: this must stay JSON-serializable (data-only).
const CODEX_AGENT_ID = 'codex';

export const AGENT_DEFINITION = Object.freeze({
  id: CODEX_AGENT_ID,
  core: {
    id: CODEX_AGENT_ID,
    cliSubcommand: 'codex',
    detectKey: 'codex',
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
    agentId: 'codex',
    binaryNames: ['codex'],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  localCli: {
    agentId: 'codex',
    detectKey: 'codex',
    machineLoginKey: 'codex',
    supportKind: 'unsupported',
    loginLaunch: null,
  },
  providerCliRuntime: {
    id: CODEX_AGENT_ID,
    title: 'codex CLI',
    binaryName: 'codex',
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'none',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
  },
  providerSettings: null,
});
