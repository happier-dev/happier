const ROBOREV_AGENT_ID = 'roborev';

export const AGENT_DEFINITION = Object.freeze({
  id: ROBOREV_AGENT_ID,
  core: {
    id: ROBOREV_AGENT_ID, cliSubcommand: ROBOREV_AGENT_ID, detectKey: ROBOREV_AGENT_ID,
    flavorAliases: [], cloudConnect: null, connectedServices: null,
    resume: { vendorResume: 'unsupported' as const },
    sessionStorage: { direct: false, persisted: false },
    sessionCapabilities: {
      sessionListing: 'unsupported', sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' }, tools: { delivery: 'unsupported', support: 'unsupported' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' } as const,
  sessionModesKind: 'none',
  modelConfig: { supportsSelection: true, supportsFreeform: true, nonAcpApplyScope: 'next_prompt', dynamicProbe: 'static-only',
    defaultMode: 'review', allowedModes: ['review'] },
});
