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
    /** Reads every shown read again (the card's own Retry), so a not-current card can become current. */
    refresh: () => Promise<unknown>;
}>;

/** What a mounted document registers: how to read what it shows, and when that changes. */
export type WidgetSnapshotCaptureSource = Readonly<{
    read: () => WidgetSnapshotCapture | null;
    subscribe: (listener: () => void) => () => void;
}>;

/**
 * The card's one capture slot: the mounted document registers how to read what it shows; the card's
 * ⋯ asks only when the person opens Post a snapshot. Nothing is copied or re-read before that.
 */
export type WidgetSnapshotCaptureSlot = Readonly<{
    register: (source: WidgetSnapshotCaptureSource) => () => void;
    capture: () => WidgetSnapshotCapture | null;
    /** What the mounted card shows changed (a read finished refreshing); the open confirm re-reads it. */
    watch: (listener: () => void) => () => void;
    /** Whether a live declarative body is mounted in this card at all. */
    subscribe: (listener: () => void) => () => void;
    isAvailable: () => boolean;
}>;

export function createWidgetSnapshotCaptureSlot(): WidgetSnapshotCaptureSlot {
    let source: WidgetSnapshotCaptureSource | null = null;
    const listeners = new Set<() => void>();
    const watchers = new Set<() => void>();
    const emit = () => { for (const listener of listeners) listener(); };
    const changed = () => { for (const watcher of watchers) watcher(); };
    return {
        register(next) {
            source = next;
            const unsubscribe = next.subscribe(changed);
            emit();
            changed();
            return () => {
                unsubscribe();
                if (source === next) { source = null; emit(); changed(); }
            };
        },
        capture: () => source?.read() ?? null,
        watch(watcher) { watchers.add(watcher); return () => { watchers.delete(watcher); }; },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        isAvailable: () => source !== null,
    };
}

export const WidgetSnapshotCaptureContext = React.createContext<WidgetSnapshotCaptureSlot | null>(null);

export function useWidgetSnapshotCaptureAvailable(slot: WidgetSnapshotCaptureSlot): boolean {
    return React.useSyncExternalStore(slot.subscribe, slot.isAvailable, slot.isAvailable);
}
