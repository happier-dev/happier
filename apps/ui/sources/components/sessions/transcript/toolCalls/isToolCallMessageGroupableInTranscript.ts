import { readTurnChangeToolMetadataFromToolCall } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';

import type { Message, ToolCallMessage } from "@happier-dev/session-core/messages";

export function isToolCallMessageGroupableInTranscript(message: Message): message is ToolCallMessage {
    if (message.kind !== 'tool-call') return false;

    if (readTurnChangeToolMetadataFromToolCall(message.tool) != null) {
        return false;
    }

    // An unanswered permission, question or credential request owns interactive
    // controls; ordinary tool disclosure must never conceal those controls.
    return message.tool.permission?.status !== 'pending';
}
