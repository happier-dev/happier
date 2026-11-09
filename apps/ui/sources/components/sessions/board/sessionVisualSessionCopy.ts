import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { SESSION_BOARD_OVERVIEW_VIEW_ID } from '@/sync/domains/session/board';
import {
  copySessionBoardItemIntoSession,
  type SessionBoardActionOutcome,
  type SessionBoardMutationResult,
} from '@/sync/domains/session/board/sessionBoardActionsPort';

/**
 * Copy to another session (V-OP-02): one Session visual, at the exact revision the person is looking
 * at, becomes an independent item on the chosen Session's Board. The request is the same
 * `session.board.item.upsert` with `copySource` an agent sends, so the shared executor reads the
 * source, owns approval for the widened host access, and the copy never mirrors the source.
 */
export async function copySessionVisualToSession(
  input: Readonly<{
    serverId: string;
    source: Readonly<{ sessionId: string; itemId: string; revision: string }>;
    destinationSessionId: string;
    createItemId?: () => string;
    execute?: Parameters<typeof copySessionBoardItemIntoSession>[0]['execute'];
  }>,
): Promise<SessionBoardActionOutcome<SessionBoardMutationResult>> {
  return await copySessionBoardItemIntoSession(
    {
      serverId: input.serverId,
      sessionId: input.destinationSessionId,
      ...(input.execute ? { execute: input.execute } : {}),
    },
    {
      sessionId: input.destinationSessionId,
      itemId: (input.createItemId ?? randomUUID)(),
      expectedItemRevision: null,
      destination: 'board',
      placement: { tabId: SESSION_BOARD_OVERVIEW_VIEW_ID, tabTitle: t('sessionBoard.views.overview') },
      copySource: {
        serverId: input.serverId,
        sessionId: input.source.sessionId,
        itemId: input.source.itemId,
        expectedItemRevision: input.source.revision,
      },
    },
  );
}
