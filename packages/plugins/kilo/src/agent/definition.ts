const KILO_AGENT_ID = 'kilo';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: KILO_AGENT_ID,
  core: {
    id: KILO_AGENT_ID,
    cliSubcommand: 'kilo',
    detectKey: 'kilo',
    flavorAliases: ['kilocode'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'kiloSessionId' },
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
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
});
