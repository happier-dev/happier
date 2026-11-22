import * as React from 'react';
import type { ReviewReviewerSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';

import type { IconName } from '@/components/ui/icons/Icon';
import { useWorkflowTriggerSets } from '@/components/workflows/triggers/useWorkflowTriggerSets';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { addWorkflowTrigger } from '@/sync/domains/workflows/workflowTriggerActions';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { t } from '@/text';

import {
  buildReviewHabitTriggerRequest,
  findAccountReviewHabit,
  projectReviewHabitPlacement,
  REVIEW_HABIT_WORKFLOW_ID,
} from './reviewHabit';
import {
  ReviewHabitReviewerSetup,
  alertReviewHabitWriteFailed,
} from './ReviewHabitSetup';

const REVIEW_HABIT_SETS = Object.freeze({ workflow: REVIEW_HABIT_WORKFLOW_ID });

/**
 * The Reviews page with nothing yet (lab `list-empty`): Start a review, and Review after each turn, which sets up
 * the all-sessions review habit in place rather than a second form. The habit is the ordinary Account trigger
 * that links the built-in review; once it exists the invitation offers only Start a review.
 */
export function ReviewsEmptyInvitation(
  props: Readonly<{
    iconName: IconName;
    startReview: (() => void) | undefined;
  }>,
) {
  const lifetime = useActiveServerAccountScopeLifetime();
  const read = useWorkflowTriggerSets(REVIEW_HABIT_SETS, lifetime ?? null);
  const habit = React.useMemo(
    () => findAccountReviewHabit(read.sets),
    [read.sets],
  );
  const [settingUp, setSettingUp] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const cancel = React.useCallback(() => setSettingUp(false), []);
  const { retry } = read;
  const choose = React.useCallback(
    async (reviewer: ReviewReviewerSelectionV1) => {
      setSettingUp(false);
      const project = projectReviewHabitPlacement(reviewer);
      const request = project
        ? buildReviewHabitTriggerRequest({ kind: 'account', project }, [
            reviewer,
          ])
        : null;
      if (!request || !lifetime?.isCurrent()) return;
      setSaving(true);
      try {
        await addWorkflowTrigger(request, { accountLifetime: lifetime });
        retry();
      } catch (error) {
        alertReviewHabitWriteFailed(error);
      } finally {
        setSaving(false);
      }
    },
    [lifetime, retry],
  );
  const offerHabit =
    lifetime !== null && read.status === 'ready' && habit === null;
  return (
    <SurfaceStateCard
      testID="reviews:empty"
      kind="empty"
      iconName={props.iconName}
      title={t('reviewWalkthrough.detail.emptyTitle')}
      reason={t('reviewWalkthrough.detail.emptyReason')}
      replacesContent
      action={
        props.startReview
          ? {
              testID: 'reviews:empty:start',
              label: t('reviewWalkthrough.detail.startReview'),
              onPress: props.startReview,
            }
          : undefined
      }
      secondaryAction={
        offerHabit
          ? {
              testID: 'reviews:empty:habit',
              label: t('reviewWalkthrough.detail.reviewAfterEachTurn'),
              onPress: () => setSettingUp(true),
              disabled: saving || settingUp,
            }
          : undefined
      }
      actionFooter={
        settingUp && lifetime ? (
          <ReviewHabitReviewerSetup
            accountLifetime={lifetime}
            consumerSessionId={null}
            onChoose={(reviewer) => {
              void choose(reviewer);
            }}
            onCancel={cancel}
          />
        ) : undefined
      }
    />
  );
}
