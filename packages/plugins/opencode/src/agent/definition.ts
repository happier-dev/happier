const OPENCODE_AGENT_CORE = Object.freeze({
  id: 'opencode',
  cliSubcommand: 'opencode',
  detectKey: 'opencode',
  flavorAliases: ['open-code'],
  cloudConnect: null,
  connectedServices: {
    supportedServiceIds: ['openai-codex', 'openai', 'claude-subscription', 'anthropic'],
    sessionAuthSwitch: {
      continuityMode: 'restart_same_home',
      supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
    },
    supportedKindsByServiceId: {
      'openai-codex': ['oauth'],
      openai: ['token'],
      'claude-subscription': ['token'],
      anthropic: ['token'],
    },
  },
  resume: { vendorResume: 'supported', vendorResumeIdField: 'opencodeSessionId' },
  sessionStorage: { direct: true, persisted: true },
  sessionCapabilities: {
    sessionListing: 'supported',
    sessionFork: { conversation: 'supported', fromMessage: 'supported' },
    sessionRollback: { conversation: 'unsupported' },
    usageLimitRecovery: { checkNow: 'supported' },
  },
  runtimeKinds: {
    defaultKind: 'server',
    byKind: {
      server: { kind: 'server' },
      acp: {
        kind: 'acp',
        overrides: {
          sessionStorage: { direct: false },
          sessionCapabilities: {
            sessionFork: { fromMessage: 'unsupported' },
            usageLimitRecovery: { checkNow: 'unsupported' },
          },
          localControl: null,
        },
      },
    },
  },
  handoff: { vendorStateTransfer: 'supported' },
  localControl: {
    supported: true,
    topology: 'shared',
    attachStrategy: 'provider_attach',
    remoteWritable: true,
  },
  tools: { delivery: 'native_mcp', support: 'supported' },
});

const OPENCODE_AGENT_SESSION_MODE_DESCRIPTOR = Object.freeze({
  source: 'acp',
  semantics: 'agent-modes',
  runtimeSwitch: 'acp-setSessionMode',
});

const OPENCODE_AGENT_MODEL_CONFIG = Object.freeze({
  supportsSelection: true,
  supportsFreeform: true,
  nonAcpApplyScope: 'next_prompt',
  acpModelConfigOptionId: 'model',
  defaultMode: 'default',
  allowedModes: ['default'],
});

const OPENCODE_AGENT_AUTH_PROBE_CONFIG = Object.freeze({
  agentId: 'opencode',
  binaryNames: ['opencode'],
  statusCommand: ['auth', 'list'],
  parser: 'opencodeAuthList',
  backgroundChecks: 'safe',
});

const OPENCODE_AGENT_LOCAL_CLI = Object.freeze({
  agentId: 'opencode',
  detectKey: 'opencode',
  machineLoginKey: 'opencode',
  supportKind: 'login_terminal',
  loginLaunch: {
    command: 'opencode',
    args: ['auth', 'login'],
  },
});

const OPENCODE_AGENT_CLI_RUNTIME = Object.freeze({
  id: 'opencode',
  title: 'OpenCode CLI',
  binaryName: 'opencode',
  knownUserBinDirSuffixes: ['.opencode/bin', 'AppData/Roaming/npm'],
  sourcePreferenceDefault: 'system-first',
  managedInstall: null,
  manualInstallKind: 'vendor_recipe',
  manualInstallRecipes: {
    darwin: [{
      cmd: 'bash',
      args: ['-lc', 'curl -fsSL https://opencode.ai/install | bash'],
    }],
    linux: [{
      cmd: 'bash',
      args: ['-lc', 'curl -fsSL https://opencode.ai/install | bash'],
    }],
    win32: [{
      cmd: 'cmd.exe',
      args: ['/c', 'npm install -g opencode-ai'],
      note: null,
    }],
  },
  acceptsJavaScriptFileOverride: false,
  setupRecommendation: { order: 40 },
  installGuideUrl: 'https://opencode.ai/docs',
  docsUrl: 'https://opencode.ai',
});

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: 'opencode',
  core: OPENCODE_AGENT_CORE,
  sessionModeDescriptor: OPENCODE_AGENT_SESSION_MODE_DESCRIPTOR,
  sessionModesKind: 'acpAgentModes',
  modelConfig: OPENCODE_AGENT_MODEL_CONFIG,
  authProbeConfig: OPENCODE_AGENT_AUTH_PROBE_CONFIG,
  localCli: OPENCODE_AGENT_LOCAL_CLI,
  agentCliRuntime: OPENCODE_AGENT_CLI_RUNTIME,
  commandSurface: {
    rootHelpLabel: 'happier opencode',
    rootHelpDescription: 'Start OpenCode CLI',
    allowTmux: true,
  },
  providerSettings: null,
  runtimeContributions: {
    providerCatalogEntry: {
      importName: 'OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
    sessionControlAdapter: {
      kind: 'providerSessionControlAdapter',
      providerId: 'opencode',
      source: './agent/surfaces/sessions/controls/adapter',
      exportName: 'OPENCODE_SESSION_CONTROL_ADAPTER',
    },
    runtimeDescriptorReader: {
      kind: 'providerRuntimeDescriptorReader',
      providerId: 'opencode',
      source: './agent/identity/runtimeDescriptor',
      exportName: 'readOpenCodeSessionMetadataRuntimeDescriptor',
    },
    protocolRuntimeDescriptor: {
      kind: 'providerRuntimeDescriptorV1',
      providerId: 'opencode',
      source: './protocol/runtimeDescriptorV1',
      buildFunction: 'buildOpenCodeAgentRuntimeDescriptorV1',
      canonicalReader: 'readCanonicalOpenCodeAgentRuntimeDescriptorV1',
    },
    protocolExternalSessionSource: {
      kind: 'providerExternalSessionSourceV1',
      providerId: 'opencode',
      source: './protocol/externalSession',
      exportName: 'OPENCODE_EXTERNAL_SESSION_SOURCE',
    },
  },
});
