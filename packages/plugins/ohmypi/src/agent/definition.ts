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
    },
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'ohMyPiSessionId' },
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
} as const);
