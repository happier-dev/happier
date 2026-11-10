import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { githubAccountCredentialRuntime } from './auth/credentialMaterialization.js';
import { GITHUB_CONNECTED_ACCOUNT_ID } from './observations/githubProviderContracts.js';
import { GITHUB_ACCOUNT_READ_ACTIONS } from './triage/readActions.js';
import { disposeGithubAccountRequestLifetimeV1 } from './observations/githubApiClient.js';
import { GITHUB_OVERVIEW_TARGET_ACTIONS_V1 } from './actions/overview.js';
import { GITHUB_PROJECT_READINESS_ACTIONS_V1 } from './actions/projectReadiness.js';

export function activate(api: PluginAccountApi): () => void {
  const githubRequestLifetime = {};
  api.connectedAccounts.register(GITHUB_CONNECTED_ACCOUNT_ID, githubAccountCredentialRuntime);
  for (const [id, action] of Object.entries(GITHUB_ACCOUNT_READ_ACTIONS)) {
    api.actions.register(id, (input, context) => {
      const invocation = { ...context, githubRequestLifetime };
      return action.run(input, invocation);
    }, action.observeRead ? { observeRead: action.observeRead } : undefined);
  }
  for (const [id, action] of Object.entries({ ...GITHUB_OVERVIEW_TARGET_ACTIONS_V1, ...GITHUB_PROJECT_READINESS_ACTIONS_V1 })) {
    api.actions.register(id, (input, context) => action.run(input, { ...context, githubRequestLifetime }));
  }
  return () => disposeGithubAccountRequestLifetimeV1(githubRequestLifetime);
}
