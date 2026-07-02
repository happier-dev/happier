import { AGENTS_CORE } from '@happier-dev/agents';

import { authenticateCodexCloudConnect } from './authenticate.js';

export const codexCloudConnectDescriptor = {
  id: 'codex',
  displayName: 'Codex',
  vendorDisplayName: 'OpenAI Codex',
  vendorKey: AGENTS_CORE.codex.cloudConnect!.vendorKey,
  status: AGENTS_CORE.codex.cloudConnect!.status,
  customAuthenticator: {
    authenticate: authenticateCodexCloudConnect,
  },
} as const;
