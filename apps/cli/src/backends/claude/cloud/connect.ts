import type { CloudConnectTarget } from '@/cloud/connectTypes';
import { AGENTS_CORE } from '@happier-dev/agents';

export const claudeCloudConnect: CloudConnectTarget = {
  id: 'claude',
  displayName: 'Claude',
  vendorDisplayName: 'Anthropic Claude',
  vendorKey: AGENTS_CORE.claude.cloudConnect!.vendorKey,
  status: AGENTS_CORE.claude.cloudConnect!.status,
  authenticate: async () => {
    throw new Error('Claude OAuth is not supported in Happier connected services. Use an Anthropic API key instead.');
  },
};
