import * as React from 'react';

import { isDesktopHost } from '@/utils/platform/desktopHost';
import { retainDeep, retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

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

export function reconcileDesktopActivityOverlayState(
    previous: DesktopActivityOverlayWindowStatePayload | null,
    next: DesktopActivityOverlayWindowStatePayload,
): DesktopActivityOverlayWindowStatePayload {
    if (!previous) return next;
    const faces = retainDeep(previous.model.faces, {
        ...next.model.faces,
        faces: retainKeyedRows(previous.model.faces.faces, next.model.faces.faces, sessionAddressKey),
    });
    // generatedAt is a builder stamp, not a rendered fact or publication trigger.
    const model = retainDeep(previous.model, { ...next.model, faces, generatedAt: previous.model.generatedAt });
    return retainDeep(previous, { ...next, model: model === previous.model ? model : { ...model, generatedAt: next.model.generatedAt } });
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
