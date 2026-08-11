import type { ToolCall, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

/**
 * What a tool call actually tells us about when its work started and ended.
 *
 * One owner because every transcript-derived agent kind asks the same question and the wrong answer
 * is silent: a run that took sixteen seconds rendered `0:00` for months because three timestamps
 * were all read from the tool-call *message*'s `createdAt` — which is the instant the call was
 * REQUESTED, and never moves once the result lands. `finished - started` was therefore always zero.
 *
 * The reducer already records the genuine instants beside that one, and they are the only ones read
 * here:
 *
 * - `ToolCall.startedAt` — set when the call begins running, and `null` while a permission prompt
 *   holds it (`reducer/phases/toolCalls.ts`).
 * - `ToolCall.completedAt` — set from the tool RESULT's own `createdAt` when the result arrives
 *   (`reducer/helpers/applyToolResultUpdateToReducerMessage.ts`), and when a still-running call is
 *   marked unavailable.
 *
 * The rule the callers inherit (4.9.3): **absent evidence produces no timestamp.** A missing finish
 * is reported as missing, never substituted from the start, the message, or the wall clock — a
 * plausible-looking fabricated duration is worse than no duration at all.
 */

export function readToolCallStartedAtMs(toolMessage: ToolCallMessage): number | null {
    // The message's own `createdAt` is a legitimate FALLBACK start — it is when the work was
    // requested — and it is the only start available while a permission prompt is still pending.
    // It is never a legitimate FINISH, which is the distinction the old code lost.
    return readFiniteNumber(toolMessage.tool?.startedAt) ?? readFiniteNumber(toolMessage.createdAt);
}

/**
 * The instant this call ended, or `null` when the transcript does not say.
 *
 * A running call has not ended, and a call that ended without recording when is reported as
 * unknown rather than being given the start instant.
 */
export function readToolCallFinishedAtMs(toolMessage: ToolCallMessage): number | null {
    const tool: ToolCall | undefined = toolMessage.tool;
    if (!tool || tool.state === 'running') return null;
    return readFiniteNumber(tool.completedAt);
}

/**
 * The latest instant anything about this call was observed. Used for recency ordering, never for
 * elapsed time — the two questions have different right answers and conflating them is what let a
 * finish instant masquerade as a start.
 */
export function readToolCallObservedAtMs(toolMessage: ToolCallMessage): number | null {
    const finishedAtMs = readToolCallFinishedAtMs(toolMessage);
    const createdAtMs = readFiniteNumber(toolMessage.createdAt);
    if (finishedAtMs == null) return createdAtMs;
    if (createdAtMs == null) return finishedAtMs;
    return Math.max(finishedAtMs, createdAtMs);
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
