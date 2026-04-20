import type { BackendDefinitionV1 } from '@happier-dev/protocol';

export const OPENCODE_BACKEND_DEFINITION: BackendDefinitionV1 = {
  kindVersion: 1,
  id: 'opencode',
  providerId: 'opencode',
  // Matches existing plugin-backend semantics ("backendMode") and keeps this contribution
  // intentionally narrow until OpenCode extraction is fully wired through engines.
  runtimeKind: 'acp',
  providerAgentId: 'opencode',
  iconAgentId: 'opencode',
  capabilities: {},
  runtimeAdapters: [],
};
