import * as React from 'react';

/**
 * Whether the user keeps the Voice orb minimised or expanded.
 *
 * This is a **preference, not a state**: it survives the app, so someone who
 * wants Voice out of the way keeps it out of the way, and someone who works
 * with the conversation open does not re-open it every session. A companion
 * that resets its own size on every launch is one the user has to keep
 * correcting.
 *
 * In the lab this persists to `localStorage`, which is deliberate — a design
 * exploration must not add a key to the production `localSettingDefinitions`.
 * Shipping it means adding `voice.ui.orbExpanded` there and reading it through
 * `useLocalSettingMutable`, at which point this module goes away.
 */
const STORAGE_KEY = 'happier.voicelab.orbExpanded';

type Listener = () => void;

const listeners = new Set<Listener>();

function read(): boolean {
    try {
        const store = (globalThis as { localStorage?: Storage }).localStorage;
        return store?.getItem(STORAGE_KEY) === '1';
    } catch {
        // Private mode, or a native runtime with no localStorage. A preference
        // that cannot be stored is not an error — it just does not persist.
        return false;
    }
}

let current = read();

function write(next: boolean): void {
    current = next;
    try {
        (globalThis as { localStorage?: Storage }).localStorage?.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
        // Ignore: the in-memory value still drives this session.
    }
    for (const listener of listeners) listener();
}

export function setVoiceOrbExpanded(next: boolean): void {
    if (next === current) return;
    write(next);
}

/** Subscribed through `useSyncExternalStore`, so every mounted orb agrees. */
export function useVoiceOrbExpanded(): readonly [boolean, (next: boolean) => void] {
    const subscribe = React.useCallback((listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }, []);
    const value = React.useSyncExternalStore(subscribe, () => current, () => current);
    return [value, setVoiceOrbExpanded] as const;
}
