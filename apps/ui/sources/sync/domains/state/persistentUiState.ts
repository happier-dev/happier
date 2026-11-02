import { useCallback, useSyncExternalStore } from 'react';
import { getPersistenceStorage, subscribePersistenceStorageCleared } from './persistenceStorage';

/** Device storage and retained-data admission refusals are recoverable. */
export class UiStatePersistenceError extends Error {
    constructor(readonly cause: unknown) {
        super(cause instanceof Error ? cause.message : 'Failed to persist UI state');
        this.name = 'UiStatePersistenceError';
    }
}

/** Keyed projections over the existing device KV owner, never another settings blob. */
export function createPersistentUiState<T>(namespace: string, parse: (value: unknown) => T) {
    const prefix = `ui-state:${namespace}:`;
    const values = new Map<string, T>();
    let snapshot: Readonly<Record<string, T>> | undefined;
    const loadedKeys = new Set<string>();
    let allLoaded = false;
    const listeners = new Set<() => void>();
    const keyedListeners = new Map<string, Set<() => void>>();
    const prefixListeners = new Map<string, Set<(key?: string) => void>>();
    subscribePersistenceStorageCleared(() => {
        const previousKeys = new Set(values.keys());
        values.clear();
        snapshot = undefined;
        loadedKeys.clear();
        allLoaded = false;
        for (const listener of listeners) listener();
        for (const [key, subscriptions] of keyedListeners) {
            if (previousKeys.has(key)) for (const listener of subscriptions) listener();
        }
        for (const subscriptions of prefixListeners.values()) for (const listener of subscriptions) listener();
    });
    const readStrict = (key: string, admission?: (value: unknown) => T): T | undefined => {
        if (admission) {
            // Migration must inspect the actual destination, even if a tolerant
            // presentation read has already cached a fallback for these bytes.
            try {
                const raw = getPersistenceStorage().getString(prefix + key);
                return raw === undefined ? undefined : admission(JSON.parse(raw));
            } catch (error) {
                throw error instanceof UiStatePersistenceError ? error : new UiStatePersistenceError(error);
            }
        }
        if (!loadedKeys.has(key)) {
            let raw: string | undefined;
            try { raw = getPersistenceStorage().getString(prefix + key); }
            catch (error) { throw new UiStatePersistenceError(error); }
            if (raw !== undefined) {
                let value: unknown;
                try { value = JSON.parse(raw); } catch { value = null; }
                values.set(key, parse(value));
                snapshot = undefined;
            }
            loadedKeys.add(key);
        }
        return values.get(key);
    };
    const read = (key: string): T | undefined => {
        try { return readStrict(key); } catch (error) {
            if (!(error instanceof UiStatePersistenceError)) throw error;
            console.warn('[ui-state] Device state could not be read.');
            return undefined;
        }
    };
    const readAll = (): Readonly<Record<string, T>> => {
        if (!allLoaded) {
            let keys: string[];
            try { keys = getPersistenceStorage().getAllKeys(); }
            catch {
                console.warn('[ui-state] Device state could not be read.');
                return snapshot ??= Object.fromEntries(values);
            }
            for (const key of keys) if (key.startsWith(prefix)) read(key.slice(prefix.length));
            allLoaded = true;
        }
        return snapshot ??= Object.fromEntries(values);
    };
    const publish = (key: string) => {
        snapshot = undefined;
        for (const listener of listeners) listener();
        for (const listener of keyedListeners.get(key) ?? []) listener();
        for (const [selectedPrefix, subscriptions] of prefixListeners) {
            if (key.startsWith(selectedPrefix)) for (const listener of subscriptions) listener(key);
        }
    };
    const set = (key: string, value: T): void => {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new TypeError('UI state must be JSON serializable');
        const storage = getPersistenceStorage();
        try {
            if (storage.getString(prefix + key) === serialized) return;
            storage.set(prefix + key, serialized);
        } catch (error) { throw new UiStatePersistenceError(error); }
        values.set(key, value);
        loadedKeys.add(key);
        publish(key);
    };
    const remove = (key: string): void => {
        read(key);
        if (!values.has(key)) return;
        try { getPersistenceStorage().delete(prefix + key); } catch (error) { throw new UiStatePersistenceError(error); }
        values.delete(key);
        publish(key);
    };
    const subscribeKey = (key: string, listener: () => void) => {
        let subscriptions = keyedListeners.get(key);
        if (!subscriptions) keyedListeners.set(key, subscriptions = new Set());
        subscriptions.add(listener);
        return () => {
            subscriptions.delete(listener);
            if (!subscriptions.size) keyedListeners.delete(key);
        };
    };
    /** A mounted selection owns only its consumed keys; unrelated writes never read or publish it. */
    const observe = (selection: string | readonly string[]) => {
        let selected: Readonly<Record<string, T>> | undefined;
        let prefixKeys: Set<string> | undefined;
        const readSelected = () => {
            if (selected) return selected;
            if (typeof selection === 'string' && !prefixKeys) {
                try {
                    prefixKeys = new Set(getPersistenceStorage().getAllKeys()
                        .filter(key => key.startsWith(prefix + selection)).map(key => key.slice(prefix.length)));
                } catch {
                    console.warn('[ui-state] Device state could not be read.');
                    return selected = {};
                }
            }
            const entries: [string, T][] = [];
            for (const key of typeof selection === 'string' ? prefixKeys! : selection) {
                const value = read(key);
                if (value !== undefined) entries.push([key, value]);
            }
            return selected = Object.fromEntries(entries);
        };
        return { read: readSelected, subscribe: (listener: () => void) => {
            // Recheck the render-to-subscription gap through the same storage owner.
            selected = undefined;
            prefixKeys = undefined;
            if (typeof selection !== 'string') {
                const stops = selection.map(key => subscribeKey(key, () => { selected = undefined; listener(); }));
                return () => { for (const stop of stops) stop(); };
            }
            const changed = (key?: string) => {
                if (key === undefined) prefixKeys = undefined;
                else if (prefixKeys) {
                    if (values.has(key)) prefixKeys.add(key);
                    else prefixKeys.delete(key);
                }
                selected = undefined;
                listener();
            };
            let subscriptions = prefixListeners.get(selection);
            if (!subscriptions) prefixListeners.set(selection, subscriptions = new Set());
            subscriptions.add(changed);
            return () => {
                subscriptions.delete(changed);
                if (!subscriptions.size) prefixListeners.delete(selection);
            };
        } };
    };
    return {
        readAll,
        read,
        readStrict,
        set,
        remove,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        subscribeKey,
        observe,
    };
}

export function usePersistentUiStateValue<T>(state: ReturnType<typeof createPersistentUiState<T>>, key: string | null): T | undefined {
    const subscribe = useCallback((listener: () => void) => key === null ? () => {} : state.subscribeKey(key, listener), [key, state]);
    const read = useCallback(() => key === null ? undefined : state.read(key), [key, state]);
    return useSyncExternalStore(subscribe, read, read);
}
