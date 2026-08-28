const CURSOR_AGENT_ID = 'cursor';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: CURSOR_AGENT_ID,
  core: {
    id: CURSOR_AGENT_ID,
    cliSubcommand: 'cursor',
    detectKey: 'cursor-agent',
    flavorAliases: ['cursor-agent'],
    cloudConnect: null,
    connectedServices: null,
    resume: {
      vendorResume: 'experimental' as const,
      vendorResumeIdField: 'cursorSessionId',
      experimentalResumePolicy: 'runtime_checked',
    },
    sessionStorage: { direct: true, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    localControl: { supported: true, topology: 'exclusive', attachStrategy: 'unsupported' },
    tools: { delivery: 'shell_bridge', support: 'experimental' },
  },
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  sessionModesKind: 'acpAgentModes',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'set_model',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'composer-2.5-fast',
    allowedModes: ['composer-2.5-fast'],
    staticModels: [{
      id: 'composer-2.5-fast',
      name: 'Composer 2.5 Fast',
      description: 'Cursor Composer 2.5 fast model, discovered dynamically when the Cursor CLI is available.',
    }],
  },
});
