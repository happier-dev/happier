/**
 * The PostHog PRs & Issues settings surface artifact entry.
 *
 * The page itself is `@happier-dev/triage-sources`. Every source's page
 * reads the same three published contracts — this source's own `listInstances`,
 * the target's caller-scoped configured-instance read, and the target's single
 * administration Action — and reaches the same conclusions from the same bytes,
 * so it is written once. What PostHog contributes is the three facts no shared page
 * can derive: which plugin is asking, which of its Actions enumerates what it
 * can reach, and what to call this source in a sentence.
 *
 * This file is that contribution AND the module the manifest's
 * `posthog-triage-sources-native` artifact is built from, so the exported name
 * stays `renderSurface`.
 */

import { createTriageSourceSettingsSurface } from '@happier-dev/triage-sources';

import {
  POSTHOG_ACTION_IDS,
  POSTHOG_PLUGIN_ID,
  POSTHOG_SOURCE_DISPLAY_NAME,
} from '../../posthogContracts.js';

export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: POSTHOG_PLUGIN_ID,
  listInstancesLocalActionId: POSTHOG_ACTION_IDS.listInstances,
  sourceDisplayName: POSTHOG_SOURCE_DISPLAY_NAME,
});
