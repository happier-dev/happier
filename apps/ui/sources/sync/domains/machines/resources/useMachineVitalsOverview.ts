import * as React from 'react';
import { useDestinationFocus, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useMachineDaemonReadTarget } from '../useMachineDaemonReadTarget';
import { EMPTY_MACHINE_RESOURCE_STATE, isMachineResourceStateStale, machineResourceStore } from './machineResourceStore';
import { useMachineVitalsHistory } from './useMachineVitalsHistory';
import type { MachineResourceKey, MachineVitalsRange } from './machineRpc';
import { useMachineResourceLiveDemand } from './useMachineResourceLiveDemand';
import { useMachineResourceRefreshing } from './useMachineResourceSummary';

/**
 * `history` is the daemon's selected-range seed; `samples` is the unchanged raw one-hour live tail.
 * A one-hour chart stitches that tail over older history points, without client rollups/downsampling.
 * Longer ranges and today's totals refresh from the daemon on observed watch minute frontiers.
 */
export function useMachineVitalsOverview(input: MachineResourceKey & Readonly<{ range: MachineVitalsRange; enabled?: boolean }>) {
    const target = useMachineDaemonReadTarget(input);
    const focused = useDestinationFocus();
    // Visible workspace split panes share presentation, even when only one has keyboard focus.
    const hosted = useDestinationInstanceKey() !== null;
    const enabled = target.enabled && (hosted || focused);
    const key = React.useMemo(() => ({ ...target.key, view: 'overview' as const }), [target.key]);
    const refreshingInputs = React.useMemo(() => [key], [key]);
    const refreshing = useMachineResourceRefreshing(refreshingInputs, 'overview');
    useMachineResourceLiveDemand([{ ...target.key, daemonStateVersion: target.daemonStateVersion }], { detail: 'overview', enabled });
    const subscribe = React.useCallback((listener: () => void) => machineResourceStore.observe(key, listener), [key]);
    const getSnapshot = React.useCallback(() => target.accountMatches ? machineResourceStore.getState(key) : EMPTY_MACHINE_RESOURCE_STATE, [key, target.accountMatches]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const { state: historyState, retry: retryHistory } = useMachineVitalsHistory(target, { range: input.range }, enabled);
    const retry = React.useCallback(() => {
        if (!enabled) return;
        machineResourceStore.retry(key);
        retryHistory();
    }, [enabled, key, retryHistory]);
    const stale = isMachineResourceStateStale(state, Date.now());
    return React.useMemo(() => ({ ...state, stale, refreshing, history: historyState.history, historyStatus: historyState.status, retry }), [historyState, refreshing, retry, stale, state]);
}
