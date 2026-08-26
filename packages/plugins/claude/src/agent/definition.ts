import type { AgentModelConfig } from '@happier-dev/plugin-sdk/agents';

import { CLAUDE_AGENT_MODEL_CONFIG } from './models.js';

function defineAgentWithPublicModelConfig<TDefinition extends Readonly<Record<string, unknown>>>(
  definition: TDefinition,
  modelConfig: AgentModelConfig,
): Readonly<TDefinition & { modelConfig: AgentModelConfig }> {
  return Object.freeze({ ...definition, modelConfig });
}

const CLAUDE_AGENT_ID = 'claude';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = defineAgentWithPublicModelConfig({
  id: CLAUDE_AGENT_ID,
  core: {
    id: CLAUDE_AGENT_ID,
    cliSubcommand: CLAUDE_AGENT_ID,
    detectKey: CLAUDE_AGENT_ID,
    flavorAliases: [],
    cloudConnect: { vendorKey: 'anthropic', status: 'wired' },
    connectedServices: {
      supportedServiceIds: ['claude-subscription', 'anthropic'],
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
      sessionAuthSwitch: {
        continuityMode: 'restart_same_home',
        supportedTransitions: ['same_connected_group'],
        providerStateSharingRequired: {
          serviceIds: ['claude-subscription', 'anthropic'],
          supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
        },
      },
      supportedKindsByServiceId: {
        'claude-subscription': ['oauth', 'token'],
        anthropic: ['token'],
      },
    },
    resume: {
      vendorResume: 'supported' as const,
      vendorResumeIdField: 'claudeSessionId',
      vendorResumeContinuityProofField: 'claudeTranscriptPath',
    },
    sessionStorage: { direct: true, persisted: true },
    sessionCapabilities: {
      sessionListing: 'supported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
      usageLimitRecovery: { checkNow: 'supported' },
    },
    handoff: { vendorStateTransfer: 'supported' },
    localControl: {
      supported: true,
      topology: 'exclusive',
      attachStrategy: 'terminal_host',
    },
    runtimeInput: {
      inFlightSteerSupported: true,
      terminalPromptInjectionSupported: true,
    },
    tools: { delivery: 'native_mcp', support: 'supported' },
  },
  sessionModeDescriptor: {
    source: 'provider-native',
    semantics: 'agent-modes',
    runtimeSwitch: 'provider-native',
  },
  sessionModesKind: 'staticAgentModes',
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'CLAUDE_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/catalog',
    },
    protocolMemoryDefaults: {
      kind: 'providerMemoryDefaultsV1',
      providerId: 'claude',
      source: './protocol/memory',
      exportName: 'CLAUDE_MEMORY_DEFAULTS',
    },
  },
} as const, CLAUDE_AGENT_MODEL_CONFIG);
