import type { AgentModelConfig } from '@happier-dev/plugin-sdk/agents';

import { CLAUDE_AGENT_MODEL_CONFIG } from './models.js';
import { INTERNAL_CLAUDE_EVENT_TYPES } from './transcripts/internalEventTypes.js';
import { claudeAuthStateSharingDescriptor } from './auth/services/stateSharing.js';
import { CLAUDE_NATIVE_PERMISSION_MODES } from './permissionModes.js';

const { providerId: _providerId, ...stateSharing } = claudeAuthStateSharingDescriptor;
export const AGENT_STATE_SHARING_DESCRIPTOR = {
  ...stateSharing,
  nativeHome: { environmentKey: 'CLAUDE_CONFIG_DIR', defaultRelativePath: '.claude' },
} as const;

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
    },
    resume: {
      vendorResume: 'supported' as const,
      vendorResumeIdField: 'claudeSessionId',
      vendorResumeContinuityProofField: 'claudeTranscriptPath',
    },
    sessionStorage: { direct: true, persisted: true },
    structuredOutput: { formats: ['json'] },
    sessionCapabilities: {
      sessionListing: 'supported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
      usageLimitRecovery: { checkNow: 'unsupported' },
      usageReporting: 'supported',
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
  nativePermissionModes: CLAUDE_NATIVE_PERMISSION_MODES,
  releasedOutputTranscriptRecordReader: {
    nonTranscriptRecordTypes: [...INTERNAL_CLAUDE_EVENT_TYPES],
  },
} as const, CLAUDE_AGENT_MODEL_CONFIG);
