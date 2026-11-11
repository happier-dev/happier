const KIMI_AGENT_ID = 'kimi';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: KIMI_AGENT_ID,
  acpRegistryIds: ['kimi'] as const,
  core: {
    id: KIMI_AGENT_ID,
    cliSubcommand: 'kimi',
    detectKey: 'kimi',
    flavorAliases: ['kimi-cli'],
    cloudConnect: null,
    connectedServices: {
      supportedServiceIds: ['kimi-code'],
      providerStateSharing: {
        config: { supported: true, modes: ['linked', 'copied', 'isolated'] },
        state: { supported: true, modes: ['isolated', 'shared'], sharedStatePrivacyRiskAcknowledgementRequired: true },
      },
    },
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'kimiSessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'supported',
      sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
    // Kimi Code receives Happier's tools as ACP MCP servers, which is exactly
    // what this Agent's runtime declaration promises with
    // `mcp: { policy: 'pass_through' }`. `shell_bridge` contradicted that: the
    // host's user-MCP delivery predicate excludes `shell_bridge`, so `pass_through` had an
    // empty set to forward and Kimi advertised tools it never received.
    tools: { delivery: 'native_mcp', support: 'experimental' },
  },
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' } as const,
  sessionModesKind: 'acpAgentModes',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: false,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'set_model',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
});
