import type { ChatTranscriptListItem } from '../chatListTypes';
import { buildMessageRouteId } from '@happier-dev/session-core/messages';
import type { TranscriptJumpResult, TranscriptJumpTarget } from '../viewport/jump/transcriptJumpTargetTypes';
import type { TranscriptViewportJumpAlignment } from '../viewport/transcriptViewportTypes';
import type { TranscriptFindMatch } from './useTranscriptFind';
import { expandTranscriptToolCallGroupsForMessage } from '../rowHost/useTranscriptToolCallsExpansionState';
import { FIND_MATCH_CURRENT_TEST_ID } from '@/components/ui/text/findMarkTestIds';

/**
 * Expand through the row owners, then navigate once through the canonical jump host. Where the
 * row lands is the jump's `reveal` placement: below the Find capsule, or — for a row taller than
 * the viewport — its current mark below the capsule. The jump host measures that geometry when
 * the row mounts; Find keeps no position estimate of its own.
 */
export async function revealTranscriptFindMatch(match: TranscriptFindMatch, input: Readonly<{
    items: readonly ChatTranscriptListItem[];
    setToolCallsGroupExpanded(value: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }): void;
    setThinkingExpanded(messageId: string, expanded: boolean): void;
    waitForVisualUpdate(): Promise<void>;
    jumpToTarget(target: TranscriptJumpTarget, options: Readonly<{ signal: AbortSignal; align?: TranscriptViewportJumpAlignment; preferTargetWindow?: boolean; landingCue?: boolean }>): Promise<TranscriptJumpResult>;
    /** The top band the open Find capsule covers (D10 `findClearanceRef`). */
    readClearancePx(): number;
}>, context: Readonly<{ signal: AbortSignal }>) {
    if (context.signal.aborted) return;
    expandTranscriptToolCallGroupsForMessage(match.messageId, input.items, input.setToolCallsGroupExpanded);
    if (match.message.kind === 'agent-text' && match.message.isThinking) input.setThinkingExpanded(match.messageId, true);
    await input.waitForVisualUpdate();
    if (context.signal.aborted) return;
    const target: TranscriptJumpTarget = { kind: 'route-message-id', routeMessageId: buildMessageRouteId(match.message),
        seqHint: match.message.seq ?? null };
    // Find's corpus includes loaded messages outside the currently projected list window.
    // Materializing that window is owned by the same jump host as Search-hit navigation.
    // The current match's fill marks the landing; the jump's row attention ring would be a second mark.
    const result = await input.jumpToTarget(target, { ...context, preferTargetWindow: true, landingCue: false,
        align: { kind: 'reveal', clearancePx: input.readClearancePx(), focusTestId: FIND_MATCH_CURRENT_TEST_ID } });
    if (result.status === 'not-found') throw new Error('Find target unavailable');
}
