const QWEN_AGENT_ID = 'qwen';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: QWEN_AGENT_ID,
  acpRegistryIds: ['qwen-code'] as const,
  core: {
    id: QWEN_AGENT_ID,
    cliSubcommand: 'qwen',
    detectKey: 'qwen',
    flavorAliases: ['qwen-code'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'qwenSessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'supported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'native_mcp', support: 'experimental' },
  },
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' } as const,
  sessionModesKind: 'acpAgentModes',
  modelConfig: {
    supportsSelection: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'static-only',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
});
