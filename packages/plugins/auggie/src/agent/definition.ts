const AUGGIE_AGENT_ID = 'auggie';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: AUGGIE_AGENT_ID,
  core: {
    id: AUGGIE_AGENT_ID,
    cliSubcommand: 'auggie',
    detectKey: 'auggie',
    flavorAliases: [],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported', vendorResumeIdField: 'auggieSessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'shell_bridge', support: 'experimental' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  authProbeConfig: {
    agentId: AUGGIE_AGENT_ID,
    binaryNames: ['auggie'],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  localCli: {
    agentId: AUGGIE_AGENT_ID,
    detectKey: 'auggie',
    machineLoginKey: 'auggie',
    supportKind: 'login_terminal',
    loginLaunch: {
      command: 'auggie',
      args: ['login'],
    },
  },
  agentCliRuntime: {
    id: AUGGIE_AGENT_ID,
    title: 'Auggie CLI',
    binaryName: 'auggie',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@augmentcode/auggie',
      binaryName: 'auggie',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    docsUrl: 'https://augmentcode.com',
  },
  providerSettings: null,
});
