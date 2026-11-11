const KILO_AGENT_ID = 'kilo';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: KILO_AGENT_ID,
  acpRegistryIds: ['kilo'] as const,
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
    tools: { delivery: 'native_mcp', support: 'experimental',
      mcpToolControl: { off: 'blocked' as const, approval: 'host' as const } },
  },
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' } as const,
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
