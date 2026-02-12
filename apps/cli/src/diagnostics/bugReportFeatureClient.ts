import {
  DEFAULT_BUG_REPORTS_FEATURE,
  coerceBugReportsFeatureFromFeaturesPayload,
  type BugReportsFeature,
} from '@happier-dev/protocol';
import { normalizeBaseUrl, withAbortTimeout } from './httpClient';

export type { BugReportsFeature } from '@happier-dev/protocol';

export const DEFAULT_BUG_REPORT_FEATURE: BugReportsFeature = DEFAULT_BUG_REPORTS_FEATURE;

export async function fetchBugReportsFeatureFromServer(serverUrl: string): Promise<BugReportsFeature> {
  try {
    const response = await withAbortTimeout(6_000, async (signal) =>
      await fetch(`${normalizeBaseUrl(serverUrl)}/v1/features`, {
        method: 'GET',
        signal,
      }),
    );
    if (!response.ok) return DEFAULT_BUG_REPORT_FEATURE;
    const payload: unknown = await response.json();
    return coerceBugReportsFeatureFromFeaturesPayload(payload);
  } catch {
    return DEFAULT_BUG_REPORT_FEATURE;
  }
}
