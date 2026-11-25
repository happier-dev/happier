import * as React from 'react';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import {
  projectReviewRoundReviewers,
  reviewRoundUnfinishedReviewers,
} from '@/components/reviews/reviewRoundReviewers';
import { useReviewDetail } from '@/components/reviews/useReviewDetail';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ReviewDetailSnapshot } from '@/sync/store/domains/reviews/detail';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';

/**
 * How many reviewers a Fix applies findings from (R12 M13): partial coverage names who didn't finish, through the
 * reviewer projection the Review card uses; a partial Review whose body can't be read says so; full coverage, a
 * Review still loading and any other Review say nothing.
 */
export function presentReviewApplyCoverage(
  snapshot: Pick<ReviewDetailSnapshot, 'data' | 'status'>,
): string | null {
  const unavailable = t('reviewWalkthrough.detail.reviewerCoverageUnavailable');
  if (snapshot.status === 'error' && snapshot.data === null) return unavailable;
  const data = snapshot.data;
  if (data?.review.state !== 'partial') return null;
  const round = data.partialRound;
  if (!round) return unavailable;
  const reviewers = projectReviewRoundReviewers(round, undefined);
  const unfinished = reviewRoundUnfinishedReviewers(round, reviewers);
  if (unfinished.length === 0) return unavailable;
  return joinHappierFacts(
    t('reviewWalkthrough.detail.reviewersFinishedOf', {
      count: reviewers.length - unfinished.length,
      total: reviewers.length,
    }),
    t('reviewWalkthrough.detail.reviewersDidntFinish', {
      names: joinList(unfinished.map((reviewer) => reviewer.name)),
      count: unfinished.length,
    }),
  );
}

/** The Fix (`review.apply`) approval's coverage line, read through the shared Review detail the Review card reads. */
export const ReviewApplyCoverageFact = React.memo(
  function ReviewApplyCoverageFact(
    props: Readonly<{
      actionArgs: unknown;
      serverId: string | null;
      testID: string;
    }>,
  ) {
    const reviewId = readRecord(props.actionArgs).reviewId;
    const resolution = useServerCredentialAccountScopeResolution(
      props.serverId,
    );
    const scope =
      props.serverId === null
        ? undefined
        : resolution.kind === 'bound'
          ? resolution.scope
          : null;
    const detail = useReviewDetail(
      typeof reviewId === 'string' ? reviewId : '',
      { scope },
    );
    const line =
      typeof reviewId === 'string' ? presentReviewApplyCoverage(detail) : null;
    if (line === null) return null;
    return (
      <ItemGroup>
        <Item
          testID={props.testID}
          mode="info"
          title={line}
          titleLines={0}
          showChevron={false}
        />
      </ItemGroup>
    );
  },
);
