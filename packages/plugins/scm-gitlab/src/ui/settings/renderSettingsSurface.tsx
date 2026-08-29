/**
 * The GitLab PRs & Issues settings surface artifact entry.
 *
 * The page itself is `@happier-dev/triage-sources`. Every source's page
 * reads the same three published contracts — this source's own `listInstances`,
 * the target's caller-scoped configured-instance read, and the target's single
 * administration Action — and reaches the same conclusions from the same bytes,
 * so it is written once. What GitLab contributes is the three facts no shared page
 * can derive: which plugin is asking, which of its Actions enumerates what it
 * can reach, and what to call this source in a sentence.
 *
 * This file is that contribution AND the module the manifest's
 * `gitlab-triage-sources-native` artifact is built from, so the exported name
 * stays `renderSurface`.
 */

import { createTriageSourceSettingsSurface } from '@happier-dev/triage-sources';

import {
  GITLAB_PLUGIN_ID,
  GITLAB_CONNECTED_ACCOUNT_ID,
  GITLAB_TRIAGE_ACTION_IDS,
  GITLAB_TRIAGE_SOURCE_DESCRIPTOR_V1,
} from '../../triage/contribution.js';

export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: GITLAB_PLUGIN_ID,
  listInstancesLocalActionId: GITLAB_TRIAGE_ACTION_IDS.listInstances,
  connectedAccountServiceLocalId: GITLAB_CONNECTED_ACCOUNT_ID,
  sourceDisplayName: GITLAB_TRIAGE_SOURCE_DESCRIPTOR_V1.displayName,
});
