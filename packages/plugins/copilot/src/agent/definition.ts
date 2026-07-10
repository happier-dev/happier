const COPILOT_AGENT_ID = 'copilot';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: COPILOT_AGENT_ID,
  core: {
    id: COPILOT_AGENT_ID,
    cliSubcommand: 'copilot',
    detectKey: 'copilot',
    flavorAliases: ['github-copilot', 'copilot-cli'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported', vendorResumeIdField: 'copilotSessionId' },
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
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  authProbeConfig: {
    agentId: COPILOT_AGENT_ID,
    binaryNames: ['copilot'],
    statusCommand: null,
    parser: 'copilotGhAuth',
    backgroundChecks: 'safe',
    envVars: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  },
  localCli: {
    agentId: COPILOT_AGENT_ID,
    detectKey: 'copilot',
    machineLoginKey: 'copilot',
    supportKind: 'login_terminal',
    loginLaunch: {
      command: 'copilot',
      args: ['login'],
    },
  },
  agentCliRuntime: {
    id: COPILOT_AGENT_ID,
    title: 'GitHub Copilot CLI',
    binaryName: 'copilot',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@github/copilot',
      binaryName: 'copilot',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: null,
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
  },
  agentSettings: null,
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'COPILOT_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
  },
});
