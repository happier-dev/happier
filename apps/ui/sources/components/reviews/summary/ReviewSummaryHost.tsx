import * as React from 'react';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';
import { useReviewDetail } from '../useReviewDetail';
import { projectReviewGlance } from '../detail/reviewGlance';
import { projectReviewRoundReviewers, reviewRoundUnfinishedReviewers } from '../reviewRoundReviewers';
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
    const partialRound = detail.data?.partialRound;
    const unfinished = React.useMemo(() => partialRound
        ? reviewRoundUnfinishedReviewers(partialRound, projectReviewRoundReviewers(partialRound, undefined)) : [], [partialRound]);
    const glance = projectReviewGlance(undefined, detail.data?.review ?? null,
        { needsYou: detail.data?.human.needsYou, workflowFailureCode: props.workflowFailureCode });
    if (!glance) return <SurfaceStateCard kind={detail.status === 'error' ? 'error' : 'loading'}
        title={t(detail.status === 'error' ? 'common.error' : 'common.loading')}
        action={detail.status === 'error' ? { label: t('common.retry'), onPress: () => void detail.refresh() } : undefined} />;
    const summary = unfinished.length === 0 ? glance : { ...glance,
        sentence: joinHappierFacts(glance.sentence, t('reviewWalkthrough.detail.reviewersDidntFinish', {
            names: joinList(unfinished.map(reviewer => reviewer.name)), count: unfinished.length,
        })),
    };
    return <>
        <ReviewSummary subject={props.subject ?? null} glance={summary} rows={props.rows ?? []}
            more={props.more} reviewers={props.reviewers ?? []}
            {...(props.onOpenReview ? { onOpenReview: props.onOpenReview } : {})} footerAction={props.footerAction} />
        {detail.status === 'error' ? <SurfaceStateCard testID="review-summary:retry" kind="error" size="line"
            title={t('common.error')} action={{ label: t('common.retry'), onPress: () => void detail.refresh() }} /> : null}
    </>;
}
