const GEMINI_AGENT_ID = 'gemini';

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
        gemini: ['oauth'],
      },
    },
    resume: { vendorResume: 'supported', vendorResumeIdField: 'geminiSessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
      usageLimitRecovery: { checkNow: 'supported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'native_mcp', support: 'supported' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'restart_session',
    acpModelConfigOptionId: 'model',
    defaultMode: 'gemini-2.5-pro',
    allowedModes: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'gemini-3.1-pro-preview',
    ],
  },
  authProbeConfig: {
    agentId: GEMINI_AGENT_ID,
    binaryNames: ['gemini'],
    statusCommand: null,
    parser: 'geminiCredentialFiles',
    backgroundChecks: 'safe',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    credentialPaths: [
      '~/.gemini/oauth_creds.json',
      '~/.gemini/config.json',
      '~/.config/gemini/config.json',
      '~/.gemini/auth.json',
      '~/.config/gemini/auth.json',
      '~/.config/gcloud/application_default_credentials.json',
    ],
  },
  localCli: {
    agentId: GEMINI_AGENT_ID,
    detectKey: 'gemini',
    machineLoginKey: 'gemini-cli',
    supportKind: 'login_terminal',
    loginLaunch: {
      command: 'gemini',
      args: ['auth'],
    },
  },
  agentCliRuntime: {
    id: GEMINI_AGENT_ID,
    title: 'Google Gemini CLI',
    binaryName: 'gemini',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@google/gemini-cli',
      binaryName: 'gemini',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: null,
    docsUrl: 'https://goo.gle/gemini-cli-auth-docs',
  },
  providerSettings: null,
  runtimeContributions: {
    protocolBuiltInBackendProfiles: {
      kind: 'providerBuiltInBackendProfilesV1',
      providerId: GEMINI_AGENT_ID,
      source: './protocol/profiles',
      exportName: 'GEMINI_BUILT_IN_BACKEND_PROFILES',
    },
  },
});
