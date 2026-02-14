import {
  DEFAULT_BUG_REPORTS_FEATURE,
  type BugReportsFeature,
} from '@happier-dev/protocol';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

export type { BugReportsFeature } from '@happier-dev/protocol';

export const DEFAULT_BUG_REPORT_FEATURE: BugReportsFeature = DEFAULT_BUG_REPORTS_FEATURE;

export async function fetchBugReportsFeatureFromServer(serverUrl: string): Promise<BugReportsFeature> {
  const snapshot = await fetchServerFeaturesSnapshot({ serverUrl, timeoutMs: 6000 });
  const decision = resolveCliFeatureDecision({
    featureId: 'bugReports',
    env: process.env,
    serverSnapshot: snapshot,
  });

  if (decision.state !== 'enabled' || snapshot.status !== 'ready') {
    return DEFAULT_BUG_REPORT_FEATURE;
  }

  return snapshot.features.features.bugReports;
}
