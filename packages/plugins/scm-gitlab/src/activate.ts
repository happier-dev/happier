import type { PluginApi } from '@happier-dev/plugin-sdk';

import { GITLAB_SCM_HOSTING_PROVIDER_LOCAL_ID, gitlabHostingProviderAdapter } from './adapter.js';
import { gitlabConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import {
  GITLAB_CONNECTED_ACCOUNT_ID,
  GITLAB_TRIAGE_ACTION_IDS,
  GITLAB_TRIAGE_DETAIL_ACTION_IDS,
} from './triage/contribution.js';
import {
  listGitlabActivityEvents,
  listGitlabChanges,
  listGitlabDiscussions,
  listGitlabNotes,
  listGitlabPipelines,
  readGitlabApprovals,
} from './triage/detailOperations.js';
import {
  getGitlabSourceEntryAction,
  listGitlabInstancesAction,
  scanGitlabSourceAction,
} from './triage/operations.js';

/**
 * The single GitLab registration spine.
 *
 * It registers exactly what the manifest declares: the git hosting provider, the
 * `gitlab-account` Connected Account runtime, and the three Actions bound to the
 * Triage source roles. There is no scheduler, cache, refresh loop, or second
 * activation — the mounted PRs & Issues surface owns refresh demand and each
 * source operation performs one requested read and returns.
 */
export function activate(api: PluginApi): void {
  api.connectedAccounts.register(GITLAB_CONNECTED_ACCOUNT_ID, gitlabConnectedAccountRuntime);
  api.scm.registerHostingProvider(GITLAB_SCM_HOSTING_PROVIDER_LOCAL_ID, {
    adapter: gitlabHostingProviderAdapter,
  });
  api.actions.register(GITLAB_TRIAGE_ACTION_IDS.listInstances, listGitlabInstancesAction);
  api.actions.register(GITLAB_TRIAGE_ACTION_IDS.scan, scanGitlabSourceAction);
  api.actions.register(GITLAB_TRIAGE_ACTION_IDS.get, getGitlabSourceEntryAction);
  // The six source-native detail planes the mounted merge-request and issue tab
  // compositions read. They are this plugin's own Actions and nothing outside
  // its detail artifact reaches them.
  api.actions.register(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listNotes, listGitlabNotes);
  api.actions.register(
    GITLAB_TRIAGE_DETAIL_ACTION_IDS.listActivityEvents,
    listGitlabActivityEvents,
  );
  api.actions.register(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listDiscussions, listGitlabDiscussions);
  api.actions.register(GITLAB_TRIAGE_DETAIL_ACTION_IDS.readApprovals, readGitlabApprovals);
  api.actions.register(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listPipelines, listGitlabPipelines);
  api.actions.register(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges, listGitlabChanges);
}
