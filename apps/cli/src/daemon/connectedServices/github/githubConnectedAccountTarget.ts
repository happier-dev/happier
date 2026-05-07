import type { CloudConnectTarget } from '@/cloud/connectTypes';

export const githubConnectedAccountTarget: CloudConnectTarget = {
  id: 'github',
  displayName: 'GitHub',
  vendorDisplayName: 'GitHub',
  vendorKey: 'github',
  status: 'wired',
  authenticate: async () => {
    throw new Error('GitHub OAuth device flow is not available in this build. Use token credentials or local gh authentication.');
  },
};
