import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { useReviewDetail } from '../useReviewDetail';
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
    onOpenReview: () => void;
    footerAction?: ReviewSummaryProps['footerAction'];
}>): React.ReactElement {
    const detail = useReviewDetail(props.reviewId, { scope: props.scope });
    const glance = projectReviewGlance(undefined, detail.data?.review ?? null);
    if (!glance) return <SurfaceStateCard kind={detail.status === 'error' ? 'error' : 'loading'}
        title={t(detail.status === 'error' ? 'common.error' : 'common.loading')}
        action={detail.status === 'error' ? { label: t('common.retry'), onPress: () => void detail.refresh() } : undefined} />;
    return <>
        <ReviewSummary subject={props.subject ?? null} glance={glance} rows={props.rows ?? []}
            more={props.more} reviewers={props.reviewers ?? []}
            onOpenReview={props.onOpenReview} footerAction={props.footerAction} />
        {detail.status === 'error' ? <SurfaceStateCard testID="review-summary:retry" kind="error" size="line"
            title={t('common.error')} action={{ label: t('common.retry'), onPress: () => void detail.refresh() }} /> : null}
    </>;
}
