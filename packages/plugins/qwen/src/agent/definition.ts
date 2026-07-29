const QWEN_AGENT_ID = 'qwen';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: QWEN_AGENT_ID,
  core: {
    id: QWEN_AGENT_ID,
    cliSubcommand: 'qwen',
    detectKey: 'qwen',
    flavorAliases: ['qwen-code'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported', vendorResumeIdField: 'qwenSessionId' },
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
    dynamicProbe: 'static-only',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
});
