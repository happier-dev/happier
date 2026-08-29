import {
  ANTIGRAVITY_AGENT_ID,
  ANTIGRAVITY_BACKEND_ID,
  ANTIGRAVITY_BINARY_NAME,
} from './install/cliRuntime.js';
import type { AgentModelConfig } from '@happier-dev/plugin-sdk/agents';
import { ANTIGRAVITY_AGENT_MODEL_CONFIG } from './models.js';

function defineAgentWithPublicModelConfig<const TDefinition extends Readonly<Record<string, unknown>>>(
  definition: TDefinition,
  modelConfig: AgentModelConfig,
): Readonly<TDefinition & { modelConfig: AgentModelConfig }> {
  return Object.freeze({ ...definition, modelConfig });
}

export const AGENT_DEFINITION = defineAgentWithPublicModelConfig({
  id: ANTIGRAVITY_AGENT_ID,
  core: {
    id: ANTIGRAVITY_AGENT_ID,
    backendDefinition: false,
    cliSubcommand: ANTIGRAVITY_AGENT_ID,
    detectKey: ANTIGRAVITY_BINARY_NAME,
    flavorAliases: [ANTIGRAVITY_BINARY_NAME],
    cloudConnect: null,
    connectedServices: {
      supportedServiceIds: ['gemini'],
    },
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'antigravitySessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    localControl: {
      supported: true,
      topology: 'exclusive',
      attachStrategy: 'terminal_host',
    },
    tools: { delivery: 'unsupported', support: 'unsupported' },
  },
  settingsBackendId: ANTIGRAVITY_BACKEND_ID,
  ownedBackendIds: [ANTIGRAVITY_BACKEND_ID],
  enablementCompatibilityBackendIds: ['antigravity-localharness', 'antigravity-terminal'],
  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  sessionModesKind: 'none',
}, ANTIGRAVITY_AGENT_MODEL_CONFIG);
