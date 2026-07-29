const KIRO_AGENT_ID = 'kiro';

export const AGENT_DEFINITION = Object.freeze({
  id: KIRO_AGENT_ID,
  core: {
    id: KIRO_AGENT_ID,
    cliSubcommand: 'kiro',
    detectKey: 'kiro-cli',
    flavorAliases: ['kiro-cli'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'experimental', vendorResumeIdField: 'kiroSessionId' },
    sessionStorage: { direct: true, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    localControl: { supported: true, topology: 'exclusive', attachStrategy: 'unsupported' },
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
    dynamicProbe: 'static-only',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'KIRO_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
  },
});
