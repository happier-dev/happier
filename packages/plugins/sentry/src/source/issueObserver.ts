import { createTriageIssueEventSourceAdapterV1, createTriageIssueHistoryGapResetV1 } from '@happier-dev/triage-sources/runtime';
import { runCheckpointedPluginEventObserverV1, readCheckpointedPluginEventSourcesV1, type BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { SENTRY_CONTRIBUTION_ID, SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT, SENTRY_PLUGIN_ID } from '../sentryContracts.js';
import { scanSentrySource } from './operations.js';

export const resetSentryIssueHistoryGap = createTriageIssueHistoryGapResetV1({
  pluginId: SENTRY_PLUGIN_ID, sourceLocalId: SENTRY_CONTRIBUTION_ID,
}, readCheckpointedPluginEventSourcesV1);

/** Sentry owns finite pages/rate evidence; the public SDK owns the observer lifetime. */
export async function runSentryIssueObserver(context: BackgroundServiceContext): Promise<void> {
  await runCheckpointedPluginEventObserverV1({ context, source: createTriageIssueEventSourceAdapterV1({
    pluginId: SENTRY_PLUGIN_ID, sourceLocalId: SENTRY_CONTRIBUTION_ID, displayName: 'Sentry',
    scanLimit: SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT, scan: scanSentrySource,
  }) });
}
