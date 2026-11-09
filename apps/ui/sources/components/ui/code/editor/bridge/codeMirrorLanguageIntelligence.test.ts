// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { startCompletion, currentCompletions, acceptCompletion } from '@codemirror/autocomplete';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeEditorLanguageIntelligence } from '../codeEditorTypes';
import { createCodeMirrorLanguageIntelligence } from './codeMirrorLanguageIntelligence';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); vi.restoreAllMocks(); });

function fixture(text = 'ans', rangeFeatures = false, signatureHelp = false, selectionRange = false, nativeRange = true) {
    const request = vi.fn<CodeEditorLanguageIntelligence['request']>(async kind => kind === 'completion'
        ? { status: 'ok', kind: 'completion', items: [{ serverId: 's', itemId: 'i', label: 'answer' }], isIncomplete: false }
        : { status: 'loading' });
    const port: CodeEditorLanguageIntelligence = { path: 'a.ts', inlayHints: rangeFeatures ? 'all' : 'off', semanticHighlighting: rangeFeatures, request,
        getSnapshot: () => ({ mode: 'server', status: 'ready', kind: null, selection: null, querySelection: null, result: null,
            capabilities: { hover: false, definition: false, references: false, documentSymbol: false, diagnostics: 'none', acceptsExternalChanges: false,
                completion: true, completionResolve: true, formatting: true, inlayHint: rangeFeatures, semanticTokensRange: rangeFeatures && nativeRange, semanticTokensDelta: rangeFeatures && !nativeRange, completionTriggerCharacters: ['.'],
                signatureHelp, selectionRange, signatureTriggerCharacters: ['('], signatureRetriggerCharacters: [','] } }), subscribe: () => () => undefined };
    const signatures: unknown[] = [];
    const runtime = createCodeMirrorLanguageIntelligence(port, help => signatures.push(help));
    const view = new EditorView({ state: EditorState.create({ doc: text, selection: { anchor: text.replace(/\r\n|\r/g, '\n').length },
        extensions: [EditorState.lineSeparator.of(text.includes('\r\n') ? '\r\n' : '\n'), history(), ...runtime.extensions] }), parent: document.body });
    cleanup.push(() => { runtime.dispose(); view.destroy(); });
    return { request, runtime, view, signatures };
}

