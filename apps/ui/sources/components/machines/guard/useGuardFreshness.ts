import * as React from 'react';

import type { MachineFreshness } from '@/components/machines/page/MachineFreshnessChip';
import { useMachineGuardView, type MachineGuardActivityHookResult } from '@/sync/domains/machines/guard/useMachineGuardView';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

const LIVE: MachineFreshness = { kind: 'live' };
const NONE: MachineFreshness = { kind: 'none' };

/** Activity's successful query answer owns the age of the receipts held by every surface. */
export function readGuardActivityFreshness(activity: Pick<MachineGuardActivityHookResult, 'list' | 'status' | 'offline' | 'retry'>): MachineFreshness {
    const { list, status, offline, retry } = activity;
    const at = list?.asOf ?? null;
    if (offline) return at === null ? NONE : { kind: 'offline', at };
    if (list && (status === 'error' || status === 'not_reported')) return { kind: 'stale', at: list.asOf, onRetry: retry };
    if (status === 'loading') return { kind: 'checking', at };
    return list ? LIVE : NONE;
}

/** Activity is a distinct reader: its selected query and successful answer time own its freshness. */
export function useGuardActivityFreshness(activity: MachineGuardActivityHookResult, input: Readonly<{ serverId: string; machineId: string }>): MachineFreshness {
    const { list, status, offline, retry } = activity;
    const { reachability } = useMachinePresenceSummary(input.serverId, input.machineId);
    return React.useMemo<MachineFreshness>(() => {
        if (reachability === 'unknown') return NONE;
        return readGuardActivityFreshness({ list, status, offline, retry });
    }, [list, offline, reachability, retry, status]);
}

/**
 * What the machine page's freshness chip says on the Guard tab (lab `rg` G2, G7, G9): "Checking…" while the first
 * answer is on its way (the rules already read from the saved settings), "As of 10:42 · Checking…" while a later
 * read is still out, "Live" once answered and watched, "As of 10:42 · Retry" when the last answer is kept after a
 * read failed, and "As of …" once the machine is offline, read-only. The view is the shared one the body already
 * holds, so the chip adds no read of its own.
 */
export function useGuardFreshness(input: Readonly<{ serverId: string; machineId: string }>): MachineFreshness {
    const guard = useMachineGuardView(input);
    const { reachability, lastSeenAt = null } = useMachinePresenceSummary(input.serverId, input.machineId);
    const { view, offline, status, pending, receivedAtMs, retry } = guard;
    return React.useMemo((): MachineFreshness => {
        if (reachability === 'unknown') return NONE;
        if (offline) return lastSeenAt !== null ? { kind: 'offline', at: lastSeenAt } : NONE;
        if (status === 'not_reported') return NONE;
        if (view === null) return status === 'error' ? NONE : { kind: 'checking', at: null };
        if (status === 'error' && receivedAtMs !== null) return { kind: 'stale', at: receivedAtMs, onRetry: retry };
        if (pending || status === 'loading') return { kind: 'checking', at: receivedAtMs };
        return LIVE;
    }, [lastSeenAt, offline, pending, reachability, receivedAtMs, retry, status, view]);
}
