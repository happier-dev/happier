import * as React from 'react';

import { useNowMs } from '@/hooks/time/useNowMs';

import {
    resolveAgentActivityStaleness,
    type AgentActivityStaleness,
    type AgentActivityStalenessInput,
} from './agentActivityStaleness';

/**
 * The 90 s / 10 min notes need a clock, and this is where that clock is allowed to live.
 *
 * **Not in the row.** `AgentActivityRow` is memoized on its entry so that a ticking roster costs
 * one small text node per second instead of N row renders; a subscription inside it would undo
 * that for every host at once. The host subscribes, resolves a value per entry, and passes a plain
 * string down — so a row re-renders only when its own note actually changes, which for most rows
 * is never.
 *
 * **Half a minute, not a second.** The thresholds are 90 s and 10 min, so a 30 s check is at worst
 * 30 s late on a note nobody is waiting for. The elapsed clock is a separate, faster subscriber in
 * the time slot, and it stops itself exactly on the threshold rather than waiting for this one.
 */
const STALENESS_CHECK_INTERVAL_MS = 30_000;

/**
 * Takes the silence rule's own input rather than a row entry, so the two shapes that need a note —
 * a merged roster entry and a durable workflow-agent snapshot — reach one clock and one threshold.
 */
export type AgentActivityStalenessResolver = (
    input: AgentActivityStalenessInput,
) => AgentActivityStaleness;

export function useAgentActivityStalenessResolver(): AgentActivityStalenessResolver {
    const nowMs = useNowMs(STALENESS_CHECK_INTERVAL_MS);

    return React.useCallback((input: AgentActivityStalenessInput) => resolveAgentActivityStaleness({
        status: input.status,
        updatedAtMs: input.updatedAtMs,
        endedAtMs: input.endedAtMs,
        nowMs,
    }), [nowMs]);
}
