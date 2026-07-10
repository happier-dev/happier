const PI_AGENT_ID = 'pi';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: PI_AGENT_ID,
  core: {
    id: PI_AGENT_ID,
    cliSubcommand: 'pi',
    detectKey: 'pi',
    flavorAliases: ['pi-coding-agent'],
    cloudConnect: null,
    connectedServices: {
      supportedServiceIds: ['openai-codex', 'openai', 'claude-subscription', 'anthropic'],
      sessionAuthSwitch: {
        continuityMode: 'restart_same_home',
        supportedTransitions: ['connected_to_connected'],
        providerStateSharingRequired: {
          supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
        },
      },
      providerStateSharing: {
        config: {
          supported: false,
          modes: ['isolated'],
          unavailableReason: 'not_implemented',
        },
        state: {
          supported: true,
          modes: ['isolated', 'shared'],
          sharedStatePrivacyRiskAcknowledgementRequired: true,
        },
      },
      supportedKindsByServiceId: {
        'openai-codex': ['oauth'],
        openai: ['token'],
        'claude-subscription': ['oauth', 'token'],
        anthropic: ['token'],
      },
    },
    resume: { vendorResume: 'supported', vendorResumeIdField: 'piSessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
      usageLimitRecovery: { checkNow: 'supported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    runtimeInput: {
      inFlightSteerSupported: true,
      terminalPromptInjectionSupported: false,
    },
    tools: { delivery: 'shell_bridge', support: 'experimental' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  authProbeConfig: {
    agentId: PI_AGENT_ID,
    binaryNames: ['pi'],
    statusCommand: null,
    parser: 'piEnvOnly',
    backgroundChecks: 'safe',
    envVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  },
  localCli: {
    agentId: PI_AGENT_ID,
    detectKey: 'pi',
    machineLoginKey: 'pi',
    supportKind: 'status_only',
    loginLaunch: null,
  },
  agentCliRuntime: {
    id: PI_AGENT_ID,
    title: 'Pi Coding Agent CLI',
    binaryName: 'pi',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@earendil-works/pi-coding-agent',
      binaryName: 'pi',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: 'https://github.com/badlogic/pi-mono',
    docsUrl: null,
  },
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'PI_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
    sessionControlAdapter: {
      kind: 'runtimeDescriptorResumeId',
      providerId: PI_AGENT_ID,
      absolutePathField: 'sessionFile',
      fallbackField: 'providerSessionId',
    },
    runtimeDescriptorReader: {
      kind: 'providerSessionId',
      providerId: PI_AGENT_ID,
      runtimeHandle: 'providerSessionId',
    },
    protocolRuntimeDescriptor: {
      kind: 'providerRuntimeDescriptorV1',
      providerId: PI_AGENT_ID,
      source: './protocol/runtimeDescriptorV1',
      buildFunction: 'buildPiAgentRuntimeDescriptorV1',
      canonicalReader: 'readCanonicalPiAgentRuntimeDescriptorV1',
    },
  },
  agentSettings: null,
} as const);
