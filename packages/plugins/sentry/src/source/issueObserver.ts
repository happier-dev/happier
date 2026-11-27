import type { ActionContract } from '@happier-dev/plugin-sdk/actions';
import type { TriageScanInputV1, TriageScanResultV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageIssueEventSourceAdapterV1, createTriageIssueHistoryGapResetV1 } from '@happier-dev/triage-sources/runtime';
import { runCheckpointedPluginEventObserverV1, readCheckpointedPluginEventSourcesV1, type BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { SENTRY_ACTION_IDS, SENTRY_CONTRIBUTION_ID, SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT, SENTRY_PLUGIN_ID } from '../sentryContracts.js';

const scanAction = {
  pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.scan,
} as ActionContract<TriageScanInputV1, TriageScanResultV1>;

export const resetSentryIssueHistoryGap = createTriageIssueHistoryGapResetV1({
  pluginId: SENTRY_PLUGIN_ID, sourceLocalId: SENTRY_CONTRIBUTION_ID,
}, readCheckpointedPluginEventSourcesV1);

/** Sentry owns finite pages/rate evidence; the public SDK owns the observer lifetime. */
export async function runSentryIssueObserver(context: BackgroundServiceContext): Promise<void> {
  await runCheckpointedPluginEventObserverV1({ context, source: createTriageIssueEventSourceAdapterV1({
    pluginId: SENTRY_PLUGIN_ID, sourceLocalId: SENTRY_CONTRIBUTION_ID, displayName: 'Sentry',
    scanLimit: SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT,
    scan: (input, context) => context.services.actions.execute(scanAction, input, { signal: context.signal }),
  }) });
}
