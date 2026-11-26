import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { useReviewDetail } from '../useReviewDetail';
import { ReviewReadFailure } from '../ReviewReadFailure';
import { projectReviewGlance } from '../detail/reviewGlance';
import { ReviewSummary, type ReviewSummaryProps } from './ReviewSummary';

/** One opened embedded Review; metadata and comments keep their existing Account-bound readers. */
export function ReviewSummaryHost(props: Readonly<{
    reviewId: string;
    scope?: ServerAccountScope | null;
    subject?: string | null;
    rows?: ReviewSummaryProps['rows'];
    more?: ReviewSummaryProps['more'];
    reviewers?: ReviewSummaryProps['reviewers'];
    onOpenReview?: () => void;
    footerAction?: ReviewSummaryProps['footerAction'];
    workflowFailureCode?: string | null;
}>): React.ReactElement {
    const detail = useReviewDetail(props.reviewId, { scope: props.scope });
    const glance = projectReviewGlance(undefined, detail.data?.review ?? null,
        { needsYou: detail.data?.human.needsYou, workflowFailureCode: props.workflowFailureCode });
    if (!glance) return detail.error
        ? <ReviewReadFailure failure={detail.error} onRetry={detail.refresh} />
        : <SurfaceStateCard kind="loading" title={t('common.loading')} />;
    return <>
        <ReviewSummary subject={props.subject ?? null} glance={glance} rows={props.rows ?? []}
            more={props.more} reviewers={props.reviewers ?? []}
            {...(props.onOpenReview ? { onOpenReview: props.onOpenReview } : {})} footerAction={props.footerAction} />
        {detail.error ? <ReviewReadFailure testID="review-summary:retry" size="line"
            failure={detail.error} onRetry={detail.refresh} /> : null}
    </>;
}
