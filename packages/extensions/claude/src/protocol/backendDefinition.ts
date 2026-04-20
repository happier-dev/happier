import type { BackendDefinitionV1 } from '@happier-dev/protocol';

// Data-only backend definition for future extension registration.
// Intentionally not registered yet; `activate()` remains inert in this wave.
export const CLAUDE_BACKEND_DEFINITION: BackendDefinitionV1 = {
  kindVersion: 1,
  id: 'claude',
  providerId: 'claude',
  runtimeKind: 'terminal',
  providerAgentId: 'claude',
  iconAgentId: 'claude',
  capabilities: {},
  runtimeAdapters: [],
};
