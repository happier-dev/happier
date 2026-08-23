const COPILOT_AGENT_ID = 'copilot';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: COPILOT_AGENT_ID,
  core: {
    id: COPILOT_AGENT_ID,
    cliSubcommand: 'copilot',
    detectKey: 'copilot',
    flavorAliases: ['github-copilot', 'copilot-cli'],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported', vendorResumeIdField: 'copilotSessionId' },
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
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
});
