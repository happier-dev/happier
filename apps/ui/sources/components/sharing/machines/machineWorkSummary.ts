import * as React from 'react';
import { MachineWorkSummaryGetResultV1Schema, type MachineWorkSummaryV1 } from '@happier-dev/protocol/machines/machineWorkSummaryV1';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { subscribeHomeAccountChange, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { parseToken } from '@/utils/auth/parseToken';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { subscribeMachineUpdates } from '@/sync/store/domains/machines';
import { haveSameMachineContentAuthority } from '@/sync/store/domains/areStoredMachinesEqual';
import { readMachineInventoryRowReadiness } from '@/sync/domains/machines/resolveServerScopedMachines';

export type MachineWorkSummaryState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'offline' }>
    | Readonly<{ kind: 'denied' }>
    | Readonly<{ kind: 'summary'; summary: MachineWorkSummaryV1; asOf?: number;
        stale?: 'loading' | 'offline' | 'unavailable' }>;

export type MachineWorkSummaryTarget = Readonly<{ scope: ServerAccountScope; machineId: string; online: boolean | null }>;
type Execute = ReturnType<typeof createDefaultActionExecutor>['execute'];
const LOADING: MachineWorkSummaryState = Object.freeze({ kind: 'loading' });
const OFFLINE: MachineWorkSummaryState = Object.freeze({ kind: 'offline' });
const UNAVAILABLE: MachineWorkSummaryState = Object.freeze({ kind: 'summary', summary: { kind: 'unavailable' } } satisfies MachineWorkSummaryState);
const NO_STATES: ReadonlyMap<string, MachineWorkSummaryState> = new Map();

export function machineWorkSummaryKey(target: Pick<MachineWorkSummaryTarget, 'scope' | 'machineId'>): string {
    const scope = { ...target.scope, serverId: resolveServerProfileScopeIdForIdentifier(target.scope.serverId) || target.scope.serverId };
    return serverAccountScopedResourceKey(scope, target.machineId);
}

function initialState(online: boolean | null): MachineWorkSummaryState {
    return online === null ? UNAVAILABLE : online ? LOADING : OFFLINE;
}

function unavailable(previous: MachineWorkSummaryState, reason: 'loading' | 'offline' | 'unavailable'): MachineWorkSummaryState {
    if (previous.kind === 'summary' && previous.summary.kind === 'current') return { ...previous, stale: reason };
    if (reason === 'loading' && previous.kind === 'summary') return previous;
    return reason === 'loading' ? LOADING : reason === 'offline' ? OFFLINE : UNAVAILABLE;
}

/** Active readers share this lifetime; the last consumer releases it, including its retained answer. */
const readers = new Map<string, ReturnType<typeof createReader>>();

