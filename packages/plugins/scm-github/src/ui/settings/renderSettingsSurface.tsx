/**
 * The GitHub PRs & Issues settings surface artifact entry.
 *
 * The page itself is `@happier-dev/triage-sources`. Every source's page
 * reads the same three published contracts — this source's own `listInstances`,
 * the target's caller-scoped configured-instance read, and the target's single
 * administration Action — and reaches the same conclusions from the same bytes,
 * so it is written once. What GitHub contributes is the three facts no shared page
 * can derive: which plugin is asking, which of its Actions enumerates what it
 * can reach, and what to call this source in a sentence.
 *
 * This file is that contribution AND the module the manifest's
 * `github-triage-sources-native` artifact is built from, so the exported name
 * stays `renderSurface`.
 */

import { createTriageSourceSettingsSurface } from '@happier-dev/triage-sources';

import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import {
  GITHUB_TRIAGE_ACTION_IDS_V1,
  GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
} from '../../triage/contribution.js';

export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: GITHUB_PLUGIN_ID,
  listInstancesLocalActionId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances,
  sourceDisplayName: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.displayName,
});
