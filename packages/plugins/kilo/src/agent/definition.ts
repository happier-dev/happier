const KILO_AGENT_ID = 'kilo';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: KILO_AGENT_ID,
  core: {
    id: KILO_AGENT_ID,
    cliSubcommand: 'kilo',
    detectKey: 'kilo',
    flavorAliases: ['kilocode'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported', vendorResumeIdField: 'kiloSessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'shell_bridge', support: 'experimental' },
  },
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  sessionModesKind: 'acpAgentModes',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  authProbeConfig: {
    agentId: KILO_AGENT_ID,
    binaryNames: ['kilo'],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  localCli: {
    agentId: KILO_AGENT_ID,
    detectKey: 'kilo',
    machineLoginKey: 'kilo',
    supportKind: 'login_terminal',
    loginLaunch: {
      command: 'kilo',
      args: [],
      initialInput: '/connect\r',
    },
  },
  agentCliRuntime: {
    id: KILO_AGENT_ID,
    title: 'Kilo CLI',
    binaryName: 'kilo',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@kilocode/cli',
      binaryName: 'kilo',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: null,
    docsUrl: 'https://kilo.ai/docs/cli',
  },
  providerSettings: null,
  runtimeContributions: {
    providerCatalogEntry: {
      importName: 'KILO_PROVIDER_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
  },
});
