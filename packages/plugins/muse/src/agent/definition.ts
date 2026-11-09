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
    resume: { vendorResume: 'unsupported' as const },
    sessionStorage: { direct: true, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
      usageReporting: 'unsupported',
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    runtimeInput: { inFlightSteerSupported: false, terminalPromptInjectionSupported: false },
    tools: { delivery: 'unsupported', support: 'unsupported' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: false,
    nonAcpApplyScope: 'spawn_only',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
} as const);

export { MUSE_AGENT as AGENT_DEFINITION };
