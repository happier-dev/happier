import type { ChatTranscriptListItem } from '../chatListTypes';
import type { TranscriptJumpResult, TranscriptJumpTarget } from '../viewport/jump/transcriptJumpTargetTypes';
import type { TranscriptFindMatch } from './useTranscriptFind';

/** Expand through the row owners, then navigate through the canonical jump host. */
export async function revealTranscriptFindMatch(match: TranscriptFindMatch, input: Readonly<{
    items: readonly ChatTranscriptListItem[];
    setToolCallsGroupExpanded(value: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }): void;
    setThinkingExpanded(messageId: string, expanded: boolean): void;
    waitForVisualUpdate(): Promise<void>;
    jumpToTarget(target: TranscriptJumpTarget, options: Readonly<{ signal: AbortSignal }>): Promise<TranscriptJumpResult>;
}>, context: Readonly<{ signal: AbortSignal }>) {
    if (context.signal.aborted) return;
    for (const item of input.items) {
        if (item.kind === 'turn') {
            for (const content of item.turn.content) {
                if (content.kind === 'tool_calls' && content.toolMessageIds.includes(match.messageId)) {
                    input.setToolCallsGroupExpanded({ toolCallsGroupId: content.id, toolMessageIds: content.toolMessageIds, expanded: true });
                }
            }
        } else if ('toolMessageIds' in item && item.toolMessageIds.includes(match.messageId)) {
            input.setToolCallsGroupExpanded({ toolCallsGroupId: 'groupId' in item ? item.groupId : item.id,
                toolMessageIds: item.toolMessageIds, expanded: true });
        }
    }
    if (match.message.kind === 'agent-text' && match.message.isThinking) input.setThinkingExpanded(match.messageId, true);
    await input.waitForVisualUpdate();
    if (context.signal.aborted) return;
    const result = await input.jumpToTarget({ kind: 'route-message-id', routeMessageId: match.message.realID ?? match.message.id,
        seqHint: match.message.seq ?? null }, context);
    if (result.status === 'not-found') throw new Error('Find target unavailable');
}
