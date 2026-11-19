import { MUSE_ACCOUNT_SERVICE_ID } from '../connectedAccounts/declarations.js';

export const MUSE_ACCOUNTING_SOURCE_ID = 'muse-native-accounting';

/** Data-only facts consumed by the canonical generated Agent projections. */
export const MUSE_AGENT = Object.freeze({
  id: 'muse',
  core: {
    id: 'muse',
    cliSubcommand: 'muse',
    detectKey: 'muse',
    flavorAliases: [],
    cloudConnect: null,
    connectedServices: { supportedServiceIds: [MUSE_ACCOUNT_SERVICE_ID] },
    resume: { vendorResume: 'supported' as const },
    sessionStorage: { direct: true, persisted: true },
    nativeSandbox: { off: true as const },
    sessionCapabilities: {
      compaction: { events: true, manual: true },
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'supported', fromMessage: 'supported' },
      sessionRollback: { conversation: 'unsupported' },
      usageReporting: 'supported',
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    runtimeInput: { inFlightSteerSupported: true, terminalPromptInjectionSupported: false },
    tools: { delivery: 'native_mcp', support: 'supported', noTools: false },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: false,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
} as const);

export { MUSE_AGENT as AGENT_DEFINITION };
