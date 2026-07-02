// IMPORTANT: this must stay JSON-serializable (data-only).
const CODEX_AGENT_ID = 'codex';

export const AGENT_DEFINITION = Object.freeze({
  id: CODEX_AGENT_ID,
  core: {
    id: CODEX_AGENT_ID,
    cliSubcommand: 'codex',
    detectKey: 'codex',
    resume: { vendorResume: 'unsupported', vendorResumeIdField: null },
    sessionStorage: { direct: false, persisted: false },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'unsupported', support: 'unsupported' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: false,
    nonAcpApplyScope: 'spawn_only',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  authProbeConfig: {
    agentId: 'codex',
    binaryNames: ['codex'],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  localCli: {
    agentId: 'codex',
    detectKey: 'codex',
    machineLoginKey: 'codex',
    supportKind: 'unsupported',
    loginLaunch: null,
  },
  agentCliRuntime: {
    id: CODEX_AGENT_ID,
    title: 'codex CLI',
    binaryName: 'codex',
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'none',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
  },
  providerSettings: null,
  runtimeContributions: {
    providerCatalogEntry: {
      importName: 'CODEX_PROVIDER_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
    sessionControlAdapter: {
      kind: 'providerSessionControlAdapter',
      providerId: 'codex',
      source: './agent/surfaces/sessions/controls/adapter',
      exportName: 'CODEX_SESSION_CONTROL_ADAPTER',
    },
    runtimeDescriptorReader: {
      kind: 'providerRuntimeDescriptorReader',
      providerId: 'codex',
      source: './agent/identity/runtimeDescriptor',
      exportName: 'readCodexSessionMetadataRuntimeDescriptor',
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
    protocolExternalSessionSource: {
      kind: 'providerExternalSessionSourceV1',
      providerId: 'codex',
      source: './protocol/externalSession',
      exportName: 'CODEX_EXTERNAL_SESSION_SOURCE',
    },
    externalSessionHostAdapters: {
      kind: 'providerExternalSessionHostAdaptersV1',
      providerId: 'codex',
      candidateHostAdapter: {
        source: '@/backends/codex/appServer/session/externalCandidates',
        exportName: 'createCodexExternalSessionCandidateHostAdapter',
      },
      transcriptStoreAdapter: {
        source: '@/backends/codex/rollout/sessionStore/externalTranscriptAdapter',
        exportName: 'createCodexExternalSessionTranscriptStoreAdapter',
      },
    },
  },
});
