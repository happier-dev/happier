const GROK_AGENT_ID = 'grok';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: GROK_AGENT_ID,
  core: {
    id: GROK_AGENT_ID,
    cliSubcommand: 'grok',
    detectKey: 'grok',
    flavorAliases: ['grok-build', 'grok-cli'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported', vendorResumeIdField: 'grokSessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'supported', fromMessage: 'supported' },
      sessionRollback: { conversation: 'supported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'native_mcp', support: 'experimental' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: true,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'set_model',
    dynamicProbe: 'auto',
    defaultMode: null,
    allowedModes: [],
  },
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'GROK_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
  },
});
