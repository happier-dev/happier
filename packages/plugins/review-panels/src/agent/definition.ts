const PANELS_AGENT_ID = 'panels';

export const AGENT_DEFINITION = Object.freeze({
  id: PANELS_AGENT_ID,
  core: {
    id: PANELS_AGENT_ID, cliSubcommand: PANELS_AGENT_ID, detectKey: PANELS_AGENT_ID,
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
