import { describe, expect, it, vi } from 'vitest';
import { createEditorDocumentHistory } from './editorDocumentHistory';

describe('document undo history', () => {
    it('does not publish history changes for unchanged large-buffer echoes', () => {
        const history = createEditorDocumentHistory();
        const text = 'const unchanged = 1;\n'.repeat(5_000);
        const snapshot = history.getSnapshot();
        const listener = vi.fn();
        const unsubscribe = history.subscribe(listener);
        listener.mockClear();
        for (let index = 0; index < 100; index++) history.record(text, text);
        expect(listener).not.toHaveBeenCalled();
        expect(history.getSnapshot()).toBe(snapshot);
        unsubscribe();
    });

    it('publishes availability once for a burst of edits that all remain undoable', () => {
        const history = createEditorDocumentHistory();
        const listener = vi.fn();
        const unsubscribe = history.subscribe(listener);
        listener.mockClear();
        let text = 'line\r\n🌍';
        for (let index = 0; index < 100; index++) {
            const next = text + 'x';
            history.record(text, next); text = next;
        }
        expect(listener.mock.calls).toEqual([[{ canUndo: true, canRedo: false }]]);
        unsubscribe();
    });

    it('undoes and redoes edits made by successive raw and rich surfaces without changing Unicode or CRLF bytes', () => {
        const history = createEditorDocumentHistory();
        const original = '# Title\r\nhello 🌍\r\n';
        const raw = original.replace('hello', 'hello there');
        const rich = raw.replace('# Title', '## Title');
        history.record(original, raw);
        history.record(raw, rich);
        expect(history.undo(rich)).toBe(raw);
        expect(history.undo(raw)).toBe(original);
        expect(history.getSnapshot()).toEqual({ canUndo: false, canRedo: true });
        expect(history.redo(original)).toBe(raw);
        expect(history.redo(raw)).toBe(rich);
    });

    it('retires only the redo branch after a new edit and clears history on a new document seed', () => {
        const history = createEditorDocumentHistory();
        history.record('a', 'ab');
        history.record('ab', 'abc');
        expect(history.undo('abc')).toBe('ab');
        history.record('ab', 'abx');
        expect(history.redo('abx')).toBeNull();
        expect(history.undo('abx')).toBe('ab');
        expect(history.undo('ab')).toBe('a');
        history.reset();
        expect(history.redo('a')).toBeNull();
        expect(history.getSnapshot()).toEqual({ canUndo: false, canRedo: false });
    });
});
