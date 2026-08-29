/**
 * The Bitbucket Cloud PRs & Issues settings surface artifact entry.
 *
 * The page itself is `@happier-dev/triage-sources`. Every source's page
 * reads the same three published contracts — this source's own `listInstances`,
 * the target's caller-scoped configured-instance read, and the target's single
 * administration Action — and reaches the same conclusions from the same bytes,
 * so it is written once. What Bitbucket Cloud contributes is the three facts no shared page
 * can derive: which plugin is asking, which of its Actions enumerates what it
 * can reach, and what to call this source in a sentence.
 *
 * This file is that contribution AND the module the manifest's
 * `bitbucket-triage-sources-native` artifact is built from, so the exported name
 * stays `renderSurface`.
 */

import { createTriageSourceSettingsSurface } from '@happier-dev/triage-sources';

import { BITBUCKET_PLUGIN_ID } from '../../bitbucketContracts.js';
import { BITBUCKET_TRIAGE_ACTION_IDS } from '../../triage/source/actions.js';
import { BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID, BITBUCKET_TRIAGE_DESCRIPTOR } from '../../triage/source/descriptor.js';

export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: BITBUCKET_PLUGIN_ID,
  listInstancesLocalActionId: BITBUCKET_TRIAGE_ACTION_IDS.listInstances,
  connectedAccountServiceLocalId: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID,
  sourceDisplayName: BITBUCKET_TRIAGE_DESCRIPTOR.displayName,
});
