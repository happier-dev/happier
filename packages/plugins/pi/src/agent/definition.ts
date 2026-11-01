import { piConnectedServiceStateSharingDescriptor } from './connectedServices/stateSharingDescriptor.js';

const { providerId: _providerId, ...stateSharing } = piConnectedServiceStateSharingDescriptor;
export const AGENT_STATE_SHARING_DESCRIPTOR = {
  ...stateSharing,
  nativeHome: { environmentKey: 'PI_CODING_AGENT_DIR', defaultRelativePath: '.pi/agent' },
} as const;

const PI_AGENT_ID = 'pi';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: PI_AGENT_ID,
  acpRegistryIds: ['pi-acp'] as const,
  core: {
    id: PI_AGENT_ID,
    cliSubcommand: 'pi',
    detectKey: 'pi',
    flavorAliases: ['pi-coding-agent'],
    cloudConnect: null,
    connectedServices: {
      supportedServiceIds: ['openai-codex', 'openai', 'claude-subscription', 'anthropic'],
      providerStateSharing: {
        config: {
          supported: false,
          modes: ['isolated'],
          unavailableReason: 'not_implemented',
        },
        state: {
          supported: true,
          modes: ['isolated', 'shared'],
          sharedStatePrivacyRiskAcknowledgementRequired: true,
        },
      },
    },
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'piSessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
      usageLimitRecovery: { checkNow: 'unsupported' },
      usageReporting: 'supported',
      compaction: { events: true, manual: true, idle: { mode: 'host', defaultEnabled: false, defaultMinContextTokens: 100000 } },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    runtimeInput: {
      inFlightSteerSupported: true,
      terminalPromptInjectionSupported: false,
    },
    tools: { delivery: 'native_extension', support: 'experimental',
      mcpToolControl: { off: 'hidden', approval: 'host' } },
  },
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
  modelConfig: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
} as const);
