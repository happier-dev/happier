import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useReviewList } from '@/components/reviews/useReviewList';
import { useOpenExecutionRunLauncherDraft } from '@/components/sessions/runs/launcher/useOpenExecutionRunLauncherDraft';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { useWorkflowTriggerSets } from '@/components/workflows/triggers/useWorkflowTriggerSets';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
  useActiveServerAccountScopeLifetime,
  useSessionSelector,
} from '@/sync/store/hooks';
import { t } from '@/text';

import { REVIEW_HABIT_WORKFLOW_ID } from './reviewHabit';
import {
  isSessionReviewHabitOn,
  resolveSessionReviewSuggestion,
} from './sessionReviewSuggestionDecision';

const REVIEW_HABIT_SETS = Object.freeze({ workflow: REVIEW_HABIT_WORKFLOW_ID });
/** Coverage takes the newest completed Reviews of this Session; the latest one decides what is covered. */
const COVERING_REVIEWS_PAGE = 20;

/**
 * The transcript's session-finished suggestion (lab `session-finished`): "N changed files haven't been reviewed ·
 * Review them · Review after each turn". Nothing is read while the agent works; the changes, Reviews and habit are
 * read only once it is idle, and only while it has changed files.
 */
export const SessionReviewSuggestion = React.memo(
  function SessionReviewSuggestion(
    props: Readonly<{
      sessionId: string;
      serverId?: string | null;
    }>,
  ) {
    const serverId = props.serverId ?? null;
    const thinking = useSessionSelector(
      props.sessionId,
      serverId,
      (session) => session?.thinking === true,
    );
    return thinking || !serverId ? null : (
      <IdleSessionChanges sessionId={props.sessionId} serverId={serverId} />
    );
  },
);

function IdleSessionChanges(
  props: Readonly<{ sessionId: string; serverId: string }>,
) {
  const address = React.useMemo(
    () => ({ serverId: props.serverId, sessionId: props.sessionId }),
    [props.serverId, props.sessionId],
  );
  const { sessionChangeSet } = useDerivedSessionChangeSet(address);
  return sessionChangeSet && sessionChangeSet.files.length > 0 ? (
    <ChangedSessionSuggestion
      sessionId={props.sessionId}
      serverId={props.serverId}
      changeSet={sessionChangeSet}
    />
  ) : null;
}

function ChangedSessionSuggestion(
  props: Readonly<{
    sessionId: string;
    serverId: string;
    changeSet: NonNullable<
      ReturnType<typeof useDerivedSessionChangeSet>['sessionChangeSet']
    >;
  }>,
) {
  const { sessionId, serverId } = props;
  const lifetime = useActiveServerAccountScopeLifetime();
  const sameHome =
    lifetime !== null &&
    areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, serverId);
  const reviews = useReviewList(
    {
      sourceSessionId: sessionId,
      state: 'completed',
      limit: COVERING_REVIEWS_PAGE,
    },
    { enabled: sameHome },
  );
  const sessionHabit = useWorkflowTriggerSets(
    sameHome ? { lifetimeSession: { sessionId } } : null,
    sameHome ? lifetime : null,
  );
  const accountHabit = useWorkflowTriggerSets(
    sameHome ? REVIEW_HABIT_SETS : null,
    sameHome ? lifetime : null,
  );
  const habitKnown =
    sessionHabit.status === 'ready' && accountHabit.status === 'ready';
  const suggestion = React.useMemo(
    () =>
      !sameHome || !habitKnown
        ? null
        : resolveSessionReviewSuggestion({
            sessionId,
            thinking: false,
            changeSet: props.changeSet,
            reviews: reviews.items,
            habitOn: isSessionReviewHabitOn(
              sessionHabit.sets,
              accountHabit.sets,
            ),
          }),
    [
      sameHome,
      habitKnown,
      sessionId,
      props.changeSet,
      reviews.items,
      sessionHabit.sets,
      accountHabit.sets,
    ],
  );
  const openRunDraft = useOpenExecutionRunLauncherDraft();
  const router = useRouter();
  const reviewThem = React.useCallback(() => {
    if (!lifetime?.isCurrent()) return;
    void openRunDraft({
      scope: lifetime.scope,
      sessionId,
      actionId: 'review.start',
      input: buildExecutionRunActionDraftInputForUi({
        actionId: 'review.start',
        sessionId,
        instructions: '',
      }),
    });
  }, [lifetime, openRunDraft, sessionId]);
  // The habit asks who reviews before it is saved, so it opens where it lives: Session Info › Habits.
  const reviewEachTurn = React.useCallback(() => {
    router.push({
      pathname: '/session/[id]/triggers',
      params: { id: sessionId, serverId },
    } as never);
  }, [router, serverId, sessionId]);
  return suggestion ? (
    <SuggestionLine
      count={suggestion.unreviewedCount}
      onReviewThem={reviewThem}
      onReviewEachTurn={reviewEachTurn}
    />
  ) : null;
}

function SuggestionLine(
  props: Readonly<{
    count: number;
    onReviewThem: () => void;
    onReviewEachTurn: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  // The transcript's own column, so the line sits on the message text's edge.
  const columnStyle = useLayoutMaxWidthStyle();
  return (
    <View style={styles.row}>
      <View
        style={[styles.column, columnStyle]}
        testID="session-review-suggestion"
      >
        <View style={styles.fact}>
          <Icon
            name="check-square"
            size={14}
            color={theme.colors.text.tertiary}
          />
          <Text variant="body" style={{ color: theme.colors.text.secondary }}>
            {t('reviewWalkthrough.detail.reviewSuggestionUnreviewed', {
              count: props.count,
            })}
          </Text>
        </View>
        <RoundButton
          testID="session-review-suggestion:review"
          size="small"
          display="secondary"
          title={t('reviewWalkthrough.detail.reviewSuggestionReviewThem', {
            count: props.count,
          })}
          onPress={props.onReviewThem}
        />
        <RoundButton
          testID="session-review-suggestion:habit"
          size="small"
          display="secondary"
          title={t('reviewWalkthrough.detail.reviewAfterEachTurn')}
          onPress={props.onReviewEachTurn}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s8,
  },
  column: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
  },
  fact: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
