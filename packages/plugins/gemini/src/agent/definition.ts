const GEMINI_AGENT_ID = 'gemini';

const GEMINI_STATIC_MODELS = [
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    description: 'Best for complex reasoning, coding, and longer-running tasks.',
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    description: 'Fast, balanced Gemini model for general-purpose work.',
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    description: 'Lowest-latency Gemini 2.5 option for lightweight prompts.',
  },
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash Preview',
    description: 'Preview flash model from the Gemini 3 generation.',
  },
  {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro Preview',
    description: 'Preview pro model with stronger reasoning and coding depth.',
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    description: 'Latest Gemini 3.1 preview with the strongest reasoning in this static list.',
  },
] as const;

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: GEMINI_AGENT_ID,
  core: {
    id: GEMINI_AGENT_ID,
    cliSubcommand: 'gemini',
    detectKey: 'gemini',
    flavorAliases: [],
    cloudConnect: { vendorKey: 'gemini', status: 'wired' },
    connectedServices: {
      supportedServiceIds: ['gemini'],
      sessionAuthSwitch: {
        continuityMode: 'restart_same_home',
        supportedTransitions: ['native_to_connected', 'connected_to_connected'],
      },
      supportedKindsByServiceId: {
        gemini: ['token'],
      },
    },
    resume: { vendorResume: 'supported', vendorResumeIdField: 'geminiSessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
      usageLimitRecovery: { checkNow: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'native_mcp', support: 'supported' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: true,
    freeformModelIdPrefixes: [
      'gemini-',
      'models/gemini-',
      'publishers/google/models/gemini-',
    ],
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'restart_session',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'static-only',
    defaultMode: 'gemini-2.5-pro',
    allowedModes: GEMINI_STATIC_MODELS.map((model) => model.id),
    staticModels: GEMINI_STATIC_MODELS,
  },
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'GEMINI_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
    protocolBuiltInBackendProfiles: {
      kind: 'providerBuiltInBackendProfilesV1',
      providerId: GEMINI_AGENT_ID,
      source: './protocol/profiles',
      exportName: 'GEMINI_BUILT_IN_BACKEND_PROFILES',
    },
  },
});
