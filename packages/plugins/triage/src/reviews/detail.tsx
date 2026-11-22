import * as React from 'react';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { ErrorState, defineUiSurface, usePluginTranslation } from '@happier-dev/plugin-ui';
import { HappierReviewSummaryHost, type HappierReviewSummaryHandle } from '@happier-dev/plugin-ui/components';
import { useTriagePageRefresh } from '@happier-dev/triage-sources/ui';
import { isReviewTriageEntryRefV1, TriageDetailSurfaceInputV1Schema, type TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';

export function readReviewDetailInput(value: unknown): TriageDetailSurfaceInputV1 | null {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(value);
    if (!parsed.success) return null;
    const ref = parsed.data.observation.entryRef;
    return isReviewTriageEntryRefV1(ref) ? parsed.data : null;
}

/**
 * Triage owns the entry heading and its actions; the body is the shared Review summary (the same one a pull
 * request embeds), whose own Open review is the way to decide. The Review is this page's subject, so that way leads
 * while a finding still waits for a decision. Review content and decisions stay in the Review.
 */
export function ReviewDetail({ input }: Readonly<{ context: RenderContext; input: TriageDetailSurfaceInputV1 | null }>): React.ReactElement {
    const text = usePluginTranslation();
    if (input === null) return <ErrorState title={text('plugins.triage.reviews.unavailable', 'This Review could not be opened')} />;
    const reviewId = input.observation.entryRef.entryId;
    return <ReviewSummary key={reviewId} reviewId={reviewId} />;
}

function ReviewSummary({ reviewId }: Readonly<{ reviewId: string }>): React.ReactElement {
    const summary = React.useRef<HappierReviewSummaryHandle>(null);
    const refresh = React.useCallback(async () => { await summary.current?.refresh(); }, []);
    useTriagePageRefresh(refresh);
    return <HappierReviewSummaryHost ref={summary} reviewId={reviewId} leadsPage />;
}

export const renderSurface: RenderSurface = defineUiSurface(context => <ReviewDetail context={context} input={readReviewDetailInput(context.launchInput)} />);
