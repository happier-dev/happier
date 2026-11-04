import * as React from 'react';

import { isDesktopHost } from '@/utils/platform/desktopHost';

import {
    getDesktopActivityOverlayWindowState,
    listenDesktopActivityOverlayWindowState,
    type DesktopActivityOverlayWindowStatePayload,
} from './desktopActivityOverlayBridge';
import { isDesktopActivityOverlayWindowContext } from './isDesktopActivityOverlayWindowContext';

type Model = DesktopActivityOverlayWindowStatePayload['model'];
type ModelLeaf<K extends string> = K extends keyof Model ? Model[K] : null;
export type DesktopActivityOverlayFields = Readonly<{
    visible: boolean;
    word: Model['collapsed'];
    faces: ModelLeaf<'faces'>;
    listDetail: Model['expanded'];
    blockingCard: boolean;
    conversation: ModelLeaf<'conversation'>;
    availability: DesktopActivityOverlayWindowStatePayload['availability'];
    policy: DesktopActivityOverlayWindowStatePayload['policy'];
    placementDiagnostics: DesktopActivityOverlayWindowStatePayload['placementDiagnostics'];
    frame: DesktopActivityOverlayWindowStatePayload['frame'];
    screenOrigin: NonNullable<DesktopActivityOverlayWindowStatePayload['frame']>['screenOrigin'];
}>;

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reconcile JSON transport values per field/entry instead of serializing the whole snapshot. */
function share(previous: unknown, next: unknown, matchFacesByAddress = false): unknown {
    if (Object.is(previous, next)) return previous;
    if (Array.isArray(next) && Array.isArray(previous)) {
        const byAddress = matchFacesByAddress ? new Map(previous.filter(record).map(face =>
            [JSON.stringify([face.serverId, face.sessionId]), face])) : null;
        const values = next.map((value, index) => share(byAddress && record(value)
            ? byAddress.get(JSON.stringify([value.serverId, value.sessionId])) : previous[index], value));
        return values.length === previous.length && values.every((value, index) => value === previous[index]) ? previous : values;
    }
    if (record(next) && record(previous)) {
        const values: Record<string, unknown> = {};
        const keys = Object.keys(next);
        let unchanged = keys.length === Object.keys(previous).length;
        for (const key of keys) {
            values[key] = share(previous[key], next[key], key === 'faces');
            if (!Object.hasOwn(previous, key) || values[key] !== previous[key]) unchanged = false;
        }
        return unchanged ? previous : values;
    }
    return next;
}

export function reconcileDesktopActivityOverlayState(
    previous: DesktopActivityOverlayWindowStatePayload | null,
    next: DesktopActivityOverlayWindowStatePayload,
): DesktopActivityOverlayWindowStatePayload {
    if (!previous) return next;
    // generatedAt is a builder stamp, not a rendered fact or publication trigger.
    const model = share(previous.model, { ...next.model, generatedAt: previous.model.generatedAt }) as Model;
    return share(previous, { ...next, model: model === previous.model ? model : { ...model, generatedAt: next.model.generatedAt } }) as DesktopActivityOverlayWindowStatePayload;
}

function modelLeaf<K extends string>(model: Model, key: K): ModelLeaf<K> {
    return (key in model ? (model as unknown as Record<string, unknown>)[key] : null) as ModelLeaf<K>;
}

function field<K extends keyof DesktopActivityOverlayFields>(state: DesktopActivityOverlayWindowStatePayload | null, key: K): DesktopActivityOverlayFields[K] | null {
    if (!state) return null;
    const fields: DesktopActivityOverlayFields = {
        visible: state.visible, word: state.model.collapsed, faces: modelLeaf(state.model, 'faces'),
        listDetail: state.model.expanded, conversation: modelLeaf(state.model, 'conversation'),
        get blockingCard() {
            return (state.model.expanded.cards ?? []).some(card => card.kind === 'permission_request' || card.kind === 'user_question');
        },
        availability: state.availability, policy: state.policy, placementDiagnostics: state.placementDiagnostics, frame: state.frame,
        screenOrigin: state.frame?.screenOrigin,
    };
    return fields[key];
}

let snapshot: DesktopActivityOverlayWindowStatePayload | null = null;
const subscribers = new Map<keyof DesktopActivityOverlayFields | 'all', Set<() => void>>();
let stopObservation: (() => void) | null = null;

function publish(payload: DesktopActivityOverlayWindowStatePayload): void {
    const previous = snapshot;
    const next = reconcileDesktopActivityOverlayState(previous, payload);
    if (next === previous) return;
    snapshot = next;
    for (const [key, listeners] of subscribers) {
        if (key === 'all' || field(previous, key) !== field(next, key)) {
            for (const listener of listeners) listener();
        }
    }
}

function observe(): () => void {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let stateEventVersion = 0;
    const read = async () => {
        const readEventVersion = stateEventVersion;
        try {
            const payload = await getDesktopActivityOverlayWindowState();
            if (!disposed && payload && readEventVersion === stateEventVersion) publish(payload);
        } catch { /* The host availability owner presents an unavailable role. */ }
    };
    const initialRead = read();
    void listenDesktopActivityOverlayWindowState(payload => {
        if (disposed || !payload) return;
        stateEventVersion += 1;
        publish(payload);
    }).then(async dispose => {
        if (disposed) { dispose(); return; }
        unlisten = dispose;
        await initialRead;
        if (!disposed) await read(); // Preserve the asynchronous listener-gap reconciliation.
    }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
}

function subscribe(key: keyof DesktopActivityOverlayFields | 'all', listener: () => void): () => void {
    if (!isDesktopHost() || !isDesktopActivityOverlayWindowContext()) return () => {};
    let listeners = subscribers.get(key);
    if (!listeners) { listeners = new Set(); subscribers.set(key, listeners); }
    listeners.add(listener);
    if (!stopObservation) stopObservation = observe();
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) subscribers.delete(key);
        if (subscribers.size === 0) {
            stopObservation?.();
            stopObservation = null;
            snapshot = null;
        }
    };
}

const subscribeAll = (listener: () => void) => subscribe('all', listener);
const readSnapshot = () => snapshot;
const emptySnapshot = () => null;

export function useDesktopActivityOverlayState(): DesktopActivityOverlayWindowStatePayload | null {
    return React.useSyncExternalStore(subscribeAll, readSnapshot, emptySnapshot);
}

export function useDesktopActivityOverlayField<K extends keyof DesktopActivityOverlayFields>(key: K): DesktopActivityOverlayFields[K] | null {
    const subscribeField = React.useCallback((listener: () => void) => subscribe(key, listener), [key]);
    return React.useSyncExternalStore(subscribeField, () => field(snapshot, key), emptySnapshot);
}

/**
 * Whether a field is present, for an owner that only decides layout from it (the island shows the pinned
 * panel's leaf); the leaf subscribes to the field's content itself, so its changes never render that owner.
 */
export function useDesktopActivityOverlayFieldPresent(key: keyof DesktopActivityOverlayFields): boolean {
    const subscribeField = React.useCallback((listener: () => void) => subscribe(key, listener), [key]);
    return React.useSyncExternalStore(subscribeField, () => field(snapshot, key) != null, () => false);
}
