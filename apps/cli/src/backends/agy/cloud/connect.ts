import type { CloudConnectTarget } from '@/cloud/connectTypes';
import { AGY_OAUTH_SCOPES, AgyOauthAccountError } from '@happier-dev/agents';
import { ConnectedServiceImportProviderError } from '@/cloud/connectedServices/connectedServiceImportProviderError';
import { authenticateAgy } from './authenticate';
import { importAgyCredentials } from './importCredentials';

export const agyCloudConnect: CloudConnectTarget = {
  id: 'agy', displayName: 'Antigravity (AGY)', vendorDisplayName: 'Antigravity', vendorKey: 'antigravity', status: 'wired',
  requireSameProviderAccount: true,
  authenticate: authenticateAgy,
  importCredentials: async (opts) => {
    try {
      const oauth = await importAgyCredentials(opts);
      const scopes = new Set(typeof oauth.scope === 'string' ? oauth.scope.split(/\s+/) : []);
      return { oauth, requiresBrowserReauthorization: !AGY_OAUTH_SCOPES.every((scope) => scopes.has(scope)) };
    } catch (error) {
      if (error instanceof AgyOauthAccountError) {
        throw new ConnectedServiceImportProviderError(error.kind === 'ineligible' ? 'account_ineligible' : 'project_required');
      }
      throw error;
    }
  },
};
