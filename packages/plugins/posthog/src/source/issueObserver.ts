import type { ActionContract } from '@happier-dev/plugin-sdk/actions';
import type { TriageScanInputV1, TriageScanResultV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageIssueEventSourceAdapterV1, createTriageIssueHistoryGapResetV1 } from '@happier-dev/triage-sources/runtime';
import { runCheckpointedPluginEventObserverV1, readCheckpointedPluginEventSourcesV1, type BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { POSTHOG_ACTION_IDS, POSTHOG_PLUGIN_ID, POSTHOG_SOURCE_CONTRIBUTION_ID } from '../posthogContracts.js';
import { POSTHOG_ISSUES_QUERY_MAX_LIMIT } from './scan/request.js';

const scanAction = {
  pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.scan,
} as ActionContract<TriageScanInputV1, TriageScanResultV1>;

export const resetPosthogIssueHistoryGap = createTriageIssueHistoryGapResetV1({
  pluginId: POSTHOG_PLUGIN_ID, sourceLocalId: POSTHOG_SOURCE_CONTRIBUTION_ID,
}, readCheckpointedPluginEventSourcesV1);

/** PostHog owns finite pages/rate evidence; the public SDK owns the observer lifetime. */
export async function runPosthogIssueObserver(context: BackgroundServiceContext): Promise<void> {
  await runCheckpointedPluginEventObserverV1({ context, source: createTriageIssueEventSourceAdapterV1({
    pluginId: POSTHOG_PLUGIN_ID, sourceLocalId: POSTHOG_SOURCE_CONTRIBUTION_ID, displayName: 'PostHog',
    scanLimit: POSTHOG_ISSUES_QUERY_MAX_LIMIT,
    scan: (input, context) => context.services.actions.execute(scanAction, input, { signal: context.signal }),
  }) });
}
