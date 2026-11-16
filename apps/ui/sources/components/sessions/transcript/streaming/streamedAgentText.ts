import * as React from 'react';
import type { AgentTextMessage, Message } from '@happier-dev/session-core/messages';

import { isTranscriptTextOnlyChange } from '@/sync/store/domains/messages';
import { isAgentTextMessageActivelyStreamingForSelection } from '@/components/sessions/transcript/messageSelection/resolveSelectableMessageText';
import { useTranscriptMessagesByRefs } from '@/components/sessions/transcript/source/appSessionTranscriptSource';

/**
 * While an agent message streams, its row keeps the message it holds and only the text leaf follows the
 * streamed text (`useStreamedAgentMessage`). That holds for a text-only delta (the store's own classifier)
 * of a message that is actively streaming before and after it: everything else the row draws (copy aside,
 * read when pressed) is unavailable or text-independent while it streams, and the segment's end is a
 * structural change that reaches the row. An empty held text is not held: it gates the row's copy action.
 */
export function holdsStreamedAgentTextDelta(held: Message, next: Message): boolean {
    return held.kind === 'agent-text' && next.kind === 'agent-text'
        && held.peer === undefined && held.text.trim().length > 0
        && isAgentTextMessageActivelyStreamingForSelection(held)
        && isAgentTextMessageActivelyStreamingForSelection(next)
        && isTranscriptTextOnlyChange(held, next);
}

export const STREAMED_AGENT_TEXT_ROW_SELECTION = Object.freeze({ retain: holdsStreamedAgentTextDelta });

const NO_REFS: readonly Readonly<{ sessionId: string; messageId: string }>[] = Object.freeze([]);

/**
 * The text leaf of an agent row: the message as streamed so far. It subscribes only while the held message
 * streams; a message whose structure moved is the row's to redraw, so it falls back to the held one.
 */
export function useStreamedAgentMessage(held: AgentTextMessage, sessionId: string): AgentTextMessage {
    const streaming = isAgentTextMessageActivelyStreamingForSelection(held);
    const refs = React.useMemo(
        () => streaming ? [{ sessionId, messageId: held.id }] : NO_REFS,
        [held.id, sessionId, streaming],
    );
    const live = useTranscriptMessagesByRefs(refs)[0] ?? null;
    return live !== null && live !== held && live.kind === 'agent-text' && live.id === held.id
        && holdsStreamedAgentTextDelta(held, live) ? live : held;
}
