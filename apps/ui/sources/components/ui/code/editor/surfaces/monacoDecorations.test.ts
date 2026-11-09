// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { createMonacoDecorations } from './monacoDecorations';

describe('Monaco tracked decoration ranges', () => {
    it('uses engine ranges after edits and leaves other layers intact when change markers reseed', async () => {
        // jsdom lacks browser services used by Monaco's supported root entry; only the model is exercised.
        window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList);
        document.queryCommandSupported ??= () => false;
        vi.stubGlobal('CSS', { escape: (value: string) => value }); // No CSS rendering in this model-only fixture.
        const monaco = await import('monaco-editor');
        const model = monaco.editor.createModel('first\nsecond\nthird\nlast');
        let position = { lineNumber: 1, column: 1 };
        const presses: unknown[] = [];
        // The editor DOM is a platform boundary; the model and its interval mapping are real Monaco.
        const editor = {
            getModel: () => model,
            createDecorationsCollection: () => {
                let ids: string[] = [];
                return {
                    set: (items: Monaco.editor.IModelDeltaDecoration[]) => { ids = model.deltaDecorations(ids, items); return ids; },
                    getRange: (index: number) => model.getDecorationRange(ids[index]!),
                    clear: () => { ids = model.deltaDecorations(ids, []); },
                };
            },
            onMouseDown: () => ({ dispose() {} }),
            getPosition: () => position,
            setPosition: (next: typeof position) => { position = next; },
            revealLineInCenter() {}, focus() {},
        };
        const runtime = createMonacoDecorations(editor, monaco, (layer, item) => presses.push({ layer, item }));
        try {
            runtime.set('change', [{ id: 'c', key: 'k', kind: 'modified', startLine: 2, endLine: 3 }]);
            runtime.set('blame', [{ id: 'b', runId: 'r', startLine: 1, lineCount: 1 }]);
            model.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: 'before\n' }]);
            model.applyEdits([{ range: new monaco.Range(4, 1, 4, 1), text: 'inside\n' }]);
            model.applyEdits([{ range: new monaco.Range(6, 5, 6, 5), text: '\nafter' }]);
            runtime.navigate(1);
            expect(presses.at(-1)).toEqual({ layer: 'change', item: { id: 'c', key: 'k', kind: 'modified', startLine: 3, endLine: 5 } });
            model.applyEdits([{ range: new monaco.Range(1, 1, 2, 1), text: '' }]);
            position = { lineNumber: 1, column: 1 };
            runtime.navigate(1);
            expect(presses.at(-1)).toMatchObject({ item: { startLine: 2, endLine: 4 } });
            runtime.set('change', []);
            expect(model.getAllDecorations()).toHaveLength(1);
            runtime.set('change', [
                { id: 'bof', key: 'bof', kind: 'deleted', startLine: 1, endLine: 1, anchor: 'before' },
                { id: 'after', key: 'after', kind: 'deleted', startLine: 1, endLine: 1, anchor: 'after' },
            ]);
            model.applyEdits([{ range: new monaco.Range(1, 3, 1, 3), text: '\n' }]);
            position = { lineNumber: 1, column: 1 };
            runtime.navigate(1);
            expect(presses.at(-1)).toMatchObject({ item: { id: 'after', startLine: 2, endLine: 2 } });
            runtime.navigate(-1);
            expect(presses.at(-1)).toMatchObject({ item: { id: 'bof', startLine: 1, endLine: 1 } });
            runtime.remove('change', 'bof');
            runtime.remove('change', 'missing');
            position = { lineNumber: 2, column: 1 };
            runtime.navigate(-1);
            expect(presses.at(-1)).toMatchObject({ item: { id: 'after', startLine: 2, endLine: 2 } });
            expect(model.getAllDecorations()).toHaveLength(2); // remaining change and independent blame
            runtime.remove('change', 'after');
            expect(model.getAllDecorations()).toHaveLength(1);
            const count = presses.length;
            runtime.navigate(1);
            expect(presses).toHaveLength(count);
        } finally { runtime.dispose(); model.dispose(); }
    });
});
