const OH_MY_PI_AGENT_ID = 'ohMyPi';

const BUN_INSTALL_RECIPE = Object.freeze([{
  cmd: 'bun',
  args: ['install', '-g', '@oh-my-pi/pi-coding-agent'],
}]);

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: OH_MY_PI_AGENT_ID,
  core: {
    id: OH_MY_PI_AGENT_ID,
    cliSubcommand: 'ohMyPi',
    detectKey: 'omp',
    flavorAliases: ['oh-my-pi', 'omp'],
    cloudConnect: null,
    connectedServices: {
      supportedServiceIds: ['openai-codex', 'openai', 'claude-subscription', 'anthropic', 'gemini'],
      supportedKindsByServiceId: {
        'openai-codex': ['oauth'],
        openai: ['token'],
        'claude-subscription': ['token'],
        anthropic: ['token'],
        gemini: ['token'],
      },
    },
    resume: { vendorResume: 'supported', vendorResumeIdField: 'ohMyPiSessionId' },
    sessionStorage: { direct: true, persisted: true },
    sessionCapabilities: {
      sessionListing: 'supported',
      sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'native_mcp', support: 'supported' },
  },
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  sessionModesKind: 'acpAgentModes',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'set_model',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  authProbeConfig: {
    agentId: OH_MY_PI_AGENT_ID,
    binaryNames: ['omp'],
    statusCommand: null,
    parser: 'piEnvOnly',
    backgroundChecks: 'safe',
    envVars: [
      'OPENAI_CODEX_OAUTH_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
    ],
  },
  localCli: {
    agentId: OH_MY_PI_AGENT_ID,
    detectKey: 'omp',
    machineLoginKey: 'oh-my-pi',
    supportKind: 'manual_only',
    loginLaunch: null,
  },
  agentCliRuntime: {
    id: OH_MY_PI_AGENT_ID,
    title: 'oh-my-pi CLI',
    binaryName: 'omp',
    knownUserBinDirSuffixes: ['.bun/bin'],
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'github_release_binary',
      githubRepo: 'can1357/oh-my-pi',
      binaryName: 'omp',
    },
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: {
      darwin: BUN_INSTALL_RECIPE,
      linux: BUN_INSTALL_RECIPE,
      win32: BUN_INSTALL_RECIPE,
    },
    acceptsJavaScriptFileOverride: true,
    installGuideUrl: 'https://github.com/can1357/oh-my-pi#via-bun-recommended',
    docsUrl: 'https://github.com/can1357/oh-my-pi',
  },
  builtInAcpConfig: {
    agentId: OH_MY_PI_AGENT_ID,
    launcher: {
      command: 'omp',
      args: ['--mode', 'acp'],
    },
    transportProfile: 'generic',
    supportsLoadSession: true,
    supportsModes: 'yes',
    supportsModels: 'yes',
    promptImageSupport: 'yes',
  },
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
  },
  agentSettings: null,
});
