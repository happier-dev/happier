import {
  ANTIGRAVITY_AGENT_ID,
  ANTIGRAVITY_BACKEND_ID,
  ANTIGRAVITY_BINARY_NAME,
} from './install/cliRuntime.js';
import type { AgentModelConfig } from '@happier-dev/plugin-sdk/agents';
import { ANTIGRAVITY_AGENT_MODEL_CONFIG } from './models.js';

function defineAgentWithPublicModelConfig<TDefinition extends Readonly<Record<string, unknown>>>(
  definition: TDefinition,
  modelConfig: AgentModelConfig,
): Readonly<TDefinition & { modelConfig: AgentModelConfig }> {
  return Object.freeze({ ...definition, modelConfig });
}

const ANTIGRAVITY_RUNTIME_KIND_ALIASES = [
  { input: 'cliPrint', runtimeKind: 'cliPrint' },
  { input: 'sdk', runtimeKind: 'sdk' },
] as const;

const ANTIGRAVITY_RUNTIME_DESCRIPTOR_READER_PROJECTION = {
  providerId: 'antigravity',
  backendModeKey: 'runtimeMode',
  runtimeKind: { aliases: ANTIGRAVITY_RUNTIME_KIND_ALIASES },
  fields: [
    { key: 'runtimeMode', kind: 'runtimeKind', runtimeHandle: 'whenPresent' },
    { key: 'providerSessionId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
    { key: 'agyConversationId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
    { key: 'localharnessSessionId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
  ],
  legacy: {
    requireRuntimeKind: true,
    fields: [
      {
        key: 'runtimeMode',
        sourceKey: 'antigravityRuntimeMode',
        kind: 'runtimeKind',
        runtimeHandle: 'whenPresent',
      },
      { key: 'providerSessionId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
      { key: 'agyConversationId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
      { key: 'localharnessSessionId', kind: 'trimmedString', runtimeHandle: 'whenPresent' },
    ],
  },
} as const;

const ANTIGRAVITY_SESSION_CONTROL_ADAPTER_PROJECTION = {
  providerId: 'antigravity',
  runtimeDescriptor: ANTIGRAVITY_RUNTIME_DESCRIPTOR_READER_PROJECTION,
  runtimeKindOverride: {
    aliases: ANTIGRAVITY_RUNTIME_KIND_ALIASES,
    accountSettingsField: 'antigravityRuntimeMode',
  },
  configuredRuntimeKind: {
    aliases: ANTIGRAVITY_RUNTIME_KIND_ALIASES,
    accountSettingsField: 'antigravityRuntimeMode',
  },
  vendorResumeId: {
    descriptorField: 'providerSessionId',
    legacyField: 'antigravitySessionId',
  },
} as const;

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
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/catalog',
    },
    sessionControlAdapter: {
      kind: 'providerSessionControlAdapter',
      providerId: 'antigravity',
      generatedAdapter: ANTIGRAVITY_SESSION_CONTROL_ADAPTER_PROJECTION,
    },
    runtimeDescriptorReader: {
      kind: 'providerRuntimeDescriptorReader',
      providerId: 'antigravity',
      generatedReader: ANTIGRAVITY_RUNTIME_DESCRIPTOR_READER_PROJECTION,
    },
    protocolRuntimeDescriptor: {
      kind: 'providerRuntimeDescriptorV1',
      providerId: 'antigravity',
      source: './agent/runtime/runtimeDescriptor',
      buildFunction: 'buildAntigravityRuntimeDescriptorV1',
      canonicalReader: 'readCanonicalAntigravityRuntimeDescriptorV1',
    },
  },
}, ANTIGRAVITY_AGENT_MODEL_CONFIG);
