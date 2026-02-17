import {
  DEFAULT_BUG_REPORTS_CAPABILITIES,
  type BugReportsCapabilities,
} from '@happier-dev/protocol';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

export type BugReportsFeature = BugReportsCapabilities & Readonly<{ enabled: boolean }>;

export const DEFAULT_BUG_REPORT_FEATURE: BugReportsFeature = {
  enabled: false,
  ...DEFAULT_BUG_REPORTS_CAPABILITIES,
};

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

  const gateEnabled = snapshot.features.features.bugReports.enabled === true;
  if (!gateEnabled) return DEFAULT_BUG_REPORT_FEATURE;

  const capabilities = snapshot.features.capabilities.bugReports;
  if (!capabilities.providerUrl) return DEFAULT_BUG_REPORT_FEATURE;

  return {
    enabled: true,
    ...capabilities,
  };
}
