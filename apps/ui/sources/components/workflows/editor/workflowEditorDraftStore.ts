import * as React from 'react';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

/**
 * A readable value that announces its changes. The editor's draft lives in one, so a keystroke
 * re-renders only the parts that read the changed slice, never the whole editor.
 */
export type WorkflowEditorReadable<T> = Readonly<{
    get: () => T;
    subscribe: (listener: () => void) => () => void;
}>;

/** The draft as the editor body reads it. Edits still go out through the owner's `onChange`. */
export type WorkflowEditorDraftStore = WorkflowEditorReadable<WorkflowEditorDraft>;

export type WritableWorkflowEditorReadable<T> = WorkflowEditorReadable<T> & Readonly<{
    set: (next: T) => void;
    /**
     * For a write made while the owner renders: readers re-render with that render, so the value
     * is replaced without notifying, and `publish` (from the owner's commit) notifies only if a
     * staged value was never announced.
     */
    stage: (next: T) => void;
    publish: () => void;
}>;

/** One owner writes; readers subscribe. Setting an identical value publishes nothing. */
export function createWorkflowEditorReadable<T>(initial: T): WritableWorkflowEditorReadable<T> {
    let value = initial;
    let staged = false;
    const listeners = new Set<() => void>();
    const notify = () => {
        staged = false;
        for (const listener of [...listeners]) listener();
    };
    return {
        get: () => value,
        set: (next) => {
            if (Object.is(next, value)) return;
            value = next;
            notify();
        },
        stage: (next) => {
            if (Object.is(next, value)) return;
            value = next;
            staged = true;
        },
        publish: () => { if (staged) notify(); },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

/**
 * The slice a reader shows. It re-renders only when the selected value changes by `isEqual`, so a
 * reader of the name stays still while a step is typed in, and the reverse.
 */
export function useWorkflowEditorSelector<T, S>(
    source: WorkflowEditorReadable<T>,
    select: (value: T) => S,
    isEqual: (left: S, right: S) => boolean = Object.is,
): S {
    const memo = React.useRef<Readonly<{ value: T; select: (value: T) => S; isEqual: (left: S, right: S) => boolean; selected: S }> | null>(null);
    const read = () => {
        const value = source.get();
        const last = memo.current;
        if (last !== null && last.value === value && last.select === select && last.isEqual === isEqual) return last.selected;
        const next = select(value);
        const selected = last !== null && isEqual(last.selected, next) ? last.selected : next;
        memo.current = { value, select, isEqual, selected };
        return selected;
    };
    return React.useSyncExternalStore(source.subscribe, read, read);
}

/**
 * A draft held in React state by a controlled consumer (a read-only catalog page, a design or test
 * host) becomes the body's store here. Such a consumer re-renders the body with each draft, so the
 * value is staged in that same render and announced at commit only to readers that did not re-render.
 */
export function useControlledWorkflowEditorDraftStore(draft: WorkflowEditorDraft): WorkflowEditorDraftStore {
    const [store] = React.useState(() => createWorkflowEditorReadable(draft));
    store.stage(draft);
    React.useLayoutEffect(() => { store.publish(); });
    return store;
}
