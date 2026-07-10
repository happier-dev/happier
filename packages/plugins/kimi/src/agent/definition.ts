const KIMI_AGENT_ID = 'kimi';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: KIMI_AGENT_ID,
  core: {
    id: KIMI_AGENT_ID,
    cliSubcommand: 'kimi',
    detectKey: 'kimi',
    flavorAliases: ['kimi-cli'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported', vendorResumeIdField: 'kimiSessionId' },
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
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  authProbeConfig: {
    agentId: KIMI_AGENT_ID,
    binaryNames: ['kimi'],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  localCli: {
    agentId: KIMI_AGENT_ID,
    detectKey: 'kimi',
    machineLoginKey: 'kimi',
    supportKind: 'login_terminal',
    loginLaunch: {
      command: 'kimi',
      args: ['login'],
    },
  },
  agentCliRuntime: {
    id: KIMI_AGENT_ID,
    title: 'Kimi CLI',
    binaryName: 'kimi',
    knownUserBinDirSuffixes: ['.local/bin'],
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: {
      darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://code.kimi.com/install.sh | bash'] }],
      linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://code.kimi.com/install.sh | bash'] }],
      win32: [{
        cmd: 'powershell',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression',
        ],
      }],
    },
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: 'https://kimi.moonshot.cn/docs/cli',
    docsUrl: 'https://code.kimi.com',
  },
  agentSettings: null,
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'KIMI_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
  },
});
