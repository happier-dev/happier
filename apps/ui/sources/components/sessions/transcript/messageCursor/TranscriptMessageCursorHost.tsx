import * as React from 'react';
import type { Message } from '@happier-dev/session-core/messages';
import { buildMessageRouteId } from '@happier-dev/session-core/messages';

import {
  useKeyboardCommand,
  useKeyboardShortcutHandlers,
} from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardShortcutHandlers } from '@/keyboard/runtime';
import {
  allSignals,
  useLayoutPresentationSignal,
} from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import { collectTranscriptNavigationMessageIdsForItem } from '../viewport/lifecycle/transcriptRowClassification';
import type {
  TranscriptJumpResult,
  TranscriptJumpTarget,
} from '../viewport/jump/transcriptJumpTargetTypes';
import type { TranscriptViewportJumpAlignment } from '../viewport/transcriptViewportTypes';
import {
  TRANSCRIPT_MESSAGE_CURSOR_ACTION_COMMANDS,
  clearTranscriptMessageCursor,
  isTranscriptMessageCursorActiveFor,
  readTranscriptMessageCursor,
  runTranscriptMessageCursorAction,
  setTranscriptMessageCursor,
  subscribeTranscriptMessageCursor,
  type TranscriptMessageCursorActionId,
} from './transcriptMessageCursorStore';

export type TranscriptMessageCursorEntry = Readonly<{
  messageId: string;
  routeMessageId: string;
  seq: number | null;
}>;

/** The messages the cursor visits, oldest first: every rendered committed user or agent message (not thinking). */
export function resolveTranscriptMessageCursorOrder(
  items: readonly TranscriptRowShellItem[],
  messagesById: Readonly<Record<string, Message | undefined>>,
): readonly TranscriptMessageCursorEntry[] {
  const entries: TranscriptMessageCursorEntry[] = [];
  for (const item of items) {
    for (const id of collectTranscriptNavigationMessageIdsForItem(item)) {
      const message = messagesById[id];
      if (!message) continue;
      if (
        message.kind !== 'user-text' &&
        !(message.kind === 'agent-text' && !message.isThinking)
      )
        continue;
      entries.push({
        messageId: message.id,
        routeMessageId: buildMessageRouteId(message),
        seq:
          typeof message.seq === 'number' && Number.isFinite(message.seq)
            ? Math.trunc(message.seq)
            : null,
      });
    }
  }
  return entries;
}

type JumpToTarget = (
  target: TranscriptJumpTarget,
  options?: Readonly<{
    align?: TranscriptViewportJumpAlignment;
    landingCue?: boolean;
  }>,
) => Promise<TranscriptJumpResult>;

const CENTER: TranscriptViewportJumpAlignment = { kind: 'center' };

/**
 * Keyboard owner of the transcript message cursor (#1031). Mod+Up (`transcript.message.focusLast`) is offered
 * while this transcript is presented; the cursor's own keys are registered only while it holds a message, so
 * plain arrows, Escape and letters reach whatever else has focus otherwise. Keys run the focused row's own
 * committed actions; the jump owner centres the message, without the landing wash.
 */
export const TranscriptMessageCursorHost = React.memo(
  function TranscriptMessageCursorHost(
    props: Readonly<{
      address: SessionAddress | null;
      items: readonly TranscriptRowShellItem[];
      messagesById: Readonly<Record<string, Message | undefined>>;
      jumpToTarget: JumpToTarget;
    }>,
  ) {
    const latest = React.useRef(props);
    latest.current = props;
    const executeCommand = useKeyboardCommand();
    const presentation = useLayoutPresentationSignal();
    const cursorSignal = React.useMemo(
      () =>
        allSignals(presentation, {
          get: () => isTranscriptMessageCursorActiveFor(latest.current.address),
          subscribe: subscribeTranscriptMessageCursor,
        }),
      [presentation],
    );

    const entryHandlers = React.useMemo<KeyboardShortcutHandlers>(() => {
      const focus = (
        entry: TranscriptMessageCursorEntry,
        address: SessionAddress,
      ) => {
        setTranscriptMessageCursor({
          sessionAddress: address,
          messageId: entry.messageId,
          routeMessageId: entry.routeMessageId,
        });
        void latest.current
          .jumpToTarget(
            {
              kind: 'route-message-id',
              routeMessageId: entry.routeMessageId,
              seqHint: entry.seq,
            },
            { align: CENTER, landingCue: false },
          )
          .catch(() => undefined);
      };
      const step = (direction: -1 | 1 | 'last') => {
        const { address, items, messagesById } = latest.current;
        if (!address) return 'pass' as const;
        const order = resolveTranscriptMessageCursorOrder(items, messagesById);
        if (order.length === 0) return 'pass' as const;
        const current = readTranscriptMessageCursor();
        const index =
          direction === 'last'
            ? -1
            : order.findIndex(
                (entry) => entry.messageId === current?.messageId,
              );
        const nextIndex =
          index < 0 || direction === 'last'
            ? order.length - 1
            : Math.min(order.length - 1, Math.max(0, index + direction));
        focus(order[nextIndex], address);
        return undefined;
      };
      return {
        'transcript.message.focusLast': () => step('last'),
        'transcript.message.previous': () => {
          step(-1);
        },
        'transcript.message.next': () => {
          step(1);
        },
      };
    }, []);
    const cursorHandlers = React.useMemo<KeyboardShortcutHandlers>(() => {
      const handlers: KeyboardShortcutHandlers = {
        'transcript.message.previous':
          entryHandlers['transcript.message.previous'],
        'transcript.message.next': entryHandlers['transcript.message.next'],
        'transcript.message.exit': () => {
          clearTranscriptMessageCursor(latest.current.address ?? undefined);
          executeCommand('composer.focus');
        },
      };
      for (const [id, commandId] of Object.entries(
        TRANSCRIPT_MESSAGE_CURSOR_ACTION_COMMANDS,
      )) {
        handlers[commandId] = () => {
          runTranscriptMessageCursorAction(
            id as TranscriptMessageCursorActionId,
          );
        };
      }
      return handlers;
    }, [entryHandlers, executeCommand]);
    const focusLastHandlers = React.useMemo<KeyboardShortcutHandlers>(
      () => ({
        'transcript.message.focusLast':
          entryHandlers['transcript.message.focusLast'],
      }),
      [entryHandlers],
    );
    useKeyboardShortcutHandlers(focusLastHandlers, presentation);
    useKeyboardShortcutHandlers(cursorHandlers, cursorSignal);

    // A cursor never outlives the transcript that holds it.
    const { serverId, sessionId } = props.address ?? {};
    React.useEffect(() => {
      if (!serverId || !sessionId) return;
      return () => clearTranscriptMessageCursor({ serverId, sessionId });
    }, [serverId, sessionId]);
    return null;
  },
);
