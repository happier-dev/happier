import { getDemoMachineRead } from '@/demoMode/runtime/demoMachineReadProjection';
import type { MachineGuardActivityListV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import type { MachineGuardViewV1 } from '@happier-dev/protocol/machines/guard/guardRpcV1';

import { createSharedSubscriptionStore, type SharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';

import type { MachineDaemonReadKey } from '../useMachineDaemonReadTarget';
import type { MachineGuardActivityQuery, MachineGuardClients } from './machineGuardRpc';
import { retainDeep, retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import type { MachineDaemonRpcFailure } from '../machineDaemonRpcErrors';

/**
 * One shared Guard view per machine (read, then one parked watch while anything shows it) and one
 * independently watched Activity list per machine and query. The view is the daemon's; this store only keeps the last
 * good answer for the app session, so an offline or failing machine still shows what it last said.
 */

export type MachineGuardStatus = 'loading' | 'ready' | 'error' | 'not_reported';
export type MachineGuardViewState = Readonly<{ status: MachineGuardStatus; view: MachineGuardViewV1 | null; since: number | undefined;
    /** An initial read or refresh is in flight; an ordinary parked watch is not a pending read. */
    pending: boolean;
    /** Client receive time of the last good view; failures cannot renew its freshness. */
    receivedAtMs: number | null; failure?: MachineDaemonRpcFailure }>;
export type MachineGuardActivityState = Readonly<{ status: MachineGuardStatus; list: MachineGuardActivityListV1 | null; since?: number; failure?: MachineDaemonRpcFailure }>;
export type MachineGuardActivityKey = MachineDaemonReadKey & MachineGuardActivityQuery;

const EMPTY_VIEW: MachineGuardViewState = { status: 'loading', pending: false, view: null, since: undefined, receivedAtMs: null };
const EMPTY_ACTIVITY: MachineGuardActivityState = { status: 'loading', list: null };

function machineKey(input: MachineDaemonReadKey): string {
    return JSON.stringify([input.serverId ?? null, input.expectedAccountId ?? null, input.machineId]);
}
function activityKey(input: MachineGuardActivityKey): string {
    return JSON.stringify([machineKey(input), input.range, input.filter]);
}
const normalize = <T extends MachineDaemonReadKey>(input: T): T => ({ ...input, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null });
const failed = (reason: MachineDaemonRpcFailure['reason']): MachineGuardStatus => reason === 'older_happier' ? 'not_reported' : 'error';

type ViewUpdate = Readonly<{ kind: 'view'; view: MachineGuardViewV1; since: number | undefined; receivedAtMs: number }> | Readonly<{ kind: 'status'; status: MachineGuardStatus; failure?: MachineDaemonRpcFailure }>;
type ActivityUpdate = Readonly<{ list: MachineGuardActivityListV1; since: number }> | Readonly<{ failure: MachineDaemonRpcFailure }>;

function retainRows<T>(previous: T[] | undefined, incoming: T[], key: (row: T) => string): T[] {
    return retainKeyedRows(previous, incoming, key, { freeze: false }) as T[];
}
function reconcileActivity(previous: MachineGuardActivityListV1 | null, incoming: MachineGuardActivityListV1): MachineGuardActivityListV1 {
    return previous ? retainDeep(previous, { ...incoming,
        entries: retainRows(previous.entries, incoming.entries, row => row.id), counts: retainDeep(previous.counts, incoming.counts),
    }) : incoming;
}
function reconcileView(previous: MachineGuardViewV1 | null, incoming: MachineGuardViewV1): MachineGuardViewV1 {
    if (!previous) return incoming;
    const steps = new Map(previous.ladder.steps.map(step => [step.rung, step]));
    const ladder = retainDeep(previous.ladder, { ...incoming.ladder,
        steps: retainDeep(previous.ladder.steps, incoming.ladder.steps.map(step => {
            const old = steps.get(step.rung);
            return old ? retainDeep(old, { ...step, candidates: retainRows(old.candidates, step.candidates, row => row.ref) }) : step;
        })),
        excluded: retainRows(previous.ladder.excluded, incoming.ladder.excluded, row => row.ref),
        summary: retainDeep(previous.ladder.summary, incoming.ladder.summary),
    });
    return retainDeep(previous, { ...incoming, ladder,
        policy: retainDeep(previous.policy, incoming.policy), state: retainDeep(previous.state, incoming.state),
        idle: retainRows(previous.idle, incoming.idle, row => row.sessionRef),
        ...(incoming.idleTerminals === undefined ? {} : {
            idleTerminals: retainRows(previous.idleTerminals, incoming.idleTerminals, row => row.terminalKey),
        }),
        recentActivity: retainRows(previous.recentActivity, incoming.recentActivity, row => row.id),
        leftBehind: retainDeep(previous.leftBehind, incoming.leftBehind), keepAwake: retainDeep(previous.keepAwake, incoming.keepAwake),
        ...(incoming.managed === undefined ? {} : { managed: retainDeep(previous.managed, incoming.managed) }),
        ...(incoming.otherMemoryGuards === undefined ? {} : { otherMemoryGuards: retainDeep(previous.otherMemoryGuards, incoming.otherMemoryGuards) }),
    });
}

export function createMachineGuardStore(clients: MachineGuardClients) {
    const activityDemands = new Map<string, { key: MachineGuardActivityKey; count: number }>();
    const applyView = (state: MachineGuardViewState, update: ViewUpdate): MachineGuardViewState => update.kind === 'view'
        ? retainDeep(state, { status: 'ready', pending: state.pending, view: reconcileView(state.view, update.view), since: update.since ?? state.since, receivedAtMs: update.receivedAtMs })
        : retainDeep(state, { ...state, status: update.status, failure: update.failure });
    // A new Activity row (or an Undo) changes what the Activity page lists.
    const refreshActivity = (input: MachineDaemonReadKey) => {
        for (const { key } of activityDemands.values()) if (machineKey(key) === machineKey(input)) activities.invalidate(key);
    };
    const views: SharedSubscriptionStore<MachineDaemonReadKey, MachineGuardViewState, ViewUpdate, MachineGuardClients['viewClient'], MachineGuardClients['watchClient']>
        = createSharedSubscriptionStore<MachineDaemonReadKey, MachineGuardViewState, ViewUpdate, MachineGuardClients['viewClient'], MachineGuardClients['watchClient']>({
        emptyState: EMPTY_VIEW, createState: () => EMPTY_VIEW, normalizeInput: normalize, storeKey: machineKey,
        defaultSnapshotClient: clients.viewClient, defaultWatchClient: clients.watchClient,
        retainState: true, watchAfterRefresh: true, shouldWatch: state => state.status === 'ready',
        beginRefresh: state => ({ ...state, status: state.view ? state.status : 'loading', pending: true }),
        refresh: async ({ input, state, snapshotClient, signal, nowMs }): Promise<MachineGuardViewState> => {
            const answer = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current: MachineGuardViewState = views.getState(input);
            if (!answer.ok) return { ...applyView(current, { kind: 'status', status: failed(answer.reason), failure: answer }), pending: false };
            return { ...applyView(current, { kind: 'view', view: answer.value, since: current.since, receivedAtMs: nowMs() }), pending: false };
        },
        failRefresh: state => ({ ...applyView(state, { kind: 'status', status: 'error' }), pending: false }),
        applySnapshot: applyView,
        watch: async ({ input, state, watchClient, signal, nowMs }) => {
            const answer = await watchClient({ ...input, since: state.since, signal });
            if (signal?.aborted) return { status: 'unavailable' };
            if (!answer.ok) {
                views.publish(input, { kind: 'status', status: failed(answer.reason), failure: answer });
                return { status: 'unavailable' };
            }
            if (!answer.value.changed) return { status: 'idle' };
            return { status: 'changed', snapshot: { kind: 'view', view: answer.value.view, since: answer.value.since, receivedAtMs: nowMs() } };
        },
    });
    const activities: SharedSubscriptionStore<MachineGuardActivityKey, MachineGuardActivityState, ActivityUpdate, MachineGuardClients['activityClient'], MachineGuardClients['activityWatchClient']>
        = createSharedSubscriptionStore<MachineGuardActivityKey, MachineGuardActivityState, ActivityUpdate, MachineGuardClients['activityClient'], MachineGuardClients['activityWatchClient']>({
        emptyState: EMPTY_ACTIVITY, createState: () => EMPTY_ACTIVITY, normalizeInput: normalize, storeKey: activityKey,
        defaultSnapshotClient: clients.activityClient, defaultWatchClient: clients.activityWatchClient, retainState: true,
        watchAfterRefresh: true, shouldWatch: state => state.status === 'ready',
        beginRefresh: state => ({ ...state, status: 'loading' }),
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineGuardActivityState> => {
            const answer = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current: MachineGuardActivityState = activities.getState(input);
            const { failure: _failure, ...held } = current;
            return answer.ok ? retainDeep(current, { ...held, status: 'ready', list: reconcileActivity(current.list, answer.value) })
                : retainDeep(current, { ...held, status: failed(answer.reason), failure: answer });
        },
        failRefresh: state => ({ ...state, status: 'error' }),
        applySnapshot: (state, update) => 'failure' in update
            ? retainDeep(state, { ...state, status: failed(update.failure.reason), failure: update.failure })
            : retainDeep(state, { status: 'ready', list: reconcileActivity(state.list, update.list), since: update.since }),
        watch: async ({ input, state, watchClient, signal }) => {
            const answer = await watchClient({ ...input, since: state.since, signal });
            if (signal?.aborted) return { status: 'unavailable' };
            if (!answer.ok) {
                activities.publish(input, { failure: answer });
                return { status: 'unavailable' };
            }
            if (!answer.value.changed) return { status: 'idle' };
            return { status: 'changed', snapshot: { list: answer.value.list, since: answer.value.since } };
        },
        failWatch: state => ({ ...state, status: 'error' }),
    });
    return {
        getView: (input: MachineDaemonReadKey) => getDemoMachineRead(input)?.guard ?? views.getState(normalize(input)),
        observeView: (input: MachineDaemonReadKey, listener: () => void) => views.observe(normalize(input), listener),
        demandView: (input: MachineDaemonReadKey) => views.subscribe(normalize(input), () => {}),
        retryView: (input: MachineDaemonReadKey) => { views.invalidate(normalize(input)); },
        getActivity: (input: MachineGuardActivityKey) => getDemoMachineRead(input)?.activity ?? activities.getState(normalize(input)),
        observeActivity: (input: MachineGuardActivityKey, listener: () => void) => activities.observe(normalize(input), listener),
        readActivityOnce: (input: MachineGuardActivityKey) => activities.readOnce(normalize(input)),
        isActivityRefreshing: (input: MachineGuardActivityKey) => activities.isRefreshing(normalize(input)),
        observeActivityRefreshing: (input: MachineGuardActivityKey, listener: () => void) => activities.observeRefreshing(normalize(input), listener),
        demandActivity: (input: MachineGuardActivityKey) => {
            const key = normalize(input);
            const id = activityKey(key);
            const demand = activityDemands.get(id) ?? { key, count: 0 };
            demand.count += 1;
            activityDemands.set(id, demand);
            const release = activities.subscribe(key, () => {});
            let released = false;
            return () => {
                if (released) return;
                released = true;
                release();
                demand.count -= 1;
                if (demand.count === 0 && activityDemands.get(id) === demand) activityDemands.delete(id);
            };
        },
        retryActivity: (input: MachineGuardActivityKey) => { activities.invalidate(normalize(input)); },
        /** After an Undo or Keep running: the next answers say what changed. */
        refreshMachine: (input: MachineDaemonReadKey) => { views.invalidate(normalize(input)); refreshActivity(input); },
        reset: () => { views.reset(); activities.reset(); activityDemands.clear(); },
    };
}

export const machineGuardStore = createMachineGuardStore({
    viewClient: async input => (await import('./machineGuardRpc')).fetchMachineGuardViewViaAction(input),
    watchClient: async input => (await import('./machineGuardRpc')).watchMachineGuardViaMachineRpc(input),
    activityClient: async input => (await import('./machineGuardRpc')).fetchMachineGuardActivityViaAction(input),
    activityWatchClient: async input => (await import('./machineGuardRpc')).watchMachineGuardActivityViaMachineRpc(input),
});