function createReader(input: MachineWorkSummaryTarget, execute: Execute, key: string) {
    let online = input.online;
    let state = initialState(online);
    let pending: AbortController | null = null;
    let reloadPending = false;
    let lifetime = new AbortController();
    const listeners = new Set<() => void>();
    let stop: (() => void) | null = null;
    const target = { serverId: input.scope.serverId, machineId: input.machineId };
    const context = { surface: 'ui' as const, source: 'ui_button' as const, authority: 'present_user' as const,
        serverId: input.scope.serverId, expectedAccountId: input.scope.accountId };
    const publish = (next: MachineWorkSummaryState) => {
        state = next;
        for (const listener of listeners) listener();
    };
    async function load(): Promise<void> {
        const admittedLifetime = lifetime;
        if (admittedLifetime.signal.aborted) return;
        if (!online) { pending?.abort(); publish(unavailable(state, online === false ? 'offline' : 'unavailable')); return; }
        if (pending && !pending.signal.aborted) { reloadPending = true; return; }
        reloadPending = false;
        const request = new AbortController();
        pending = request;
        publish(unavailable(state, 'loading'));
        const result = await execute('machines.work.summary.get', target, { ...context, signal: request.signal }).catch(() => null);
        if (pending === request) pending = null;
        if (request.signal.aborted || admittedLifetime.signal.aborted) return;
        const parsed = result?.ok ? MachineWorkSummaryGetResultV1Schema.safeParse(result.result) : null;
        const failure = result && !result.ok ? result.errorCode : undefined;
        if (parsed?.success && parsed.data.kind === 'current') publish({ kind: 'summary', summary: parsed.data, asOf: Date.now() });
        else if (parsed?.success && parsed.data.kind === 'refused'
            || failure === 'access_denied' || failure === 'account_scope_mismatch'
            || failure === 'action_account_scope_changed' || failure === 'not_authenticated') {
            publish({ kind: 'denied' });
            reloadPending = false;
        } else publish(unavailable(state, 'unavailable'));
        if (reloadPending) { reloadPending = false; void load(); }
    }
    function start() {
        let observedMachine = resolveServerScopedMachine(storage.getState(), input.scope.serverId, input.machineId);
        const observeMachine = (nextState: ReturnType<typeof storage.getState>) => {
            const next = resolveServerScopedMachine(nextState, input.scope.serverId, input.machineId);
            const changed = next !== observedMachine && (!next || !observedMachine
                || !haveSameMachineContentAuthority(observedMachine, next)
                || next.storageMode !== observedMachine.storageMode
                || readMachineInventoryRowReadiness(next) !== readMachineInventoryRowReadiness(observedMachine)
                || next.daemonState?.runtimeId !== observedMachine.daemonState?.runtimeId
                || next.daemonState?.status !== observedMachine.daemonState?.status
                || next.operationProtocolCapabilitiesRevision !== observedMachine.operationProtocolCapabilitiesRevision);
            observedMachine = next;
            if (changed) void load();
        };
        const stopMachine = storage.subscribe(observeMachine, {
            machines: true, machineListByServerId: true, machineListStatusByServerId: true, profileScope: true,
        });
        const stopUpdates = subscribeMachineUpdates((serverId, machineIds, facts) => {
            if (!areServerProfileIdentifiersEquivalent(serverId, input.scope.serverId) || !machineIds.includes(input.machineId)) return;
            if (facts?.workSummaryChanged) void load();
            else observeMachine(storage.getState());
        }, { workSummary: true });
        const stopWake = subscribeHomeAccountChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, input.scope.serverId)
                && (event.entityIds === undefined || event.entityIds.includes(input.machineId))) void load();
        }, { reconnect: 'refresh' });
        const stopCredentials = subscribeHomeCredentialChange(event => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, input.scope.serverId)) return;
            let actor: string | null = null;
            try { actor = event.credentials ? parseToken(event.credentials.token) : null; } catch { /* Invalid identity retires this projection. */ }
            if (event.kind === 'credentials_removed' || actor !== input.scope.accountId) {
                lifetime.abort(); pending?.abort(); reloadPending = false; publish({ kind: 'denied' });
            } else {
                if (lifetime.signal.aborted) lifetime = new AbortController();
                void load();
            }
        });
        stop = () => { lifetime.abort(); pending?.abort(); reloadPending = false; stopMachine(); stopUpdates(); stopWake(); stopCredentials(); };
        void load();
    }
    const reader = {
        get: () => state,
        refresh: () => { void load(); },
        setOnline(next: boolean | null) { if (next !== online) { online = next; void load(); } },
        subscribe(listener: () => void) {
            listeners.add(listener);
            if (listeners.size === 1) start();
            return () => {
                listeners.delete(listener);
                if (listeners.size > 0) return;
                stop?.();
                if (readers.get(key) === reader) readers.delete(key);
            };
        },
    };
    return reader;
}

/** Exact visible Machines acquire demand; Board chrome needing only attention acquires none. */
export function useMachineWorkSummaries(targets: readonly MachineWorkSummaryTarget[], execute?: Execute) {
    const latest = React.useRef(targets);
    latest.current = targets;
    const keys = JSON.stringify([...new Set(targets.map(machineWorkSummaryKey))]);
    const selection = React.useMemo(() => {
        let snapshot: ReadonlyMap<string, MachineWorkSummaryState> = NO_STATES;
        const get = () => {
            const values = new Map(latest.current.map(target => {
                const key = machineWorkSummaryKey(target);
                return [key, readers.get(key)?.get() ?? initialState(target.online)] as const;
            }));
            if (snapshot.size !== values.size || [...values].some(([key, value]) => snapshot.get(key) !== value)) snapshot = values;
            return snapshot;
        };
        const subscribe = (listener: () => void) => {
            const selected = new Map(latest.current.map(target => [machineWorkSummaryKey(target), target]));
            const stops = [...selected].map(([key, target]) => {
                let reader = readers.get(key);
                if (!reader) { reader = createReader(target, execute ?? createFrontDoorActionExecute(), key); readers.set(key, reader); }
                return reader.subscribe(listener);
            });
            return () => { for (const stop of stops) stop(); };
        };
        return { get, subscribe, refresh: () => { for (const target of latest.current) readers.get(machineWorkSummaryKey(target))?.refresh(); } };
    }, [keys, execute]);
    const states = React.useSyncExternalStore(selection.subscribe, selection.get, selection.get);
    React.useEffect(() => {
        for (const target of targets) readers.get(machineWorkSummaryKey(target))?.setOnline(target.online);
    }, [targets]);
    return { states, refresh: selection.refresh };
}
