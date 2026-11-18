const SLICE_AGENT_CORE = {
  id: 'slices', cliSubcommand: 'slices', detectKey: 'slices', flavorAliases: [],
  cloudConnect: null, connectedServices: null, resume: { vendorResume: 'unsupported' as const },
  sessionStorage: { direct: false, persisted: false },
  sessionCapabilities: { sessionListing: 'unsupported', sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' }, sessionRollback: { conversation: 'unsupported' } },
  handoff: { vendorStateTransfer: 'unsupported' }, tools: { delivery: 'unsupported', support: 'unsupported' },
};

export const AGENT_DEFINITION = Object.freeze({
  id: 'slices', core: SLICE_AGENT_CORE,
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' } as const,
  sessionModesKind: 'none',
  modelConfig: { supportsSelection: true, nonAcpApplyScope: 'next_prompt', dynamicProbe: 'static-only',
    defaultMode: 'review', allowedModes: ['review'] },
});
