// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: 'fx',
  core: {
    id: 'fx',
    cliSubcommand: 'fx',
    detectKey: 'fx',
    flavorAliases: ['vercel-fx'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'fxSessionId' },
    sessionStorage: { direct: true, persisted: true },
    sessionCapabilities: {
      // `fx acp` serves `session/list` alongside `session/new`, `session/load`
      // and `session/resume` (vercel-labs/fx `src/acp/server.zig`).
      sessionListing: 'supported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
    runtimeInput: { inFlightSteerSupported: true, terminalPromptInjectionSupported: false },
    tools: { delivery: 'native_mcp', support: 'supported' },
  },
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  sessionModesKind: 'acpAgentModes',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: false,
    nonAcpApplyScope: 'next_prompt',
    // Model selection uses session/set_config_option for this advertised id.
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
});
