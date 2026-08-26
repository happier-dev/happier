const AUGGIE_AGENT_ID = 'auggie';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: AUGGIE_AGENT_ID,
  core: {
    id: AUGGIE_AGENT_ID,
    cliSubcommand: 'auggie',
    detectKey: 'auggie',
    flavorAliases: [],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'auggieSessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'shell_bridge', support: 'experimental' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'AUGGIE_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/catalog',
    },
  },
});
