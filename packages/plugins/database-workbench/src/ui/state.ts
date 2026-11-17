import type { WorkbenchLocation } from './models.js';
import type { DatabaseTargetsListInputV1 } from '@happier-dev/database-protocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';

export type WorkbenchPaneIdentity = Readonly<({ kind: 'session'; sessionId: string } | { kind: 'project'; projectKey: string })
    & { tab: 'database' | 'insights' }>;

/** D24: each destination retains its own selection, within the addressed Account and checkout. */
export function workbenchPaneKey(scope: DatabaseTargetsListInputV1['scope'], pane?: WorkbenchPaneIdentity): string {
    return createCanonicalJsonSigningInput(pane ? { scope, pane } : scope);
}

/** A key is a local UI leaf, never an Account setting or a fleet-wide revision. */
export function createKeyedState<T>(initial: (key: string) => T) {
    const values = new Map<string, T>();
    const listeners = new Map<string, Set<() => void>>();
    function get(key: string): T { if (!values.has(key)) values.set(key, initial(key)); return values.get(key)!; }
    return {
        get,
        set(key: string, value: T) {
            if (Object.is(get(key), value)) return;
            values.set(key, value);
            for (const listener of listeners.get(key) ?? []) listener();
        },
        subscribe(key: string, listener: () => void) {
            let set = listeners.get(key);
            if (!set) { set = new Set(); listeners.set(key, set); }
            set.add(listener);
            return () => { set.delete(listener); if (set.size === 0) listeners.delete(key); };
        },
    };
}

export type WorkbenchPaneState = Readonly<{ targetKey: string | null; location: WorkbenchLocation | null }>;

/** The mounted client retains each project's picker and pane without Account settings. */
export function createWorkbenchPaneState() {
    return createKeyedState<WorkbenchPaneState>(() => ({ targetKey: null, location: null }));
}
