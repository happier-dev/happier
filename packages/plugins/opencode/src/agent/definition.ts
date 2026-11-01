const OPENCODE_SESSION_COMPACTION_CAPABILITY = {
  events: true,
  manual: true,
  idle: { mode: 'host', defaultEnabled: false, defaultMinContextTokens: 100000 },
} as const;

const OPENCODE_AGENT_CORE = Object.freeze({
  id: 'opencode',
  cliSubcommand: 'opencode',
  detectKey: 'opencode',
  flavorAliases: ['open-code'],
  cloudConnect: null,
  connectedServices: {
    supportedServiceIds: ['openai-codex', 'openai', 'claude-subscription', 'anthropic'],
  },
  resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'opencodeSessionId' },
  sessionStorage: { direct: true, persisted: true },
  sessionCapabilities: {
    sessionListing: 'supported',
    // Both released server dialects can fork the current conversation. The
    // Happier from-message checkpoint path remains unsupported until its
    // generic cutoff semantics can preserve the exact provider boundary.
    sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
    sessionRollback: { conversation: 'unsupported' },
    usageLimitRecovery: { checkNow: 'unsupported' },
    compaction: OPENCODE_SESSION_COMPACTION_CAPABILITY,
  } as const,
  runtimeKinds: {
    defaultKind: 'server',
    byKind: {
      server: { kind: 'server' },
      acp: {
        kind: 'acp',
        overrides: {
          sessionStorage: { direct: false },
          sessionCapabilities: {
            usageLimitRecovery: { checkNow: 'unsupported' },
            compaction: null,
          } as const,
          localControl: null,
        },
      },
    },
  },
  handoff: { vendorStateTransfer: 'supported' },
  localControl: {
    supported: true,
    topology: 'shared',
    attachStrategy: 'provider_attach',
    remoteWritable: true,
  },
  tools: { delivery: 'native_mcp', support: 'supported' },
});

const OPENCODE_AGENT_SESSION_MODE_DESCRIPTOR = Object.freeze({
  source: 'acp',
  semantics: 'agent-modes',
  runtimeSwitch: 'acp-setSessionMode',
});

const OPENCODE_AGENT_MODEL_CONFIG = Object.freeze({
  supportsSelection: true,
  supportsFreeform: true,
  nonAcpApplyScope: 'next_prompt',
  acpModelConfigOptionId: 'model',
  defaultMode: 'default',
  allowedModes: ['default'],
});

const OPENCODE_RUNTIME_KIND_ALIASES = [
  { input: 'server', runtimeKind: 'server' },
  { input: 'acp', runtimeKind: 'acp' },
] as const;

const OPENCODE_RUNTIME_DESCRIPTOR_READER_PROJECTION = {
  providerId: 'opencode',
  backendModeKey: 'backendMode',
  runtimeKind: {
    aliases: OPENCODE_RUNTIME_KIND_ALIASES,
    caseInsensitive: true,
  },
  fields: [
    { key: 'backendMode', kind: 'runtimeKind', runtimeHandle: 'whenPresent' },
    { key: 'providerSessionId', kind: 'opaqueIdentifier', runtimeHandle: 'whenPresent' },
    { key: 'serverBaseUrl', kind: 'loopbackHttpOrigin', runtimeHandle: 'whenPresent' },
    { key: 'serverBaseUrlExplicit', kind: 'booleanTrue', runtimeHandle: 'booleanTrue', requiresField: 'serverBaseUrl' },
  ],
  legacy: {
    defaultRuntimeKindWhenAnyFieldPresent: 'server',
    fields: [
      { key: 'backendMode', sourceKey: 'opencodeBackendMode', kind: 'runtimeKind', runtimeHandle: 'whenPresent' },
      { key: 'providerSessionId', sourceKey: 'opencodeSessionId', kind: 'opaqueIdentifier', runtimeHandle: 'whenPresent' },
      { key: 'serverBaseUrl', sourceKey: 'opencodeServerBaseUrl', kind: 'loopbackHttpOrigin', runtimeHandle: 'whenPresent' },
      {
        key: 'serverBaseUrlExplicit',
        sourceKey: 'opencodeServerBaseUrlExplicit',
        kind: 'booleanTrue',
        runtimeHandle: 'booleanTrue',
        requiresField: 'serverBaseUrl',
      },
    ],
  },
} as const;

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: 'opencode',
  acpRegistryIds: ['opencode'] as const,
  core: OPENCODE_AGENT_CORE,
  sessionModeDescriptor: OPENCODE_AGENT_SESSION_MODE_DESCRIPTOR,
  sessionModesKind: 'acpAgentModes',
  modelConfig: OPENCODE_AGENT_MODEL_CONFIG,
  commandSurface: {
    rootHelpLabel: 'happier opencode',
    rootHelpDescription: 'Start OpenCode CLI',
    allowTmux: true,
  },
  releasedFlatSessionMetadataRuntimeDescriptorReader: {
    kind: 'providerRuntimeDescriptorReader',
    providerId: 'opencode',
    generatedReader: OPENCODE_RUNTIME_DESCRIPTOR_READER_PROJECTION,
  },
});
