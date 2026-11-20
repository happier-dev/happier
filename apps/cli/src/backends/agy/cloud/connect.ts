import type { CloudConnectTarget } from '@/cloud/connectTypes';
import { AGENTS_CORE } from '@happier-dev/agents';
import { authenticateAgy } from './authenticate';
import { importAgyCredentials } from './importCredentials';

export const agyCloudConnect: CloudConnectTarget = {
  id: 'agy', displayName: 'Antigravity', vendorDisplayName: 'Google Antigravity',
  aliases: ['antigravity'],
  vendorKey: AGENTS_CORE.agy.cloudConnect!.vendorKey,
  status: AGENTS_CORE.agy.cloudConnect!.status,
  authenticate: authenticateAgy,
  importServiceId: 'antigravity',
  importSources: [
    { id: 'acp', label: 'Pinned Antigravity ACP server login (Keychain read only on macOS)' },
    ...(['linux', 'darwin'].includes(process.platform) ? [{ id: 'cli', label: 'Antigravity CLI login' }] : []),
    { id: 'cli-file', label: 'Antigravity CLI file login' },
  ],
  importCredentials: importAgyCredentials,
};
