import * as React from 'react';

import { executeDesktopActivityOverlayInteractionWithResult } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { useDesktopActivityOverlayField } from '@/activity/adapters/desktop/runtime/useDesktopActivityOverlayState';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import type { DesktopActivityOverlayFocusTargetRef } from '../resolveDesktopActivityOverlayInitialFocusTarget';
import type {
    DesktopActivityOverlayActionHandler,
  DesktopActivityOverlayUiModel,
} from '../shared/desktopActivityOverlayUiModel';
import { DesktopActivityOverlayConversation } from './DesktopActivityOverlayConversation';
import { usePinnedSessionDraft } from './usePinnedSessionDraft';

const NO_CARDS: NonNullable<
  DesktopActivityOverlayUiModel['expanded']['cards']
> = [];

/** The pinned Bot's own asks, from the cards the island already has (no second request reader). */
function selectConversationCards(
  listDetail: DesktopActivityOverlayUiModel['expanded'] | null,
  target: SessionAddress | null,
): NonNullable<DesktopActivityOverlayUiModel['expanded']['cards']> {
  if (!target) return NO_CARDS;
  const cards = (listDetail?.cards ?? []).filter(
    (card) =>
      (card.kind === 'permission_request' || card.kind === 'user_question') &&
      card.sessionId === target.sessionId &&
      card.serverId === target.serverId,
  );
  return cards.length === 0 ? NO_CARDS : cards;
}

/**
 * The pinned conversation's leaf: it alone subscribes to the pinned slice, the faces and the asks, and
 * it alone holds the reply field's text (that Session's own draft). The island learns only whether the
 * draft holds text, the one fact its Esc and leave decisions read, so a keystroke or a new reply renders
 * this leaf and nothing above it.
 */
export function DesktopActivityOverlayPinnedPanel(
  props: Readonly<{
    phrases: readonly string[];
    initialFocusRef?: DesktopActivityOverlayFocusTargetRef;
    /** Called at event time with whether the draft holds text; the island keeps it for Esc and leave. */
    onDraftDirtyChange: (dirty: boolean) => void;
    onBack: () => void;
    onUnpin: () => void;
    onExtract: (target: SessionAddress) => Promise<boolean>;
    onAction: DesktopActivityOverlayActionHandler;
    onDismissKey: () => void;
  }>,
): React.ReactElement | null {
  const conversation = useDesktopActivityOverlayField('conversation');
  const faces = useDesktopActivityOverlayField('faces');
  const listDetail = useDesktopActivityOverlayField('listDetail');
  const draft = usePinnedSessionDraft(
    conversation
      ? {
          serverId: conversation.serverId,
          accountId: conversation.accountId,
          sessionId: conversation.sessionId,
        }
      : null,
  );
  const { onDraftDirtyChange, onExtract } = props;
  const dirty = draft.text.length > 0;
  // A draft that arrives with text (a Bot's saved draft) holds Esc like a typed one; leaving releases it.
  React.useEffect(() => {
    onDraftDirtyChange(dirty);
  }, [dirty, onDraftDirtyChange]);
  React.useEffect(() => () => onDraftDirtyChange(false), [onDraftDirtyChange]);
  const cards = React.useMemo(
    () => selectConversationCards(listDetail, conversation),
    [conversation, listDetail],
  );
  const onDraftChange = React.useCallback(
    (next: string) => {
      if (draft.setText(next)) onDraftDirtyChange(next.length > 0);
    },
    [draft, onDraftDirtyChange],
  );
  const extract = React.useCallback(
    () => (conversation ? onExtract(conversation) : Promise.resolve(false)),
    [conversation, onExtract],
  );
  const send = React.useCallback(
    async (message: string) => {
      if (!conversation) return false;
      try {
        const result = await executeDesktopActivityOverlayInteractionWithResult(
          {
            actionIdentifier: 'session.message.send',
            data: {
              sessionId: conversation.sessionId,
              message,
              ...(conversation.serverId
                ? { serverId: conversation.serverId }
                : {}),
            },
          },
        );
        return result.ok;
      } catch {
        return false;
      }
    },
    [conversation],
  );

  if (!conversation) return null;
  const face =
    faces?.faces.find(
      (entry) =>
        entry.sessionId === conversation.sessionId &&
        entry.serverId === conversation.serverId,
    ) ?? null;
  const row = listDetail?.rows.find(
    (entry) => entry.sessionId === conversation.sessionId && entry.serverId === conversation.serverId,
  );
  const fallbackName = row?.title ?? '';

  return (
    <DesktopActivityOverlayConversation
      conversation={conversation}
      face={face}
      fallbackName={fallbackName}
      context={row?.subtitle ?? null}
      cards={cards}
      phrases={props.phrases}
      draft={draft.text}
      draftWriteError={draft.writeError}
      onRetryDraft={draft.retry}
      initialFocusRef={props.initialFocusRef}
      onDraftChange={onDraftChange}
      onSend={send}
      onBack={props.onBack}
      onUnpin={props.onUnpin}
      onExtract={extract}
      onAction={props.onAction}
      onDismissKey={props.onDismissKey}
    />
  );
}
