import * as React from 'react';
import type { PluginDeclarativeDataNodeV1, PluginDeclarativeDocumentV1 } from '@happier-dev/protocol';

/**
 * What a mounted declarative widget is showing right now, for Post a snapshot: its document and the
 * frozen node each live read is drawing, by document path. `current` is false while any read is
 * refreshing, stale or failed — a snapshot posts current numbers or nothing.
 */
export type WidgetSnapshotCapture = Readonly<{
    document: PluginDeclarativeDocumentV1;
    frozenByPath: ReadonlyMap<string, PluginDeclarativeDataNodeV1>;
    /** The read identities shown, for the snapshot's provenance. */
    digests: readonly string[];
    current: boolean;
}>;

/**
 * The card's one capture slot: the mounted document registers how to read what it shows; the card's
 * ⋯ asks only when the person opens Post a snapshot. Nothing is copied or re-read before that.
 */
export type WidgetSnapshotCaptureSlot = Readonly<{
    register: (read: () => WidgetSnapshotCapture | null) => () => void;
    capture: () => WidgetSnapshotCapture | null;
    /** Whether a live declarative body is mounted in this card at all. */
    subscribe: (listener: () => void) => () => void;
    isAvailable: () => boolean;
}>;

export function createWidgetSnapshotCaptureSlot(): WidgetSnapshotCaptureSlot {
    let reader: (() => WidgetSnapshotCapture | null) | null = null;
    const listeners = new Set<() => void>();
    const emit = () => { for (const listener of listeners) listener(); };
    return {
        register(read) {
            reader = read;
            emit();
            return () => { if (reader === read) { reader = null; emit(); } };
        },
        capture: () => reader?.() ?? null,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        isAvailable: () => reader !== null,
    };
}

export const WidgetSnapshotCaptureContext = React.createContext<WidgetSnapshotCaptureSlot | null>(null);

export function useWidgetSnapshotCaptureAvailable(slot: WidgetSnapshotCaptureSlot): boolean {
    return React.useSyncExternalStore(slot.subscribe, slot.isAvailable, slot.isAvailable);
}
