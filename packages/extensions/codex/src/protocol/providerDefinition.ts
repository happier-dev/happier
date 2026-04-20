import type { ProviderDefinitionV1 } from '@happier-dev/protocol';

export const CODEX_PROVIDER_DEFINITION: ProviderDefinitionV1 = {
  kindVersion: 1,
  id: 'codex',
  providerAgentId: 'codex',
  iconAgentId: 'codex',
  display: {
    name: 'Codex',
    tags: [],
  },
  ownedBackendIds: ['codex'],
};
