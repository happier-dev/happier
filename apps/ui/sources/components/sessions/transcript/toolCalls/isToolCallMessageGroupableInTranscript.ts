import { readTurnChangeToolMetadataFromToolCall } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import { readTranscriptToolResultCardKind } from '../references/transcriptToolResultCardModel';
import { readReviewToolRunId } from '@/components/sessions/reviews/messages/projectReviewToolMessage';
import { isSessionMessageInvocationAnchor } from '../references/readSessionMessageInvocation';
import { hasToolCarriedStructuredResultCard } from '../structured/structuredToolResultCards';

import type { Message, ToolCallMessage } from "@happier-dev/session-core/messages";

export function isToolCallMessageGroupableInTranscript(message: Message): message is ToolCallMessage {
    if (message.kind !== 'tool-call') return false;

    // A review owns its result card from admission onward, including while its
    // retained Run is still running, so findings never move it into or out of a group.
    if (readReviewToolRunId(message) !== null) return false;

    if (readTurnChangeToolMetadataFromToolCall(message.tool) != null) {
        return false;
    }

    // Every result card is a visible reply block, never content of a collapsed tool group.
    if (readTranscriptToolResultCardKind(message.tool) !== null || hasToolCarriedStructuredResultCard(message)) return false;

    // An agent's Ask or Send is a record of who was asked and how it ended (its row sits under the call), so it
    // stays in the reply column instead of inside a collapsed group.
    if (isSessionMessageInvocationAnchor(message)) return false;

    // An unanswered permission, question or credential request owns interactive
    // controls; ordinary tool disclosure must never conceal those controls.
    return message.tool.permission?.status !== 'pending';
}
