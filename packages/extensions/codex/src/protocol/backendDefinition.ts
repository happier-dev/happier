import type { BackendDefinitionV1 } from '@happier-dev/protocol';

export const CODEX_BACKEND_DEFINITION: BackendDefinitionV1 = {
  kindVersion: 1,
  id: 'codex',
  providerId: 'codex',
  // Keep this narrow in the data-only migration wave; runtime wiring is handled
  // via registerBackendEngine in later extraction packets.
  runtimeKind: 'appServer',
  providerAgentId: 'codex',
  iconAgentId: 'codex',
  capabilities: {},
  runtimeAdapters: [],
};
