import {
  CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS,
  CANONICAL_AGENT_SESSION_MODES,
  CANONICAL_AGENTS_CORE,
} from '@happier-dev/plugin-sdk/experimental/agents';

import { CLAUDE_AGENT_MODEL_CONFIG } from './models.js';

// IMPORTANT: this must stay JSON-serializable (data-only).
export const AGENT_DEFINITION = Object.freeze({
  id: CANONICAL_AGENTS_CORE.claude.id,
  core: CANONICAL_AGENTS_CORE.claude,
  sessionModeDescriptor: CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS.claude,
  sessionModesKind: CANONICAL_AGENT_SESSION_MODES.claude,
  modelConfig: CLAUDE_AGENT_MODEL_CONFIG,
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'CLAUDE_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
    protocolMemoryDefaults: {
      kind: 'providerMemoryDefaultsV1',
      providerId: 'claude',
      source: './protocol/memory',
      exportName: 'CLAUDE_MEMORY_DEFAULTS',
    },
  },
});
