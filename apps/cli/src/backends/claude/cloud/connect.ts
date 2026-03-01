import type { CloudConnectTarget } from '@/cloud/connectTypes';
import { AGENTS_CORE } from '@happier-dev/agents';
import { authenticateClaudeSubscriptionOauth } from './authenticateClaudeSubscriptionOauth';

export const claudeCloudConnect: CloudConnectTarget = {
  id: 'claude',
  displayName: 'Claude',
  vendorDisplayName: 'Anthropic Claude',
  vendorKey: AGENTS_CORE.claude.cloudConnect!.vendorKey,
  status: AGENTS_CORE.claude.cloudConnect!.status,
  authenticate: (opts) => authenticateClaudeSubscriptionOauth(opts),
};
