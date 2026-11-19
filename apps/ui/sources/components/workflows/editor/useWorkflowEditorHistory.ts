import * as React from 'react';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { sameWorkflowResultFieldOrderV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

type WorkflowEditorHistorySnapshot = WorkflowEditorDraft | Readonly<{ draft: WorkflowEditorDraft }>;

/** Editor content includes visible result-field order; ordinary JSON and Plan identity do not. */
export function workflowEditorSnapshotsEqual(
    left: WorkflowEditorHistorySnapshot | null,
    right: WorkflowEditorHistorySnapshot | null,
): boolean {
    if (!pluginJsonValuesEqual(left, right)) return false;
    if (left === null || right === null) return true;
    return sameWorkflowResultFieldOrderV1(
        ('draft' in left ? left.draft : left).blocks,
        ('draft' in right ? right.draft : right).blocks,
    );
}

/**
 * Undo and Redo as the controls show them. The labels are read at call time; a control subscribes
 * to them (`useWorkflowEditorHistoryLabels`), so recording an edit re-renders only Undo and Redo.
 * A history without `subscribe` never changes.
 */
export type WorkflowEditorHistoryControls = Readonly<{
    readonly undoLabel: string | null;
    readonly redoLabel: string | null;
    undo: () => void;
    redo: () => void;
    subscribe?: (listener: () => void) => () => void;
}>;

const NO_HISTORY_CHANGES = () => () => {};

/** The labels Undo and Redo show, re-read only when the history announces a change. */
export function useWorkflowEditorHistoryLabels(controls: WorkflowEditorHistoryControls | undefined): Readonly<{ undoLabel: string | null; redoLabel: string | null }> {
    const subscribe = controls?.subscribe ?? NO_HISTORY_CHANGES;
    const undoLabel = React.useSyncExternalStore(subscribe, () => controls?.undoLabel ?? null, () => controls?.undoLabel ?? null);
    const redoLabel = React.useSyncExternalStore(subscribe, () => controls?.redoLabel ?? null, () => controls?.redoLabel ?? null);
    return { undoLabel, redoLabel };
}

type Change<T> = Readonly<{ before: T; after: T; label: string }>;

/**
 * One source-local history. Native inputs stage a transaction until their commit boundary.
 * It holds no React state: an edit notifies the controls that show it, not the editor that owns it.
 */
export function useWorkflowEditorHistory<T extends WorkflowEditorHistorySnapshot>(scope: string, restore: (snapshot: T) => void) {
    const state = React.useRef({ scope, revision: 0, past: [] as Change<T>[], future: [] as Change<T>[], pending: null as Change<T> | null });
    if (state.current.scope !== scope) state.current = { scope, revision: 0, past: [], future: [], pending: null };
    const restoreRef = React.useRef(restore);
    restoreRef.current = restore;
    const [listeners] = React.useState(() => new Set<() => void>());
    const notify = React.useCallback(() => { for (const listener of [...listeners]) listener(); }, [listeners]);
    const commit = React.useCallback(() => {
        const current = state.current;
        if (current.pending === null) return;
        if (!workflowEditorSnapshotsEqual(current.pending.before, current.pending.after)) {
            current.past.push(current.pending);
            current.future = [];
        }
        current.pending = null;
        notify();
    }, [notify]);
    const record = React.useCallback((before: T, after: T, label: string, committed = true) => {
        if (workflowEditorSnapshotsEqual(before, after)) { if (committed) commit(); return false; }
        if (committed) {
            commit();
            state.current.past.push({ before, after, label });
            state.current.future = [];
        } else {
            state.current.pending = { before: state.current.pending?.before ?? before, after, label: state.current.pending?.label ?? label };
            state.current.future = [];
        }
        state.current.revision += 1;
        notify();
        return true;
    }, [commit, notify]);
    const undo = React.useCallback(() => {
        commit();
        const change = state.current.past.at(-1);
        if (!change) return;
        // A failed restoration leaves the entry intact (e.g. a removed private trigger requiring setup).
        restoreRef.current(change.before);
        state.current.past.pop();
        state.current.future.push(change);
        state.current.revision += 1;
        notify();
    }, [commit, notify]);
    const redo = React.useCallback(() => {
        commit();
        const change = state.current.future.at(-1);
        if (!change) return;
        restoreRef.current(change.after);
        state.current.future.pop();
        state.current.past.push(change);
        state.current.revision += 1;
        notify();
    }, [commit, notify]);
    const reset = React.useCallback(() => {
        const current = state.current;
        current.past = [];
        current.future = [];
        current.pending = null;
        current.revision += 1;
        notify();
    }, [notify]);
    const subscribe = React.useCallback((listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }, [listeners]);
    // One identity for the history's lifetime; the labels are read when shown.
    const controls = React.useMemo((): WorkflowEditorHistoryControls => ({
        // A staged edit (a prompt still being typed) is the latest change: Undo commits it first, so it is offered now.
        get undoLabel() {
            const { pending, past } = state.current;
            if (pending !== null && !workflowEditorSnapshotsEqual(pending.before, pending.after)) return pending.label;
            return past.at(-1)?.label ?? null;
        },
        get redoLabel() { return state.current.future.at(-1)?.label ?? null; },
        undo, redo, subscribe,
    }), [redo, subscribe, undo]);
    const getRevision = React.useCallback(() => state.current.revision, []);
    return { controls, record, commit, reset, getRevision };
}
