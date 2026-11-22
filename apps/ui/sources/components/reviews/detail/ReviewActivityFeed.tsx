import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Timeline, type TimelineItemContent } from '@happier-dev/plugin-ui';

import { hasAgentIconMark, isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { reviewRoundReviewerOutcomeLabel } from '../reviewRoundReviewers';
import { reviewFindingDecisionLabel } from '@/components/sessions/reviews/findings/ReviewFindingRow';
import {
  presentSharePrincipal,
  sharePrincipalKey,
} from '@/components/sharing/sharePrincipalPresentation';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import type {
  ReviewActivityActor,
  ReviewActivityEvent,
} from './reviewActivity';

const VERDICT_WORDS = {
  approve: 'reviewWalkthrough.detail.eventApproved',
  request_changes: 'reviewWalkthrough.detail.eventRequestedChanges',
  comment: 'reviewWalkthrough.detail.eventCommented',
} as const;

const keyOf = (event: ReviewActivityEvent) => event.id;

/**
 * The Review's Activity tab (lab `detail-activity`): the shared Timeline as an events log, each line leading with
 * who acted ("You", a person, a reviewer Agent) and what they did, the time in the end column.
 */
export const ReviewActivityFeed = React.memo(function ReviewActivityFeed(
  props: Readonly<{
    events: readonly ReviewActivityEvent[];
    viewerAccountId: string | null;
    /** People's names by share-principal key, from the page's one names read. */
    names: ReadonlyMap<string, string> | null;
  }>,
) {
  const { theme } = useUnistyles();
  const { viewerAccountId, names } = props;
  const renderItem = React.useCallback(
    (event: ReviewActivityEvent): TimelineItemContent => {
      const actor = event.actor
        ? presentActor(event.actor, viewerAccountId, names, theme)
        : null;
      return {
        glyph: actor?.mark ?? (
          <Icon
            name={
              event.kind === 'roundFinished' && event.state !== 'completed'
                ? 'warning-circle'
                : event.kind === 'roundFinished'
                  ? 'check-circle'
                  : 'circle'
            }
            size={ICON_SIZE.sm}
            color={theme.colors.text.secondary}
          />
        ),
        heading: (
          <Text
            variant="reading"
            style={styles.sentence}
            testID={`review-activity:${event.id}`}
          >
            {actor ? (
              <Text variant="reading" emphasis="medium" style={styles.sentence}>
                {actor.label}
              </Text>
            ) : null}
            {actor ? ' ' : null}
            {eventSentence(event)}
          </Text>
        ),
        time: (
          <Text variant="meta" style={styles.time}>
            {formatAsOfTime(event.at)}
          </Text>
        ),
      };
    },
    [names, theme, viewerAccountId],
  );
  return (
    // The public Timeline on a core page: the app's theme, type roles and icons, as a plugin surface receives them.
    // The log stands on the sections' sheet edge, like the tab line above it, rather than hanging into the gutter.
    <CorePluginUiPresentationScope>
      <View style={styles.log}>
      <Timeline<ReviewActivityEvent>
        inline
        timeAlign="end"
        accessibilityLabel={t('reviewWalkthrough.detail.tabActivity')}
        items={props.events}
        keyForItem={keyOf}
        renderItem={renderItem}
      />
      </View>
    </CorePluginUiPresentationScope>
  );
});

function presentActor(
  actor: ReviewActivityActor,
  viewerAccountId: string | null,
  names: ReadonlyMap<string, string> | null,
  theme: Parameters<typeof hasAgentIconMark>[1],
): Readonly<{ label: string; mark: React.ReactNode }> {
  if (actor.kind === 'account') {
    const ref = { kind: 'account' as const, accountId: actor.accountId };
    const presented = presentSharePrincipal({
      ref,
      name: names?.get(sharePrincipalKey(ref)) ?? null,
      viewerAccountId,
    });
    return {
      label:
        actor.accountId === viewerAccountId
          ? t('reviewWalkthrough.detail.you')
          : presented.displayName,
      mark: presented.avatar ? (
        <Avatar
          id={presented.avatar.id}
          imageUrl={presented.avatar.imageUrl ?? null}
          size={18}
        />
      ) : null,
    };
  }
  if (actor.kind === 'agent') {
    const label = isBundledAgentId(actor.agentId)
      ? resolveAgentCatalogTitle(actor.agentId)
      : actor.agentId;
    return {
      label,
      mark: hasAgentIconMark(actor.agentId, theme) ? (
        <AgentIcon agentId={actor.agentId} size={ICON_SIZE.sm} />
      ) : null,
    };
  }
  return { label: actor.name, mark: null };
}

function eventSentence(event: ReviewActivityEvent): string {
  switch (event.kind) {
    case 'decided':
      return t('reviewWalkthrough.detail.eventDecided', {
        decision: reviewFindingDecisionLabel(event.decision),
        title: event.title,
      });
    case 'fixed':
      return t('reviewWalkthrough.detail.eventFixed', { title: event.title });
    case 'verdict':
      return t(VERDICT_WORDS[event.verdict]);
    case 'reviewerFinished':
      return reviewRoundReviewerOutcomeLabel(event.outcome);
    case 'roundStarted':
      return t('reviewWalkthrough.detail.eventRoundStarted', {
        round: event.round,
      });
    case 'roundFinished':
      return event.state === 'completed'
        ? t('reviewWalkthrough.detail.eventRoundFinished', {
            round: event.round,
          })
        : event.state === 'partial'
          ? t('reviewWalkthrough.detail.eventRoundPartial', {
              round: event.round,
            })
          : t('reviewWalkthrough.detail.eventRoundFailed', {
              round: event.round,
            });
  }
}

const LOG_INSET_PX = resolveItemGroupContentHorizontalInsetPx();

const styles = StyleSheet.create((theme) => ({
  log: { paddingHorizontal: LOG_INSET_PX },
  sentence: { color: theme.colors.text.primary },
  time: { color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
}));
