import { isInProgressAgentActivityStatus } from '@happier-dev/protocol';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';

/**
 * The start instant the row is allowed to count from, or `null` when it may claim nothing (D-8).
 *
 * An elapsed value is a claim, and there are exactly two it can honestly make:
 *
 * - *"this has been going for N"* — needs a start and work still in progress.
 * - *"this took N"* — needs a start **and** a genuine finish.
 *
 * A start with no finish on work that is over supports neither: rendering it leaves a succeeded row
 * counting upward forever, and the shape that shipped instead — borrowing the finish instant for the
 * missing start — told every reader that a sixteen-second run took none. Some entries genuinely
 * cannot know their end (a teammate reconstructed from transcript history is known to be over, but
 * not when), and for those the honest column is empty.
 *
 * It lives at the row rather than in each entry producer for two reasons. The row is the single
 * thing that renders elapsed (R-5), so one guard here covers every source that will ever feed it —
 * the subagent projection today, the merged spine and the workflow hosts next. And the entry keeps
 * its raw timestamps, which the section model needs to order FINISHED by outcome time; suppressing
 * them upstream would have silently reshuffled that list.
 *
 * Note the two things it deliberately does NOT do. It does not suppress a `waiting` row's clock —
 * how long an agent has been waiting for you is the datum §4.7 says is never evicted. And it does
 * not second-guess a start that equals its finish: a run really can take under a second, and the
 * fabricated-zero defect belongs to the derivations that invented the timestamps, not here.
 */
export function resolveAgentActivityElapsedStartMs(entry: AgentActivityRowEntry): number | null {
    const startedAtMs = readTimestamp(entry.startedAtMs);
    if (startedAtMs == null) return null;
    if (isInProgressAgentActivityStatus(entry.status)) return startedAtMs;
    return readTimestamp(entry.endedAtMs) != null ? startedAtMs : null;
}

function readTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
