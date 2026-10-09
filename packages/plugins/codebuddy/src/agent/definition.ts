const CODEBUDDY_AGENT_ID = 'codebuddy';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: CODEBUDDY_AGENT_ID,
  core: {
    id: CODEBUDDY_AGENT_ID,
    cliSubcommand: 'codebuddy',
    detectKey: 'codebuddy',
    flavorAliases: ['codebuddy-code'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'codebuddySessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
    runtimeInput: {
      inFlightSteerSupported: false,
      terminalPromptInjectionSupported: false,
    },
    tools: { delivery: 'native_mcp', support: 'experimental' },
    media: {
      acceptsImageInput: 'experimental',
      emitsSessionMedia: 'supported',
      nativeImageGeneration: 'unsupported',
    },
  },
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  sessionModesKind: 'acpAgentModes',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: false,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'set_model',
    acpModelConfigOptionId: 'model',
    acpModelSetMethod: 'config_option',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
});
