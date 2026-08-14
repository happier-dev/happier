import {
  ANTIGRAVITY_AGENT_ID,
  ANTIGRAVITY_BACKEND_ID,
  ANTIGRAVITY_BINARY_NAME,
} from './install/cliRuntime.js';
import { ANTIGRAVITY_AGENT_MODEL_CONFIG } from './models.js';

export const AGENT_DEFINITION = Object.freeze({
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
      supportedKindsByServiceId: { gemini: ['token'] },
    },
    resume: { vendorResume: 'supported', vendorResumeIdField: 'antigravitySessionId' },
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
  modelConfig: ANTIGRAVITY_AGENT_MODEL_CONFIG,
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
    protocolRuntimeDescriptor: {
      kind: 'providerRuntimeDescriptorV1',
      providerId: 'antigravity',
      source: './agent/runtime/runtimeDescriptor',
      buildFunction: 'buildAntigravityRuntimeDescriptorV1',
      canonicalReader: 'readCanonicalAntigravityRuntimeDescriptorV1',
    },
  },
});
