import type { CodeEditorHistory, EditorDocumentHistory } from './codeEditorTypes';
import { minimalCodeEditorEdit } from './codeEditorDocumentEdit';

type Edit = Readonly<{ from: number; before: string; after: string }>;

/** Undo belongs to the document lifetime, so engine replacement cannot discard it. */
export function createEditorDocumentHistory(): EditorDocumentHistory & Readonly<{
    record(before: string, after: string): void;
    reset(): void;
}> {
    const undo: Edit[] = [];
    const redo: Edit[] = [];
    const listeners = new Set<(state: CodeEditorHistory) => void>();
    let snapshot: CodeEditorHistory = { canUndo: false, canRedo: false };
    const publish = () => {
        const canUndo = undo.length > 0, canRedo = redo.length > 0;
        if (snapshot.canUndo === canUndo && snapshot.canRedo === canRedo) return;
        snapshot = { canUndo, canRedo };
        for (const listener of listeners) listener(snapshot);
    };
    const apply = (value: string, from: Edit[], to: Edit[], direction: 'undo' | 'redo') => {
        const edit = from.at(-1);
        if (!edit) return null;
        const expected = direction === 'undo' ? edit.after : edit.before;
        if (value.slice(edit.from, edit.from + expected.length) !== expected) return null;
        const replacement = direction === 'undo' ? edit.before : edit.after;
        const next = value.slice(0, edit.from) + replacement + value.slice(edit.from + expected.length);
        from.pop(); to.push(edit); publish();
        return next;
    };
    return {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); listener(snapshot); return () => { listeners.delete(listener); }; },
        record(before, after) {
            const edit = minimalCodeEditorEdit(before, after);
            if (!edit) return;
            undo.push({ from: edit.from, before: before.slice(edit.from, edit.to), after: edit.insert });
            redo.length = 0; publish();
        },
        reset() { undo.length = 0; redo.length = 0; publish(); },
        undo: (value) => apply(value, undo, redo, 'undo'),
        redo: (value) => apply(value, redo, undo, 'redo'),
    };
}
