import * as React from 'react';

import { useNowMs } from '@/hooks/time/useNowMs';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';
import { resolveAgentActivityStaleness, type AgentActivityStaleness } from './agentActivityStaleness';

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

export type AgentActivityStalenessResolver = (entry: AgentActivityRowEntry) => AgentActivityStaleness;

export function useAgentActivityStalenessResolver(): AgentActivityStalenessResolver {
    const nowMs = useNowMs(STALENESS_CHECK_INTERVAL_MS);

    return React.useCallback((entry: AgentActivityRowEntry) => resolveAgentActivityStaleness({
        status: entry.status,
        updatedAtMs: entry.updatedAtMs,
        endedAtMs: entry.endedAtMs,
        nowMs,
    }), [nowMs]);
}
