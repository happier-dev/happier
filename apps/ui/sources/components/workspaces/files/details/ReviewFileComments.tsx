import * as React from 'react';
import { useRouter } from 'expo-router';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

import { artifactViewRoute } from '@/components/artifacts/artifactViewRoute';
import { ReviewFindingAnchorContext } from '@/components/reviews/ReviewFindingAnchor';
import { filterReviewChangesComments } from '@/components/reviews/detail/reviewChangesComments';
import { useReviewCommentDraftWriter } from '@/components/reviews/useReviewCommentDraftWriter';
import { useReviewComments } from '@/components/sessions/reviews/findings/useReviewRunComments';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import type { CapturedFileReviewContext } from '@/utils/url/sessionFileDeepLink';

export type FileReviewCommentsBinding = Readonly<{
    comments: readonly ReviewCommentV1[];
    save: (draft: ReviewCommentDraft) => Promise<void>;
    notice: React.ReactNode;
}>;

type ReviewFileCommentsProps = Readonly<{
    serverId: string;
    review: CapturedFileReviewContext;
    children: (binding: FileReviewCommentsBinding) => React.ReactNode;
}>;

export function ReviewFileComments(props: ReviewFileCommentsProps) {
    const accountScope = useActiveServerAccountScope(props.serverId);
    return accountScope ? <BoundReviewFileComments {...props} accountScope={accountScope} />
        : <SurfaceStateCard kind="loading" title={t('common.loading')} />;
}

function BoundReviewFileComments(props: ReviewFileCommentsProps & Readonly<{ accountScope: ServerAccountScope }>) {
    const presented = useLayoutPresentationActive();
    const comments = useReviewComments({ scope: props.accountScope, reviewId: props.review.reviewId, enabled: presented });
    const roundComments = React.useMemo(() => filterReviewChangesComments(comments.comments,
        { roundOrdinal: props.review.roundOrdinal, reviewerId: null }), [comments.comments, props.review.roundOrdinal]);
    const save = useReviewCommentDraftWriter(props.accountScope, props.review.reviewId, props.review.roundOrdinal);
    const router = useRouter();
    const openFinding = useEventCallback((commentId: string) => router.push(artifactViewRoute(props.review.reviewId, { thread: commentId })));
    const notice = <>
        {comments.status === 'idle' || comments.status === 'loading'
            ? <SurfaceStateCard kind="loading" size="line" title={t('common.loading')} /> : null}
        {comments.status === 'failed' ? <SurfaceStateCard kind="error" size="line" title={t('common.error')}
            action={{ label: t('common.retry'), onPress: () => void comments.refresh() }} /> : null}
        {comments.cursor ? <TextLinkButton disabled={comments.loadingMore}
            label={t(comments.loadMoreFailed ? 'common.retry' : 'files.reviewComments.durable.showMore')}
            onPress={() => void comments.loadMore()} /> : null}
    </>;
    return <ReviewFindingAnchorContext.Provider value={openFinding}>
        {props.children({ comments: roundComments, save, notice })}
    </ReviewFindingAnchorContext.Provider>;
}
