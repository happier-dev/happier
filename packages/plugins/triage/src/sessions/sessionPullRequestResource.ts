import { isPluginError, PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type { PluginDynamicResourceInvocationOptionsV1, PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { SessionPullRequestWatchReadResultV1Schema } from '@happier-dev/channels-protocol/v1';
import {
    reconcileTriagePullRequestStatusV1,
    TriagePullRequestStatusResultV1Schema,
    type SessionPullRequestStatusResourceResultV1,
    type TriagePullRequestStatusV1,
    type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { TriageReadSourceSessionLinksResultV1Schema, type TriageReadSourceSessionLinksResultV1 } from '../actions/sessionLinksProtocol.js';
import type { TriageReobserveEntryActionInputV1 } from '../actions/reobserveEntryProtocol.js';
import { TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1 } from './sessionLinksResource.js';

export { TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 } from './sessionPullRequestResourceId.js';
const relationResource = TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1;
const watchAction = { pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' } as const;
const nativeAction = { pluginId: 'happier.triage', localId: 'entries/read-pull-request-status-v1' } as const;

type WatchResult = ReturnType<typeof SessionPullRequestWatchReadResultV1Schema.parse>;
type Metadata = Extract<WatchResult, { kind: 'ready' }>;
type Binding = Metadata['bindings'][number];
type Ready = Extract<SessionPullRequestStatusResourceResultV1, { kind: 'ready' }>;
type NativeStatus = Ready['pullRequests'][number]['nativeStatus'];
type NativeRead = { status: NativeStatus; refreshAfterMs?: number };
type NativeDemand = {
    input: TriageReobserveEntryActionInputV1;
    status?: NativeStatus;
    dirty: boolean;
    observation?: Disposable;
    observing?: Promise<void>;
    controller?: AbortController;
    observationFailure?: TriageSourceFailureV1;
    cleanup?: Promise<void>;
    refreshTimer?: ReturnType<typeof setTimeout>;
};
type State = {
    metadata?: WatchResult;
    relations?: TriageReadSourceSessionLinksResultV1;
    relationFailure?: TriageSourceFailureV1;
    metadataDirty: boolean;
    relationsDirty: boolean;
    native: Map<string, NativeDemand>;
    observer?: { invalidate(): void; options: PluginDynamicResourceInvocationOptionsV1; controller: AbortController };
};
type StagedRead = Extract<SessionPullRequestStatusResourceResultV1, { kind: 'unavailable' }>
    | { kind: 'ready'; sessionId: string; bindings: readonly { binding: Binding; demand: NativeDemand | null; unavailableStatus?: NativeStatus }[] };

// The host owns this object's exact Account/plugin occurrence/Session lifetime.
// Last-demand abort deletes our admitted bytes even when the host retains its descriptor context.
const states = new WeakMap<PluginDynamicResourceInvocationOptionsV1['context'], State>();

function stateFor(options: PluginDynamicResourceInvocationOptionsV1): State {
    const current = states.get(options.context);
    if (current) return current;
    const state: State = { metadataDirty: true, relationsDirty: true, native: new Map() };
    states.set(options.context, state);
    return state;
}

function sessionId(options: PluginDynamicResourceInvocationOptionsV1): string {
    if (options.context.kind !== 'session') throw new PluginError({ code: 'invalid_request', message: 'PR status requires an exact Session context.' });
    return SessionIdSchema.parse(options.context.sessionId);
}

function unavailable(failure: TriageSourceFailureV1): NativeStatus {
    return { kind: 'unavailable', failure };
}

function withSourceSetupRecovery(status: NativeStatus, relations: TriageReadSourceSessionLinksResultV1 | undefined, sourcePluginId?: string): NativeStatus {
    const offers = sourcePluginId === undefined ? relations?.configureSources
        : relations?.configureSources?.filter(offer => offer.destination.pluginId === sourcePluginId);
    return status.kind === 'unavailable' && (status.failure.code === 'configuredSourceUnavailable'
        || status.failure.code === 'sessionLinksSourceInstanceRequired') && offers?.length
        ? { ...status, recovery: { kind: 'configureSources', offers } } : status;
}

function observationFailureStatus(demand: NativeDemand, failure: TriageSourceFailureV1): NativeStatus {
    const previous = demand.status;
    return previous && previous.kind !== 'unavailable'
        ? { kind: 'stale', value: previous.value, checkedAtMs: previous.checkedAtMs, failure }
        : unavailable(failure);
}

function transportFailure(code: string): TriageSourceFailureV1 {
    return { class: 'transient', code };
}

function preserveLeaf<T>(previous: T | undefined, next: T): T {
    return previous !== undefined && pluginJsonValuesEqual(previous, next) ? previous : next;
}

/** Reconcile each newly admitted metadata leaf once, at its real Action ingress. */
function admitMetadata(previous: WatchResult | undefined, next: WatchResult): WatchResult {
    if (previous?.kind !== 'ready' || next.kind !== 'ready') return next;
    const old = new Map(previous.bindings.map(binding => [binding.bindingId, binding]));
    return { ...next, bindings: next.bindings.map(binding => {
        const baseline = old.get(binding.bindingId);
        if (!baseline) return binding;
        const link = preserveLeaf(baseline.link, binding.link);
        const watch = preserveLeaf(baseline.watch, binding.watch);
        const latestUpdate = preserveLeaf(baseline.latestUpdate, binding.latestUpdate);
        return baseline.revision === binding.revision && link === baseline.link && watch === baseline.watch && latestUpdate === baseline.latestUpdate
            ? baseline : { ...binding, link, watch, latestUpdate };
    }) };
}

function resolveDemand(binding: Binding, relations: TriageReadSourceSessionLinksResultV1 | undefined, id: string) {
    // Only the source-admitted native locator establishes correspondence. Display text is never identity.
    const matches = relations?.links.filter(link => link.sessionId === id && link.locator?.webUrl === binding.link.url);
    if (matches?.length !== 1) return null;
    const link = matches[0]!;
    // The relation owner retained the link but did not select a configured authority.
    // This says nothing about whether its repository is configured or readable.
    if (link.sourceInstanceId === undefined) return { failure: withSourceSetupRecovery(unavailable({
        class: 'unsupportedContract', code: 'sessionLinksSourceInstanceRequired',
    }), relations, link.entryRef.source.pluginId) };
    if (link.sourceInstanceRevision === undefined || link.locator === undefined) return null;
    const input: TriageReobserveEntryActionInputV1 = { v: 1, entryRef: link.entryRef,
        sourceInstanceId: link.sourceInstanceId, lastKnownLocator: link.locator };
    // Storage revisions include label edits; the observed authority lifetime owns retirement.
    const key = JSON.stringify([link.sourceInstanceId, link.entryRef.source.pluginId,
        link.entryRef.source.localId, link.entryRef.kindId, link.entryRef.collisionScope, link.entryRef.entryId, link.locator.webUrl]);
    return { key, input };
}

async function disposeObservation(observation: Disposable | undefined): Promise<void> {
    await observation?.dispose();
}

function disposeDemand(demand: NativeDemand) {
    cancelNativeRefresh(demand);
    demand.controller?.abort();
    if (demand.cleanup === undefined) {
        const observation = demand.observation;
        const observing = demand.observing;
        demand.observation = undefined;
        demand.cleanup = Promise.all([disposeObservation(observation), observing]).then(() => {});
    }
    return demand.cleanup;
}

function cancelNativeRefresh(demand: NativeDemand) {
    clearTimeout(demand.refreshTimer);
    demand.refreshTimer = undefined;
}

function scheduleNativeRefresh(state: State, demand: NativeDemand, refreshAfterMs: number | undefined) {
    cancelNativeRefresh(demand);
    const owner = state.observer;
    if (!owner || owner.controller.signal.aborted || refreshAfterMs === undefined) return;
    // GitHub has no native change push here. Its read supplies the cadence;
    // this Resource already owns exact PR demand and the next native read.
    demand.refreshTimer = setTimeout(() => {
        demand.refreshTimer = undefined;
        if (owner.controller.signal.aborted) return;
        demand.dirty = true;
        owner.invalidate();
    }, refreshAfterMs);
}

function clearAdmitted(state: State) {
    state.metadata = undefined;
    state.relations = undefined;
    state.relationFailure = undefined;
    const cleanup = [...state.native.values()].map(disposeDemand);
    state.native.clear();
    return Promise.all(cleanup).then(() => {});
}

async function attachNativeObservation(demand: NativeDemand, options: PluginDynamicResourceInvocationOptionsV1,
    signal: AbortSignal, invalidate: () => void): Promise<Disposable | undefined> {
    try {
        return await options.observeAction(nativeAction, demand.input, () => {
            if (signal.aborted) return;
            demand.dirty = true;
            invalidate();
        }, { signal });
    } catch (error) {
        if (signal.aborted) throw error;
        demand.observationFailure = { class: 'unsupportedContract', code: isPluginError(error) ? error.code : 'nativeObservationUnavailable' };
        return undefined;
    }
}

function observeNative(state: State, demand: NativeDemand) {
    const owner = state.observer;
    if (!owner || demand.observation || demand.observationFailure) return;
    if (demand.observing) return demand.observing;
    const controller = new AbortController();
    demand.controller = controller;
    const abort = () => controller.abort();
    owner.controller.signal.addEventListener('abort', abort, { once: true });
    demand.observing = attachNativeObservation(demand, owner.options, controller.signal, owner.invalidate).then(async observation => {
        if (!observation) return;
        if (controller.signal.aborted) await observation.dispose();
        else demand.observation = observation;
    }).finally(() => {
        owner.controller.signal.removeEventListener('abort', abort);
        demand.observing = undefined;
    });
    return demand.observing;
}

async function refreshNative(demand: NativeDemand, options: PluginDynamicResourceInvocationOptionsV1): Promise<NativeRead> {
    cancelNativeRefresh(demand);
    let next;
    try {
        const envelope = await options.readAction(nativeAction, demand.input, { signal: options.signal });
        next = envelope.ok
            ? TriagePullRequestStatusResultV1Schema.parse(envelope.result)
            : { kind: 'unavailable' as const, failure: transportFailure(envelope.errorCode) };
    } catch (error) {
        if (options.signal.aborted) throw error;
        next = { kind: 'unavailable' as const, failure: transportFailure(isPluginError(error) ? error.code : 'nativeStatusUnavailable') };
    }
    const previous = demand.status?.kind === 'current' || demand.status?.kind === 'stale' ? demand.status : undefined;
    if (next.kind === 'unavailable' && next.failure.code === 'sourceAuthorityChanged') return { status: unavailable(next.failure) };
    if (next.kind === 'unavailable') return { status: previous
        ? { kind: 'stale', value: previous.value, checkedAtMs: previous.checkedAtMs, failure: next.failure }
        : unavailable(next.failure) };
    // Head authority is not reusable across a head transition, even for otherwise equal rows.
    const previousHead = previous?.value.branch?.headRevision;
    const baseline: TriagePullRequestStatusV1 | null = previousHead === next.branch?.headRevision
        ? previous?.value ?? null : null;
    const { refreshAfterMs, ...observation } = next;
    return { status: { kind: 'current', ...reconcileTriagePullRequestStatusV1(baseline, observation) },
        ...(refreshAfterMs === undefined ? {} : { refreshAfterMs }) };
}

async function read(state: State, options: PluginDynamicResourceInvocationOptionsV1,
    updates: Map<NativeDemand, NativeRead>): Promise<StagedRead> {
    const id = sessionId(options);
    const metadataDirty = state.metadataDirty || state.metadata?.kind !== 'ready';
    const relationsDirty = state.relationsDirty;
    const explicitRefresh = !metadataDirty && !relationsDirty && ![...state.native.values()].some(demand => demand.dirty);
    // Retry must re-admit configured selection before retrying a failed native observation.
    const retryingObservation = explicitRefresh && [...state.native.values()].some(demand => demand.observationFailure !== undefined);
    // Consume before awaiting so a concurrent level-triggered invalidation survives this read.
    state.metadataDirty = false;
    state.relationsDirty = false;
    if (metadataDirty) {
        try {
            const envelope = await options.readAction(watchAction, { kind: 'get', sessionId: id }, { signal: options.signal });
            if (!envelope.ok) {
                await clearAdmitted(state);
                return { kind: 'unavailable', sessionId: id, failure: { class: 'permission', code: envelope.errorCode } };
            }
            state.metadata = admitMetadata(state.metadata, SessionPullRequestWatchReadResultV1Schema.parse(envelope.result));
        } catch (error) {
            if (options.signal.aborted) throw error;
            await clearAdmitted(state);
            return { kind: 'unavailable', sessionId: id, failure: transportFailure(isPluginError(error) ? error.code : 'watchUnavailable') };
        }
    }
    const metadata = state.metadata;
    if (!metadata || metadata.kind !== 'ready' || metadata.sessionId !== id) {
        await clearAdmitted(state);
        return { kind: 'unavailable', sessionId: id, failure: metadata?.kind === 'unavailable' && metadata.reason === 'locked'
            ? { class: 'permission', code: 'accountLocked' }
            : metadata?.kind === 'unavailable' && metadata.reason === 'sessionUnavailable'
                ? { class: 'permission', code: 'sessionUnavailable' } : transportFailure('watchUnavailable') };
    }
    if ((relationsDirty || state.relations === undefined || retryingObservation) && metadata.bindings.length > 0) {
        try {
            const result = await options.resources.read(relationResource, { signal: options.signal });
            state.relations = TriageReadSourceSessionLinksResultV1Schema.parse(JSON.parse(new TextDecoder().decode(result.bytes)));
            state.relationFailure = undefined;
        } catch (error) {
            if (options.signal.aborted) throw error;
            state.relations = undefined;
            state.relationFailure = transportFailure(isPluginError(error) ? error.code : 'configuredSourceUnavailable');
        }
    }
    const wanted = new Map<string, NativeDemand>();
    const bindings = metadata.bindings.map(binding => {
        const resolved = resolveDemand(binding, state.relations, id);
        if (!resolved || resolved.failure !== undefined) return { binding, demand: null, unavailableStatus: resolved?.failure };
        const demand = wanted.get(resolved.key) ?? state.native.get(resolved.key) ?? { input: resolved.input, dirty: true };
        wanted.set(resolved.key, demand);
        return { binding, demand };
    });
    const retired = [...state.native].filter(([key]) => !wanted.has(key)).map(([, demand]) => disposeDemand(demand));
    state.native = wanted;
    await Promise.all(retired);
    await Promise.all([...wanted.values()].map(async demand => {
        const refresh = demand.dirty || explicitRefresh;
        demand.dirty = false;
        if (explicitRefresh) demand.observationFailure = undefined;
        if (state.observer) await observeNative(state, demand);
        if (demand.observationFailure) {
            updates.set(demand, { status: observationFailureStatus(demand, demand.observationFailure) });
            return;
        }
        if (!refresh) return;
        updates.set(demand, await refreshNative(demand, options));
    }));
    return { kind: 'ready', sessionId: id, bindings };
}

/** Sole loader joining admitted Channels metadata and one native demand per exact configured PR. */
export const TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
    async read(options) {
        const state = stateFor(options);
        const updates = new Map<NativeDemand, NativeRead>();
        try {
            const result = await read(state, options, updates);
            throwIfAborted(options.signal);
            const value: SessionPullRequestStatusResourceResultV1 = result.kind === 'ready'
                ? { kind: 'ready', sessionId: result.sessionId, pullRequests: result.bindings.map(({ binding, demand, unavailableStatus }) => ({ ...binding,
                    ...(demand ? { entry: { entryRef: demand.input.entryRef, sourceInstanceId: demand.input.sourceInstanceId } } : {}),
                    nativeStatus: unavailableStatus ?? withSourceSetupRecovery((demand && (updates.get(demand)?.status ?? demand.status))
                        ?? unavailable(state.relationFailure ?? { class: 'unsupportedContract', code: 'configuredSourceUnavailable' }), state.relations),
                })) } : result;
            const encoded = JSON.stringify(value);
            // Only a successfully admitted read may seed a later refresh's native baseline.
            for (const [demand, update] of updates) {
                demand.status = update.status;
                scheduleNativeRefresh(state, demand, update.refreshAfterMs);
            }
            return encoded;
        } finally {
            // A finite read does not create an observation lifetime to retain.
            if (!state.observer && states.get(options.context) === state) states.delete(options.context);
        }
    },
    async observe(invalidate, options) {
        const id = sessionId(options);
        const state = stateFor(options);
        const controller = new AbortController();
        const handles: Disposable[] = [];
        let cleanup: Promise<void> | undefined;
        const notify = () => { if (!controller.signal.aborted) invalidate(); };
        state.observer = { invalidate: notify, options, controller };
        const dispose = (): Promise<void> => {
            controller.abort();
            options.signal.removeEventListener('abort', onAbort);
            if (cleanup !== undefined) return cleanup;
            const subscriptions = handles.splice(0);
            const admitted = clearAdmitted(state);
            state.observer = undefined;
            if (states.get(options.context) === state) states.delete(options.context);
            cleanup = Promise.all([admitted, ...subscriptions.map(disposeObservation)]).then(() => {});
            return cleanup;
        };
        const onAbort = () => { void dispose().catch(() => {}); };
        if (options.signal.aborted) { await dispose(); return { dispose }; }
        options.signal.addEventListener('abort', onAbort, { once: true });
        try {
            const relation = await options.resources.watch(relationResource, () => { state.relationsDirty = true; notify(); });
            if (controller.signal.aborted) {
                await relation.dispose();
                return { dispose };
            }
            handles.push(relation);
            const handle = await options.observeAction(watchAction, { kind: 'get', sessionId: id }, () => {
                state.metadataDirty = true;
                notify();
            }, { signal: controller.signal });
            if (controller.signal.aborted) await handle.dispose();
            else handles.push(handle);
            await Promise.all([...state.native.values()].map(demand => observeNative(state, demand)));
            return { dispose };
        } catch (error) {
            await dispose();
            throw error;
        }
    },
};
