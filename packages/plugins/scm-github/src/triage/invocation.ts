import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type { GithubHttpInvocationContextV1 } from '../observations/githubHttpInvocation.js';

/** The same finite HTTP operations run with these ports in Account and daemon hosts. */
export type GithubTriageInvocationContext = GithubHttpInvocationContextV1 & Readonly<{
  services: Pick<PluginAccountActionContext['services'], 'http' | 'connectedAccounts' | 'actions'>;
}>;

/** Account hosts capture purpose lifetime at admission; native hosts expose its watcher. */
export type GithubTriageObservationContext = GithubTriageInvocationContext & Readonly<{
  services: Readonly<{ connectedAccounts: Partial<Pick<ConnectedAccountsService, 'watch'>> }>;
}>;
