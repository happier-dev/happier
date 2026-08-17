import { AGENT_DEFINITION } from '../../../../definition.js';
import { authenticateCodexCloudConnect } from './authenticate.js';

const codexCloudConnect = AGENT_DEFINITION.core.cloudConnect;
if (!codexCloudConnect) {
  throw new Error('Codex cloud connect facts are unavailable');
}

export const codexCloudConnectDescriptor = {
  id: 'codex',
  displayName: 'Codex',
  vendorDisplayName: 'OpenAI Codex',
  vendorKey: codexCloudConnect.vendorKey,
  status: codexCloudConnect.status,
  customAuthenticator: {
    authenticate: authenticateCodexCloudConnect,
  },
} as const;
