import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import {
  findExchangeCheckInRoot,
  SessionExchangeCheckInBanner,
} from '@/components/sessions/pending/ExchangeCheckInBanner';
import { getStorage } from '@/sync/domains/state/storage';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import { sync } from '@/sync/sync';
import { isSessionWriteKnownDenied } from '@/utils/sessions/deriveTranscriptInteraction';
import { fireAndForget } from '@/utils/system/fireAndForget';

const NO_COUNTS: readonly number[] = Object.freeze([]);

/**
 * A Discussion's held check-in (P1 attention slot, CR6): when the agents here have asked each other
 * enough times that one of the viewer's participant Sessions paused for a person, the Session
 * composer's own banner sits above this composer with Continue / +10 / Stop (`session.exchange.control`).
 *
 * Only participant Sessions this device already holds and may write to are read; a Session someone
 * else owns shows its banner to its owner on their own Session page (accepted, COORD-COMPOSE §7.2).
 * The pushed `pendingBlockedCount` says when a Session's queue holds something; its rows are read
 * then, through the same pending owner the Session page uses. One banner at most.
 */
export function DiscussionCheckInBanner(
  props: Readonly<{
    serverId: string;
    participantSessionIds: readonly string[];
  }>,
): React.ReactElement | null {
  const { participantSessionIds } = props;
  const blockedCounts = getStorage()(
    useShallow((state) =>
      participantSessionIds.length === 0
        ? NO_COUNTS
        : participantSessionIds.map((sessionId) => {
            const session = state.sessions[sessionId];
            return session && !isSessionWriteKnownDenied(session)
              ? (session.pendingBlockedCount ?? 0)
              : 0;
          }),
    ),
  );
  const root = getStorage()((state) => {
    for (const sessionId of participantSessionIds) {
      const found = findExchangeCheckInRoot(
        state.sessionPending[sessionId]?.messages,
      );
      if (found) return found;
    }
    return null;
  });
  React.useEffect(() => {
    blockedCounts.forEach((count, index) => {
      const sessionId = participantSessionIds[index];
      if (count > 0 && sessionId) {
        fireAndForget(sync.fetchPendingMessages(sessionId), {
          tag: 'DiscussionCheckInBanner.fetchPendingMessages',
        });
      }
    });
  }, [blockedCounts, participantSessionIds]);
  if (!root) return null;
  // The Session composer's own frame and banner, as on that Session's page.
  return (
    <ComposerAuxiliaryFrame>
      <SessionExchangeCheckInBanner serverId={props.serverId} root={root} />
    </ComposerAuxiliaryFrame>
  );
}
