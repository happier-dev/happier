const OH_MY_PI_AGENT_ID = 'ohMyPi';

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
});
