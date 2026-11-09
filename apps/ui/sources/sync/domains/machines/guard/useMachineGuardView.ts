import * as React from 'react';
import type { MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';

import { useMachineDaemonReadTarget, useMachineDaemonReadTargets, type MachineDaemonReadTargetInput } from '../useMachineDaemonReadTarget';
import { useMachineResourcesPolicy, type MachineResourcesPolicyState } from '../resources/useMachineResourcesPolicy';
import type { MachineGuardActivityQuery } from './machineGuardRpc';
import { machineGuardStore, type MachineGuardActivityKey, type MachineGuardActivityState, type MachineGuardViewState } from './machineGuardStore';

export type MachineGuardViewHookResult = MachineGuardViewState & Readonly<{
    /** Synced configuration and accepted mutation receipts: intent, not execution evidence. */
    settings: MachineResourcesPolicyState;
    /** Controls use settings first; a held view supplies last-known rules only when settings are unavailable. */
    settingsPolicy: MachineGuardPolicyV1 | null;
    /** Only the daemon view proves operational On/Off, at receivedAtMs; no answer is unknown. */
    on: boolean | null;
    offline: boolean;
    retry: () => void;
    /** After a person's own change (Undo, Keep running): read again now instead of waiting for the watch. */
    refresh: () => void;
}>;

/** Guard is on when any of its automatic rules is (R29: every one is off by default). */
export function isMachineGuardOn(policy: MachineGuardPolicyV1): boolean {
    return policy.memoryGuard.enabled || policy.idleSessions.enabled || policy.idleTerminals.enabled || policy.leftBehind.mode !== 'off';
}

/** The machine's Guard view, live while shown (one parked watch shared by every surface showing it). */
export function useMachineGuardView(input: MachineDaemonReadTargetInput): MachineGuardViewHookResult {
    const { key, enabled, offline } = useMachineDaemonReadTarget({ ...input, observeDaemonStateVersion: false });
    const settings = useMachineResourcesPolicy({ serverId: key.serverId, machineId: key.machineId });
    const subscribe = React.useCallback((listener: () => void) => machineGuardStore.observeView(key, listener), [key]);
    const getSnapshot = React.useCallback(() => machineGuardStore.getView(key), [key]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(() => {
        if (!enabled) return;
        return machineGuardStore.demandView(key);
    }, [enabled, key]);
    const retry = React.useCallback(() => machineGuardStore.retryView(key), [key]);
    const refresh = React.useCallback(() => machineGuardStore.refreshMachine(key), [key]);
    return React.useMemo(() => ({ ...state, settings, settingsPolicy: settings.policy?.guard ?? state.view?.policy ?? null,
        on: state.view ? isMachineGuardOn(state.view.policy) : null,
        pending: enabled && state.pending, offline, retry, refresh }), [state, settings, enabled, offline, retry, refresh]);
}

export type MachineGuardActivityHookResult = MachineGuardActivityState & Readonly<{ offline: boolean; retry: () => void }>;

/** One range and filter of the machine's Activity, read while shown and again when a new row lands. */
export function useMachineGuardActivity(input: MachineDaemonReadTargetInput & MachineGuardActivityQuery): MachineGuardActivityHookResult {
    const { key: machine, enabled, offline } = useMachineDaemonReadTarget(input);
    const key = React.useMemo(() => ({ ...machine, range: input.range, filter: input.filter }), [machine, input.range, input.filter]);
    const subscribe = React.useCallback((listener: () => void) => machineGuardStore.observeActivity(key, listener), [key]);
    const getSnapshot = React.useCallback(() => machineGuardStore.getActivity(key), [key]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(() => {
        if (!enabled) return;
        return machineGuardStore.demandActivity(key);
    }, [enabled, key]);
    const retry = React.useCallback(() => machineGuardStore.retryActivity(key), [key]);
    return React.useMemo(() => ({ ...state, offline, retry }), [state, offline, retry]);
}

export type MachinesGuardActivityEntry = MachineGuardActivityHookResult & Readonly<{ machineId: string }>;

/**
 * Activity for several machines of one Home (rw AC "all machines"): Activity is daemon-owned per machine, so this
 * composes the same per-machine reads — each machine's own key, demand and Retry in the one Activity store — and
 * answers them together. There is no server aggregate and nothing is merged here.
 */
export function useMachinesGuardActivity(input: Readonly<{ serverId?: string | null; machineIds: readonly string[] } & MachineGuardActivityQuery>): readonly MachinesGuardActivityEntry[] {
    const targets = useMachineDaemonReadTargets({ serverId: input.serverId, machineIds: input.machineIds });
    // Keys follow the machines' read identities only. One machine's presence flip republishes `targets`;
    // it must not re-key, re-subscribe and re-read every other machine of the fleet.
    const keysId = JSON.stringify(targets.map(target => ({ ...target.key, range: input.range, filter: input.filter })));
    const keys = React.useMemo(() => JSON.parse(keysId) as MachineGuardActivityKey[], [keysId]);
    const enabledId = JSON.stringify(targets.map(target => target.enabled));
    const subscribe = React.useCallback((listener: () => void) => {
        const releases = keys.map(key => machineGuardStore.observeActivity(key, listener));
        return () => { for (const release of releases) release(); };
    }, [keys]);
    // One snapshot array per change: reused while every machine's own state is the same reference.
    const last = React.useRef<readonly MachineGuardActivityState[]>([]);
    const getSnapshot = React.useCallback(() => {
        const next = keys.map(key => machineGuardStore.getActivity(key));
        const previous = last.current;
        if (previous.length === next.length && next.every((state, index) => state === previous[index])) return previous;
        last.current = next;
        return next;
    }, [keys]);
    const states = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    // Demand per machine: a machine that turns unreadable releases only its own read; the others keep theirs.
    const demands = React.useRef(new Map<string, () => void>());
    React.useEffect(() => {
        const enabled = JSON.parse(enabledId) as boolean[];
        const wanted = new Map(keys.flatMap((key, index) => (enabled[index] ? [[JSON.stringify(key), key] as const] : [])));
        for (const [id, release] of demands.current) if (!wanted.has(id)) { release(); demands.current.delete(id); }
        for (const [id, key] of wanted) if (!demands.current.has(id)) demands.current.set(id, machineGuardStore.demandActivity(key));
    }, [enabledId, keys]);
    React.useEffect(() => () => {
        for (const release of demands.current.values()) release();
        demands.current.clear();
    }, []);
    return React.useMemo(() => keys.map((key, index) => ({
        ...(states[index] ?? { status: 'loading' as const, list: null }),
        machineId: key.machineId,
        offline: targets[index]?.offline ?? false,
        retry: () => machineGuardStore.retryActivity(key),
    })), [keys, states, targets]);
}
