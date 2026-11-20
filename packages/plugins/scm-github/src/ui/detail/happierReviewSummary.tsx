import * as React from 'react';
import { HappierReviewSummaryHost, type HappierReviewSummaryHandle } from '@happier-dev/plugin-ui/components';
import { useTriagePageRefresh } from '@happier-dev/triage-sources/ui';

/** An unbound PR opens no Review reader; admitted ones use the shared finding/window owner. */
export function GithubHappierReviewSummary({ reviewId }: Readonly<{ reviewId?: string }>): React.ReactElement | null {
  return reviewId === undefined ? null : <AdmittedReviewSummary key={reviewId} reviewId={reviewId} />;
}

function AdmittedReviewSummary({ reviewId }: Readonly<{ reviewId: string }>): React.ReactElement {
  const summary = React.useRef<HappierReviewSummaryHandle>(null);
  const refresh = React.useCallback(async () => { await summary.current?.refresh(); }, []);
  useTriagePageRefresh(refresh);
  return <HappierReviewSummaryHost ref={summary} reviewId={reviewId} />;
}
