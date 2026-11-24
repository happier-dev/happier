import { CODERABBIT_ACCOUNT_SERVICE_ID } from '../connectedAccountDeclarations.js';

const CODERABBIT_AGENT_ID = 'coderabbit';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: CODERABBIT_AGENT_ID,
  core: {
    id: CODERABBIT_AGENT_ID,
    cliSubcommand: 'coderabbit',
    detectKey: 'coderabbit',
    flavorAliases: [],
    cloudConnect: null,
    connectedServices: { supportedServiceIds: [CODERABBIT_ACCOUNT_SERVICE_ID] },
    resume: { vendorResume: 'unsupported' as const },
    sessionStorage: { direct: false, persisted: false },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'unsupported', support: 'unsupported' },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' } as const,
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: false,
    nonAcpApplyScope: 'next_prompt',
    dynamicProbe: 'static-only',
    defaultMode: 'review',
    allowedModes: ['review'],
  },
});
