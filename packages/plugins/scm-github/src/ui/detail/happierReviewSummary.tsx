import * as React from 'react';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import {
  Banner, Button, ErrorState, HappierPageSheet, HappierReviewSummary, HAPPIER_PAGE_METRICS,
  HAPPIER_WORK_STATUS_BUCKET_LABEL_KEYS,
  LoadingState, Stack, projectHappierReviewGlance, resolveHappierWorkTheme,
  usePluginTheme, usePluginTranslation,
} from '@happier-dev/plugin-ui/components';
import {
  useLivePluginResourceProjection, usePluginHostApi, type PluginUiResourceProjection,
  type PluginUiResourceProjectionSnapshot,
} from '@happier-dev/plugin-ui/hostApi';
import { useTriagePageRefresh } from '@happier-dev/triage-sources/ui';

type ReviewDetail = PluginActionResultById['review.get'];
const NO_ROWS = [] as const;
const reviewProjection: PluginUiResourceProjection<ReviewDetail> = {
  decode(content, previous) {
    // The admitted host Resource serializes the canonical Review detail owner's typed result.
    const next = JSON.parse(new TextDecoder().decode(content.bytes)) as ReviewDetail;
    return previous && pluginJsonValuesEqual(previous, next) ? previous : next;
  },
};
const selectReview = (snapshot: PluginUiResourceProjectionSnapshot<ReviewDetail>) => snapshot;

/** A PR without an admitted relation neither scans Reviews nor acquires a Review reader. */
export function GithubHappierReviewSummary({ reviewId }: Readonly<{ reviewId?: string }>): React.ReactElement | null {
  return reviewId === undefined ? null : <AdmittedReviewSummary key={reviewId} reviewId={reviewId} />;
}

function AdmittedReviewSummary({ reviewId }: Readonly<{ reviewId: string }>): React.ReactElement {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const { palette } = resolveHappierWorkTheme(usePluginTheme());
  const resource = useLivePluginResourceProjection({ hostRead: 'review.get', input: { reviewId } }, reviewProjection, selectReview);
  useTriagePageRefresh(resource.refresh);
  const detail = resource.value;
  const glance = projectHappierReviewGlance(undefined, detail.value?.review ?? null, {
    running: text('happier.plugin-ui.review.glance.running', 'Reviewing…'),
    failed: text('happier.plugin-ui.review.glance.failed', 'The review couldn’t finish'),
    noFindings: text('happier.plugin-ui.review.glance.noFindings', 'Nothing to fix'),
    allDecided: text('happier.plugin-ui.review.glance.allDecided', 'Every finding is decided'),
    toDecide: count => text(`happier.plugin-ui.review.glance.toDecide.${count === 1 ? 'one' : 'other'}`,
      count === 1 ? '1 finding to decide' : '{count} findings to decide', { count }),
    findingsCount: count => text(`happier.plugin-ui.review.glance.findingsCount.${count === 1 ? 'one' : 'other'}`,
      count === 1 ? '1 finding' : '{count} findings', { count }),
  });
  const unavailable = text('happier.plugin-ui.review.unavailable', 'This review didn’t open');
  return <HappierPageSheet colors={palette} rowDividers={false}>
    <Stack gap="small" style={{ paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
      paddingVertical: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx }}>
      {glance === null ? detail.error
        ? <ErrorState title={unavailable} />
        : <LoadingState />
        : <>
          <HappierReviewSummary heading={text('happier.plugin-ui.review.heading', 'Review')} subject={null}
            status={detail.value?.human.needsYou.needsYou
              ? { label: text(HAPPIER_WORK_STATUS_BUCKET_LABEL_KEYS.needs_you, 'Needs you'), tone: 'attention' } : undefined}
            glance={glance} rows={NO_ROWS} reviewers=""
            actions={<Button title={text('happier.plugin-ui.review.open', 'Open review')} variant="secondary" size="small"
              onPress={async () => {
                try { await host.openResource({ kind: 'artifact', artifactId: reviewId }); }
                catch { await host.notify(text('happier.plugin-ui.action.error.failed', 'The action failed.'), { severity: 'error' }); }
              }} />} />
          {detail.error ? <Banner tone="warning" title={unavailable} /> : null}
        </>}
    </Stack>
  </HappierPageSheet>;
}
