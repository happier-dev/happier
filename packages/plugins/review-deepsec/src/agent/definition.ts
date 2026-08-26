const DEEPSEC_AGENT_ID = 'deepsec';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: DEEPSEC_AGENT_ID,
  core: {
    id: DEEPSEC_AGENT_ID,
    cliSubcommand: 'deepsec',
    detectKey: 'deepsec',
    flavorAliases: [],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'unsupported' as const },
    sessionStorage: { direct: false, persisted: false },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'unsupported', support: 'unsupported' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: false,
    nonAcpApplyScope: 'next_prompt',
    dynamicProbe: 'static-only',
    defaultMode: 'review',
    allowedModes: ['review', 'repository_security_audit'],
  },
});
