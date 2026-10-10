// Data-only facts consumed by the bundled Agent projection publisher.
export const AGENT_DEFINITION = Object.freeze({
  id: 'custom-acp',
  core: {
    id: 'custom-acp', cliSubcommand: 'custom-acp', detectKey: 'custom-acp', flavorAliases: [],
    cloudConnect: null, connectedServices: null,
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'acpSessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'native_mcp', support: 'experimental' },
  },
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  sessionModesKind: 'acpAgentModes',
  modelConfig: { supportsSelection: true, nonAcpApplyScope: 'next_prompt', defaultMode: 'default', allowedModes: ['default'] },
});
