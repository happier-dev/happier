// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: 'droid',
  acpRegistryIds: ['factory-droid'] as const,
  core: {
    id: 'droid',
    cliSubcommand: 'droid',
    detectKey: 'droid',
    flavorAliases: ['factory', 'factory-droid'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'droidSessionId' },
    sessionStorage: { direct: true, persisted: true },
    sessionCapabilities: {
      // Factory documents `droid exec -s/--session-id <id>` for continuing a
      // session, but publishes no session-listing surface, so this stays
      // unsupported until a live `session/list` round trip proves otherwise.
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
    runtimeInput: { inFlightSteerSupported: false, terminalPromptInjectionSupported: false },
    tools: { delivery: 'native_mcp', support: 'supported' },
  },
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' } as const,
  sessionModesKind: 'acpAgentModes',
  modelConfig: {
    supportsSelection: true,
    // Process-scoped customModels accepts exact upstream ids which the native
    // preflight catalog cannot list before a Provider/account is materialized.
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'set_model',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
});
