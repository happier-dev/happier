// IMPORTANT: this must stay JSON-serializable (data-only).
const CODEX_AGENT_ID = 'codex';

const CODEX_RUNTIME_KIND_ALIASES = [
  { input: 'acp', runtimeKind: 'acp' },
  { input: 'appServer', runtimeKind: 'appServer' },
  { input: 'mcp', runtimeKind: 'appServer' },
  { input: 'mcp_resume', runtimeKind: 'acp' },
] as const;

const CODEX_RUNTIME_CONTROL_KIND_ALIASES = [
  { input: 'acp', runtimeKind: 'acp' },
  { input: 'appServer', runtimeKind: 'appServer' },
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

const CODEX_SESSION_CONTROL_ADAPTER_PROJECTION = {
  providerId: 'codex',
  runtimeDescriptor: CODEX_RUNTIME_DESCRIPTOR_READER_PROJECTION,
  runtimeKindOverride: {
    aliases: CODEX_RUNTIME_KIND_ALIASES,
    accountSettingsField: 'codexBackendMode',
  },
  configuredRuntimeKind: {
    aliases: CODEX_RUNTIME_KIND_ALIASES,
    accountSettingsField: 'codexBackendMode',
    defaultRuntimeKind: 'appServer',
    booleanTrueField: 'experimentalCodexAcp',
    booleanTrueRuntimeKind: 'acp',
  },
  controlRuntimeKind: {
    aliases: CODEX_RUNTIME_CONTROL_KIND_ALIASES,
    rawDescriptorPaths: [
      { providerId: 'codex', path: ['agent', 'agentExtra', 'runtimeHandle', 'backendMode'] },
      { providerId: 'codex', path: ['agent', 'agentExtra', 'runtimeAffinity', 'backendMode'] },
      { providerId: 'codex', path: ['agent', 'backendMode'] },
      { providerId: 'codex', path: ['provider', 'providerExtra', 'runtimeHandle', 'backendMode'] },
      { providerId: 'codex', path: ['provider', 'providerExtra', 'runtimeAffinity', 'backendMode'] },
      { providerId: 'codex', path: ['provider', 'backendMode'] },
    ],
    metadataPaths: [
      { path: ['codexRuntimeDescriptorV1', 'backendMode'] },
      { path: ['affinity', 'backendMode'] },
      { path: ['codexBackendMode'] },
      { providerId: 'codex', path: ['directSessionV1', 'codexBackendMode'] },
      { path: ['externalSessionV1', 'codexBackendMode'] },
    ],
    genericState: {
      providerId: 'codex',
      runtimeKind: 'appServer',
      fields: [
        'sessionModesV1',
        'sessionModelsV1',
        'sessionConfigOptionsV1',
        'acpSessionModesV1',
        'acpSessionModelsV1',
        'acpConfigOptionsV1',
      ],
    },
  },
  vendorResumeId: {
    descriptorField: 'providerSessionId',
    legacyField: 'codexSessionId',
  },
  experimentalVendorResume: {
    runtimeKinds: ['acp', 'appServer'],
    accountSettingsField: 'codexBackendMode',
    accountSettingsValues: ['acp', 'appServer', 'mcp_resume'],
    booleanTrueField: 'experimentalCodexAcp',
    requireConfiguredRuntimeKind: true,
  },
  experimentalVendorHandoff: {
    runtimeKinds: ['acp', 'appServer'],
    accountSettingsField: 'codexBackendMode',
    accountSettingsValues: ['acp', 'appServer', 'mcp_resume'],
    booleanTrueField: 'experimentalCodexAcp',
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
      sessionAuthSwitch: {
        continuityMode: 'restart_shared_state_required',
        supportedTransitions: ['same_connected_group'],
        providerStateSharingRequired: {
          serviceIds: ['openai-codex'],
          supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
        },
      },
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
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'CODEX_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/catalog',
    },
    sessionControlAdapter: {
      kind: 'providerSessionControlAdapter',
      providerId: 'codex',
      generatedAdapter: CODEX_SESSION_CONTROL_ADAPTER_PROJECTION,
    },
    runtimeDescriptorReader: {
      kind: 'providerRuntimeDescriptorReader',
      providerId: 'codex',
      generatedReader: CODEX_RUNTIME_DESCRIPTOR_READER_PROJECTION,
    },
    protocolRuntimeDescriptor: {
      kind: 'providerRuntimeDescriptorV1',
      providerId: 'codex',
      source: './protocol/runtimeDescriptorV1',
      buildFunction: 'buildCodexAgentRuntimeDescriptorV1',
      canonicalReader: 'readCanonicalCodexAgentRuntimeDescriptorV1',
    },
    protocolBuiltInBackendProfiles: {
      kind: 'providerBuiltInBackendProfilesV1',
      providerId: 'codex',
      source: './protocol/profiles',
      exportName: 'CODEX_BUILT_IN_BACKEND_PROFILES',
    },
  },
});
