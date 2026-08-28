// IMPORTANT: this must stay JSON-serializable (data-only).
const CODEX_AGENT_ID = 'codex';

const CODEX_RUNTIME_KIND_ALIASES = [
  { input: 'acp', runtimeKind: 'acp' },
  { input: 'appServer', runtimeKind: 'appServer' },
  // Released flat Session metadata used `mcp` for the retired MCP runtime.
  // Preserve that meaning for capability compatibility; mapping it to
  // app-server would incorrectly advertise app-server-only operations.
  { input: 'mcp', runtimeKind: 'mcp' },
  { input: 'mcp_resume', runtimeKind: 'acp' },
] as const;

const CODEX_RUNTIME_DESCRIPTOR_READER_PROJECTION = {
  providerId: 'codex',
  backendModeKey: 'backendMode',
  runtimeKind: { aliases: CODEX_RUNTIME_KIND_ALIASES },
  fields: [
    { key: 'backendMode', kind: 'runtimeKind', runtimeHandle: 'whenPresent' },
    { key: 'providerSessionId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
    { key: 'home', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
    { key: 'connectedServiceId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
    { key: 'connectedServiceProfileId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
    { key: 'connectedServiceGroupId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
    { key: 'homePath', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
  ],
  legacy: {
    requireRuntimeKind: true,
    fields: [
      { key: 'backendMode', sourceKey: 'codexBackendMode', kind: 'runtimeKind', runtimeHandle: 'whenPresent' },
      { key: 'providerSessionId', sourceKey: 'codexSessionId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
      { key: 'home', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
      { key: 'connectedServiceId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
      { key: 'connectedServiceProfileId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
      { key: 'connectedServiceGroupId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
      { key: 'homePath', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
    ],
  },
} as const;

export const AGENT_DEFINITION = Object.freeze({
  id: CODEX_AGENT_ID,
  core: {
    id: CODEX_AGENT_ID,
    cliSubcommand: 'codex',
    detectKey: 'codex',
    flavorAliases: ['codex-acp', 'codex-mcp', 'openai', 'gpt'],
    cloudConnect: { vendorKey: 'openai', status: 'wired' },
    connectedServices: {
      supportedServiceIds: ['openai-codex', 'openai'],
      providerStateSharing: {
        config: {
          supported: true,
          modes: ['linked', 'copied', 'isolated'],
        },
        state: {
          supported: true,
          modes: ['isolated', 'shared'],
          sharedStatePrivacyRiskAcknowledgementRequired: true,
        },
      },
      supportedKindsByServiceId: {
        'openai-codex': ['oauth'],
        openai: ['token'],
      },
    },
    resume: { vendorResume: 'experimental' as const, vendorResumeIdField: 'codexSessionId' },
    sessionStorage: { direct: true, persisted: true },
    sessionCapabilities: {
      sessionListing: 'supported',
      sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'supported' },
      usageLimitRecovery: { checkNow: 'supported' },
    },
    runtimeKinds: {
      defaultKind: 'appServer',
      byKind: {
        mcp: {
          kind: 'mcp',
          overrides: {
            resume: { vendorResume: 'unsupported' as const },
            sessionCapabilities: {
              sessionFork: { conversation: 'unsupported' },
              sessionRollback: { conversation: 'unsupported' },
              usageLimitRecovery: { checkNow: 'unsupported' },
            },
            handoff: { vendorStateTransfer: 'unsupported' },
            localControl: null,
          },
        },
        acp: {
          kind: 'acp',
          overrides: {
            sessionCapabilities: {
              sessionFork: { conversation: 'unsupported' },
              sessionRollback: { conversation: 'unsupported' },
              usageLimitRecovery: { checkNow: 'unsupported' },
            },
          },
        },
        appServer: { kind: 'appServer' },
      },
    },
    handoff: { vendorStateTransfer: 'experimental', requiresExplicitSessionId: true },
    localControl: { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' },
    tools: { delivery: 'native_mcp', support: 'supported' },
  },
  sessionModeDescriptor: { source: 'acp', semantics: 'policy-presets', runtimeSwitch: 'metadata-gating' },
  sessionModesKind: 'acpPolicyPresets',
  modelConfig: {
    supportsSelection: true,
    nonAcpApplyScope: 'spawn_only',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  commandPolicy: {
    daemonAutostartDefault: 'preferLocalTui',
  },
  releasedFlatSessionMetadataRuntimeDescriptorReader: {
    kind: 'providerRuntimeDescriptorReader',
    providerId: 'codex',
    generatedReader: CODEX_RUNTIME_DESCRIPTOR_READER_PROJECTION,
  },
});
