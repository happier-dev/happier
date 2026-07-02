import {
  CANONICAL_AGENT_AUTH_PROBE_CONFIG,
  CANONICAL_AGENT_LOCAL_CLI_CONFIG,
  CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS,
  CANONICAL_AGENT_SESSION_MODES,
  CANONICAL_AGENTS_CORE,
  CANONICAL_AGENT_CLI_RUNTIME_SPECS,
} from '@happier-dev/agents';

import { CLAUDE_AGENT_MODEL_CONFIG } from './models.js';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: CANONICAL_AGENTS_CORE.claude.id,
  core: CANONICAL_AGENTS_CORE.claude,
  sessionModeDescriptor: CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS.claude,
  sessionModesKind: CANONICAL_AGENT_SESSION_MODES.claude,
  modelConfig: CLAUDE_AGENT_MODEL_CONFIG,
  authProbeConfig: CANONICAL_AGENT_AUTH_PROBE_CONFIG.claude,
  localCli: CANONICAL_AGENT_LOCAL_CLI_CONFIG.claude,
  agentCliRuntime: CANONICAL_AGENT_CLI_RUNTIME_SPECS.claude,
  providerSettings: null,
  runtimeContributions: {
    providerCatalogEntry: {
      importName: 'CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
    protocolBuiltInBackendProfiles: {
      kind: 'providerBuiltInBackendProfilesV1',
      providerId: 'claude',
      source: './protocol/profiles',
      exportName: 'CLAUDE_BUILT_IN_BACKEND_PROFILES',
    },
    protocolMemoryDefaults: {
      kind: 'providerMemoryDefaultsV1',
      providerId: 'claude',
      source: './protocol/memory',
      exportName: 'CLAUDE_MEMORY_DEFAULTS',
    },
    protocolExternalSessionSource: {
      kind: 'providerExternalSessionSourceV1',
      providerId: 'claude',
      source: './protocol/externalSession',
      exportName: 'CLAUDE_EXTERNAL_SESSION_SOURCE',
    },
  },
});
