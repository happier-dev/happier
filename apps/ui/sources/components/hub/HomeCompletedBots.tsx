import * as React from 'react';

import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import { useHomeCompletedBots } from '@/activity/source/useActivityOverview';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { readSessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { useWorkRelativeTime } from '@/components/sessions/agents/presentation/agentActivityClock';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useInboxReadySessionResult } from '@/hooks/inbox/useInboxReadySessionResult';
import { useInboxSessionReadMarking } from '@/hooks/inbox/useInboxSessionReadMarking';
import { readSessionListPresentationDisplay } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { t } from '@/text';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';

/** R6 list form: rows carry the Bot's face at its largest still list size. */
const FACE_SIZE = 32;

/**
 * Home's "Done while you were away": Inbox's ready Sessions that are Bots, each with what it did, the
 * Habit that ran that turn when known, and when it finished. Membership, read targets and the result
 * come from the Inbox owners; the section is absent when nothing is unread.
 */
export const HomeCompletedBots = React.memo(function HomeCompletedBots() {
  const isSessionVisible = useSessionRecordingVisibility();
  const { source, readySessions, markAllReadTargets } = useHomeCompletedBots(isSessionVisible);
  const reading = useInboxSessionReadMarking(markAllReadTargets, source);
  const router = useRouter();
  const open = React.useCallback(
    (route: string) => router.push(route as never),
    [router],
  );
  if (readySessions.length === 0) return null;
  const markAllDisabled =
    reading.markAllPending || Boolean(reading.markAllReadUnavailableReason);
  return (
    <ItemGroup
      testID="home.completed-bots"
      title={t('homeIndex.completedBotsTitle')}
      action={
        <SectionActionButton
          testID="home.completed-bots.mark_all_read"
          title={t('inbox.markAllRead')}
          icon="checks"
          disabled={markAllDisabled}
          accessibilityHint={reading.markAllReadUnavailableReason ?? undefined}
          onPress={() => {
            if (!markAllDisabled) void reading.markRead(markAllReadTargets);
          }}
        />
      }
    >
      {readySessions.map((candidate) => {
        const serverId =
          candidate.address?.serverId ?? candidate.serverId ?? null;
        return (
          <HomeCompletedBotRow
            key={buildServerScopedSessionKey(candidate.sessionId, serverId)}
            candidate={candidate}
            serverId={serverId}
            onOpen={open}
          />
        );
      })}
    </ItemGroup>
  );
});

const HomeCompletedBotRow = React.memo(function HomeCompletedBotRow(
  props: Readonly<{
    candidate: SessionActivityAttention;
    serverId: string | null;
    onOpen: (route: string) => void;
  }>,
) {
  const { candidate, serverId, onOpen } = props;
  const result = useInboxReadySessionResult(candidate);
  const facts = React.useMemo(
    () =>
      readSessionBotFaceFacts(
        candidate.presentationSource
          ? readSessionListPresentationDisplay(candidate.presentationSource)
          : candidate.session,
        serverId,
      ),
    [candidate.presentationSource, candidate.session, serverId],
  );
  const completedAt = result.completedAt;
  const time = useWorkRelativeTime(completedAt ?? 0);
  const habit = result.workflowInvocation?.label ?? null;
  const testID = `home.completed-bots.${serverId ?? 'local'}.${candidate.sessionId}`;
  const route = candidate.route;
  return (
    <Item
      testID={testID}
      title={
        result.preview.state === 'available'
          ? result.preview.text
          : candidate.title
      }
      titleLines={1}
      subtitle={result.preview.state === 'available'
        ? habit ? `${candidate.title} · ${habit}` : candidate.title
        // No preview is not no result: the row says so and stays the way in to read it.
        : habit ? `${habit} · ${t('homeIndex.completedBotPreviewUnavailable')}` : t('homeIndex.completedBotPreviewUnavailable')}
      subtitleTestID={`${testID}.subtitle`}
      leftElement={
        facts ? <SessionBotFace facts={facts} size={FACE_SIZE} motion="interaction" /> : undefined
      }
      detail={completedAt !== null ? time : undefined}
      onPress={route ? () => onOpen(route) : undefined}
      showChevron
    />
  );
});