describe('CodeMirror language intelligence adapter', () => {
    it('accepts a resolved snippet and auto-import as one undoable completion', async () => {
        const original = '// comment\nans';
        const f = fixture(original);
        f.request.mockImplementation(async kind => kind === 'completion'
            ? { status: 'ok', kind: 'completion', isIncomplete: false, items: [{ serverId: 's', itemId: 'i', label: 'answer', kind: 3, insertText: 'answer(${1:value})', insertTextFormat: 2 }] }
            : kind === 'completionResolve' ? { status: 'ok', kind, item: { serverId: 's', itemId: 'i', label: 'answer',
                documentation: '**Safe** `value` [bad](command:evil) <img src=x onerror=evil>',
                additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'import { answer } from "./answer";\n' }] } }
                : { status: 'loading' });
        startCompletion(f.view);
        await vi.waitFor(() => expect(currentCompletions(f.view.state)).toHaveLength(1));
        const item = currentCompletions(f.view.state)[0];
        expect(item.type).toBe('function');
        if (typeof item.info !== 'function') throw new Error('Completion documentation is missing');
        const documentation = await item.info(item);
        if (!(documentation instanceof HTMLElement)) throw new Error('Completion documentation DOM is missing');
        expect(documentation.querySelector('strong')?.textContent).toBe('Safe');
        expect(documentation.querySelector('code')?.textContent).toBe('value');
        expect(documentation.querySelector('img, a[href^="command:"], script')).toBeNull();
        // CodeMirror's interaction-delay boundary avoids accepting a just-opened list on the triggering key.
        await vi.waitFor(() => expect(acceptCompletion(f.view)).toBe(true));
        await vi.waitFor(() => expect(f.view.state.doc.toString()).toBe('import { answer } from "./answer";\n// comment\nanswer(value)'));
        expect(f.view.state.sliceDoc(f.view.state.selection.main.from, f.view.state.selection.main.to)).toBe('value');
        expect(undo(f.view)).toBe(true);
        expect(f.view.state.doc.toString()).toBe(original);
    });
    it('retires a pending expansion on a caret move and shrinks an accepted expansion to its real prior selection', async () => {
        const f = fixture('first second', false, false, true);
        const answer = { status: 'ok' as const, kind: 'selectionRange' as const, ranges: [{ serverId: 's', ranges: [
            { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        ] }] };
        let settle!: (value: typeof answer) => void;
        let signal: AbortSignal | undefined;
        f.request.mockImplementation((_kind, _options, abort) => { signal = abort; return new Promise(done => { settle = done; }); });
        f.view.dispatch({ selection: { anchor: 2 } });
        expect(f.runtime.command(f.view, 'expandSelection')).toBe(true);
        f.view.dispatch({ selection: { anchor: 9 } });
        expect(signal?.aborted).toBe(true);
        settle(answer);
        await Promise.resolve(); await Promise.resolve();
        expect(f.view.state.selection.main.from).toBe(9);
        expect(f.view.state.selection.main.to).toBe(9);
        expect(f.runtime.command(f.view, 'shrinkSelection')).toBe(false);
        // Returning to the original caret cannot revive the retired request.
        f.view.dispatch({ selection: { anchor: 2 } });
        f.runtime.command(f.view, 'expandSelection');
        f.view.dispatch({ selection: { anchor: 9 } });
        f.view.dispatch({ selection: { anchor: 2 } });
        settle(answer);
        await Promise.resolve(); await Promise.resolve();
        expect(f.view.state.selection.main.from).toBe(2);
        expect(f.view.state.selection.main.to).toBe(2);
        expect(f.runtime.command(f.view, 'shrinkSelection')).toBe(false);
        f.request.mockResolvedValue(answer);
        expect(f.runtime.command(f.view, 'expandSelection')).toBe(true);
        await vi.waitFor(() => expect(f.view.state.selection.main.to).toBe(5));
        expect(f.view.state.selection.main.from).toBe(0);
        expect(f.runtime.command(f.view, 'shrinkSelection')).toBe(true);
        expect(f.view.state.selection.main.from).toBe(2);
        expect(f.view.state.selection.main.to).toBe(2);
    });
    it('keeps parameter help current while typing an argument after its trigger', async () => {
        const f = fixture('call', false, true);
        const help = { signatures: [{ label: 'call(value: string)' }], activeParameter: 0 };
        f.request.mockImplementation(async kind => kind === 'signatureHelp' ? { status: 'ok', kind: 'signatureHelp', help } : { status: 'loading' });
        f.view.dispatch({ changes: { from: 4, insert: '(' }, selection: { anchor: 5 } });
        await vi.waitFor(() => expect(f.signatures.at(-1)).toEqual(help));
        f.view.dispatch({ changes: { from: 5, insert: 'x' }, selection: { anchor: 6 } });
        await vi.waitFor(() => expect(f.request.mock.calls.filter(([kind]) => kind === 'signatureHelp')).toHaveLength(2));
        expect(f.request.mock.calls.filter(([kind]) => kind === 'signatureHelp')[1][1]?.signatureContext).toMatchObject({ isRetrigger: true, triggerKind: 3 });
    });
    it.each([true, false])('does not requery visible-range hints or tokens when only the caret moves (native range: %s)', async (nativeRange) => {
        const f = fixture('first\nsecond', true, false, false, nativeRange);
        await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
        f.request.mockClear();
        f.view.dispatch({ selection: { anchor: 1 } });
        await Promise.resolve(); await Promise.resolve();
        expect(f.request.mock.calls.map(([kind]) => kind)).toEqual([]);
    });
    it('uses CodeMirror autocomplete with no text in queries and cancels on an incompatible edit', async () => {
        const f = fixture();
        let signal: AbortSignal | undefined;
        let resolve: ((value: Awaited<ReturnType<CodeEditorLanguageIntelligence['request']>>) => void) | undefined;
        f.request.mockImplementation((_kind, _options, abort) => { signal = abort; return new Promise(done => { resolve = done; }); });
        startCompletion(f.view);
        await vi.waitFor(() => expect(f.request).toHaveBeenCalled());
        expect(f.request.mock.calls[0][1]).toMatchObject({ position: { line: 0, character: 3 }, completionContext: { triggerKind: 1 } });
        expect(f.request.mock.calls[0][1]).not.toHaveProperty('text');
        f.view.dispatch({ changes: { from: 3, insert: 'x' } });
        expect(signal?.aborted).toBe(true);
        resolve?.({ status: 'ok', kind: 'completion', items: [{ serverId: 's', itemId: 'late', label: 'stale' }], isIncomplete: false });
        await vi.waitFor(() => expect(currentCompletions(f.view.state)).toEqual([]));
    });

    it('applies format edits to the buffer with one undo and preserves BOM, CRLF and final newline', async () => {
        const original = '\uFEFFconst x={a:1};\r\n';
        const f = fixture(original);
        f.request.mockResolvedValue({ status: 'ok', kind: 'formatting', files: [{ path: 'a.ts', expectedHash: 'a'.repeat(64), edits: [
            { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 9 } }, text: ' = ' },
            { range: { start: { line: 0, character: 11 }, end: { line: 0, character: 12 } }, text: ': ' },
        ] }] });
        expect(f.runtime.command(f.view, 'format')).toBe(true);
        await vi.waitFor(() => expect(f.view.state.doc.toString()).toContain(' = '));
        expect(f.view.state.sliceDoc()).toBe('\uFEFFconst x = {a: 1};\r\n');
        expect(undo(f.view)).toBe(true);
        expect(f.view.state.sliceDoc()).toBe(original);
        expect(f.request.mock.calls.map(([kind]) => kind)).toEqual(['formatting']);
    });
});
