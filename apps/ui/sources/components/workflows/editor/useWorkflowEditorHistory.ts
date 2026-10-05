import * as React from 'react';
import { pluginJsonValuesEqual } from '@happier-dev/protocol';

export type WorkflowEditorHistoryControls = Readonly<{
    undoLabel: string | null;
    redoLabel: string | null;
    undo: () => void;
    redo: () => void;
}>;

type Change<T> = Readonly<{ before: T; after: T; label: string }>;

/** One source-local history. Native inputs stage a transaction until their commit boundary. */
export function useWorkflowEditorHistory<T>(scope: string, restore: (snapshot: T) => void) {
    const [, refresh] = React.useReducer((value: number) => value + 1, 0);
    const state = React.useRef({ scope, past: [] as Change<T>[], future: [] as Change<T>[], pending: null as Change<T> | null });
    if (state.current.scope !== scope) state.current = { scope, past: [], future: [], pending: null };
    const restoreRef = React.useRef(restore);
    restoreRef.current = restore;
    const commit = React.useCallback(() => {
        const current = state.current;
        if (current.pending === null) return;
        if (!pluginJsonValuesEqual(current.pending.before, current.pending.after)) {
            current.past.push(current.pending);
            current.future = [];
        }
        current.pending = null;
        refresh();
    }, []);
    const record = React.useCallback((before: T, after: T, label: string, committed = true) => {
        if (committed) {
            commit();
            if (pluginJsonValuesEqual(before, after)) return;
            state.current.past.push({ before, after, label });
            state.current.future = [];
        } else {
            state.current.pending = { before: state.current.pending?.before ?? before, after, label: state.current.pending?.label ?? label };
            state.current.future = [];
        }
        refresh();
    }, [commit]);
    const undo = React.useCallback(() => {
        commit();
        const change = state.current.past.at(-1);
        if (!change) return;
        // A failed restoration leaves the entry intact (e.g. a removed private trigger requiring setup).
        restoreRef.current(change.before);
        state.current.past.pop();
        state.current.future.push(change);
        refresh();
    }, [commit]);
    const redo = React.useCallback(() => {
        commit();
        const change = state.current.future.at(-1);
        if (!change) return;
        restoreRef.current(change.after);
        state.current.future.pop();
        state.current.past.push(change);
        refresh();
    }, [commit]);
    const controls: WorkflowEditorHistoryControls = {
        undoLabel: state.current.past.at(-1)?.label ?? null,
        redoLabel: state.current.future.at(-1)?.label ?? null,
        undo, redo,
    };
    return { controls, record, commit };
}
