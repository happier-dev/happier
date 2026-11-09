import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { createCodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import type { LanguageIntelligenceQueryInput, LanguageIntelligenceQueryResult } from '@happier-dev/protocol/machines/languageIntelligence';
import { bindMonacoLanguageIntelligence } from './monacoLanguageIntelligence';

// The fake engine supplies coordinates only; these providers never invoke Position/Range prototype methods.
const enginePosition = (lineNumber: number, column: number) => ({ lineNumber, column } as Monaco.Position);

function fixture(nativeRange = true) {
    let version = 1;
    let text = 'ans';
    const edits = new Set<() => void>();
    const requests: { input: LanguageIntelligenceQueryInput; signal: AbortSignal; resolve(result: LanguageIntelligenceQueryResult): void }[] = [];
    const controller = createCodeIntelligenceController({
        scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
        getText: () => text, query: async () => ({ status: 'unavailable', reason: 'no_capable_server' }), openLocation() {},
        languageServer: {
            sync: async input => ({ status: 'ok', generation: 'g', ...('version' in input.op ? { version: input.op.version } : {}), servers: [],
                capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'none', acceptsExternalChanges: false,
                    completion: true, completionResolve: true, completionTriggerCharacters: ['.'], signatureHelp: true, signatureTriggerCharacters: ['('],
                    formatting: true, rangeFormatting: true, organizeImports: true, inlayHint: true, semanticTokensRange: nativeRange, semanticTokensDelta: !nativeRange, documentHighlight: true, selectionRange: true } }),
            query: (input, signal) => new Promise(resolve => requests.push({ input, signal, resolve })),
            watch: (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
            restart: async () => ({ status: 'ok' }),
        },
    });
    let completion: Monaco.languages.CompletionItemProvider | undefined;
    let hints: Monaco.languages.InlayHintsProvider | undefined;
    let semantic: Monaco.languages.DocumentRangeSemanticTokensProvider | undefined;
    let highlights: Monaco.languages.DocumentHighlightProvider | undefined;
    let references: Monaco.languages.ReferenceProvider | undefined;
    let peekLocations: Monaco.languages.Location[] | undefined | null;
    let peekWork = Promise.resolve();
    let semanticColoring = false; // Monaco standalone themes disable this unless explicitly configured.
    const registrations = new Set<unknown>();
    const register = (provider: unknown) => { registrations.add(provider); return { dispose: () => registrations.delete(provider) }; };
    const uri = (path: string, query = '') => ({ path, toString: () => `${path}?${query}` } as Monaco.Uri);
    let opener: Monaco.editor.ICodeEditorOpener | undefined;
    const previewModels: { uri: Monaco.Uri; text: string; dispose: ReturnType<typeof vi.fn> }[] = [];
    // Monaco is the browser engine boundary. Keep the controller and document synchronization real.
    const model = { getVersionId: () => version, getLanguageId: () => 'typescript', getWordUntilPosition: () => ({ startColumn: 1, endColumn: 4 }),
        uri: uri('/a.ts'), getValue: () => text, onDidChangeContent: (callback: () => void) => { edits.add(callback); return { dispose: () => edits.delete(callback) }; } } as unknown as Monaco.editor.ITextModel;
    const editor = { getModel: () => model, getVisibleRanges: () => [{ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 10 }],
        onDidChangeModelContent: (callback: () => void) => { edits.add(callback); return { dispose: () => edits.delete(callback) }; },
        onDidDispose: () => ({ dispose() {} }), updateOptions: vi.fn((options: Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions) => {
            if (typeof options['semanticHighlighting.enabled'] === 'boolean') semanticColoring = options['semanticHighlighting.enabled'];
        }), getPosition: () => enginePosition(1, 2), focus: vi.fn(),
        // Monaco 0.55's Action2 command is not exposed by getAction; trigger dispatches it without positional arguments.
        getAction: () => null,
        trigger: vi.fn((_source: string, id: string) => {
            if (id === 'editor.action.referenceSearch.trigger') peekWork = (async () => {
                peekLocations = await references?.provideReferences(model, enginePosition(1, 2), { includeDeclaration: true }, token);
            })();
        }),
    } as unknown as Monaco.editor.IStandaloneCodeEditor;
    const monaco = { Uri: { from: (parts: Monaco.UriComponents) => uri(parts.path ?? '', parts.query) }, editor: {
        registerEditorOpener: (value: Monaco.editor.ICodeEditorOpener) => { opener = value; return register(value); },
        createModel: (value: string, _language: string | undefined, uri: Monaco.Uri) => {
            const preview = { uri, text: value, dispose: vi.fn() }; previewModels.push(preview); return preview;
        },
    }, languages: {
        registerCompletionItemProvider: (_selector: unknown, provider: Monaco.languages.CompletionItemProvider) => { completion = provider; return register(provider); },
        registerSignatureHelpProvider: (_selector: unknown, provider: unknown) => register(provider),
        registerDocumentFormattingEditProvider: (_selector: unknown, provider: unknown) => register(provider),
        registerDocumentRangeFormattingEditProvider: (_selector: unknown, provider: unknown) => register(provider),
        registerInlayHintsProvider: (_selector: unknown, provider: Monaco.languages.InlayHintsProvider) => { hints = provider; return register(provider); },
        registerDocumentRangeSemanticTokensProvider: (_selector: unknown, provider: Monaco.languages.DocumentRangeSemanticTokensProvider) => { semantic = provider; return register(provider); },
        registerDocumentHighlightProvider: (_selector: unknown, provider: Monaco.languages.DocumentHighlightProvider) => { highlights = provider; return register(provider); },
        registerSelectionRangeProvider: (_selector: unknown, provider: unknown) => register(provider),
        registerReferenceProvider: (_selector: unknown, provider: Monaco.languages.ReferenceProvider) => { references = provider; return register(provider); },
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 }, CompletionItemKind: { Text: 18 }, InlayHintKind: { Parameter: 2, Type: 1 }, DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
    } } as unknown as typeof Monaco;
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as Monaco.CancellationToken;
    return { controller, requests, model, editor, monaco, token, registrations, previewModels, peekWork: () => peekWork, peekLocations: () => peekLocations, semanticColoring: () => semanticColoring, opener: () => opener!, completion: () => completion!, hints: () => hints!, semantic: () => semantic!, highlights: () => highlights!,
        edit() { text += 'x'; version++; for (const callback of edits) callback(); } };
}

describe('Monaco language intelligence adapter', () => {
    it('peeks every referenced file, reads each unique target once and opens it through the File owner', async () => {
        const f = fixture(); await f.controller.activate();
        const readText = vi.fn(async () => 'export const answer = 42;\nanswer;');
        const openLocation = vi.fn();
        const port = { ...f.controller, path: 'a.ts', referencePreview: { readText, openLocation } };
        const binding = bindMonacoLanguageIntelligence(f.monaco, f.editor, port);
        try {
            const run = binding.runCommand('peekReferences');
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            const range = { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } };
            f.requests[0].resolve({ status: 'ok', kind: 'references', hasMore: false, locations: [
                { serverId: 's', path: 'a.ts', range, lineText: 'answer' }, { serverId: 's', path: 'src/b.ts', range, lineText: 'export const answer = 42;' },
                { serverId: 's', path: 'src/b.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, lineText: 'answer;' },
            ] });
            await run; await f.peekWork();
            expect(f.peekLocations()).toEqual([
                { uri: f.model.uri, range: expect.any(Object) },
                { uri: expect.objectContaining({ path: '/src/b.ts' }), range: expect.any(Object) },
                { uri: expect.objectContaining({ path: '/src/b.ts' }), range: expect.any(Object) },
            ]);
            expect(f.editor.trigger).toHaveBeenCalledWith('happier.references', 'editor.action.referenceSearch.trigger', {});
            expect(readText).toHaveBeenCalledTimes(1); // Cost: N references to one file need one body, not N reads.
            expect(readText).toHaveBeenCalledWith('src/b.ts', expect.any(AbortSignal));
            expect(f.previewModels.map(model => model.text)).toEqual(['export const answer = 42;\nanswer;']);
            const selection = { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 7 };
            expect(await f.opener().openCodeEditor(f.editor, f.previewModels[0].uri, selection)).toBe(true);
            expect(openLocation).toHaveBeenCalledWith({ path: 'src/b.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } } });
        } finally { binding.dispose(); f.controller.dispose(); }
        expect(f.previewModels.every(model => model.dispose.mock.calls.length === 1)).toBe(true);
    });
    it('cancels a pending cross-file preview on edit without creating or showing stale models', async () => {
        const f = fixture(); await f.controller.activate();
        let finish!: (text: string) => void;
        const readText = vi.fn((_path: string, _signal: AbortSignal) => new Promise<string>(resolve => { finish = resolve; }));
        const binding = bindMonacoLanguageIntelligence(f.monaco, f.editor, { ...f.controller, path: 'a.ts', referencePreview: { readText, openLocation() {} } });
        try {
            const run = binding.runCommand('peekReferences');
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            f.requests[0].resolve({ status: 'ok', kind: 'references', hasMore: false, locations: [{ serverId: 's', path: 'b.ts', lineText: 'b',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] });
            await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes(1));
            f.edit(); expect(readText.mock.calls[0][1].aborted).toBe(true);
            finish('late text'); await run; await f.peekWork();
            expect(f.previewModels).toHaveLength(0);
            expect(f.peekLocations()).toBeNull();
        } finally { binding.dispose(); f.controller.dispose(); }
    });
    it('enables occurrences and translates LSP highlight kinds to engine kinds', async () => {
        const f = fixture(); await f.controller.activate();
        const binding = bindMonacoLanguageIntelligence(f.monaco, f.editor, f.controller);
        try {
            expect(f.editor.updateOptions).toHaveBeenCalledWith(expect.objectContaining({ occurrencesHighlight: 'singleFile' }));
            const pending = f.highlights().provideDocumentHighlights(f.model, enginePosition(1, 2), f.token);
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
            f.requests[0].resolve({ status: 'ok', kind: 'documentHighlight', highlights: [1, 2, 3].map(kind => ({ serverId: 's', range, kind: kind as 1 | 2 | 3 })) });
            expect((await pending)?.map(item => item.kind)).toEqual([0, 1, 2]);
        } finally { binding.dispose(); f.controller.dispose(); }
    });
    it('uses server triggers, resolves focused items as untrusted Markdown, and leaves snippet/auto-import edits in one engine suggestion', async () => {
        const f = fixture(); await f.controller.activate();
        const binding = bindMonacoLanguageIntelligence(f.monaco, f.editor, f.controller);
        try {
            expect(f.completion()?.triggerCharacters).toEqual(['.']);
            const pending = f.completion().provideCompletionItems(f.model, enginePosition(1, 4), { triggerKind: 0 }, f.token);
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            expect(f.requests[0].input).toMatchObject({ kind: 'completion', position: { line: 0, character: 3 }, completionContext: { triggerKind: 1 } });
            expect(f.requests[0].input).not.toHaveProperty('contents');
            f.requests[0].resolve({ status: 'ok', kind: 'completion', isIncomplete: false, items: [{ serverId: 's', itemId: '1', label: 'answer', insertText: 'answer(${1:value})', insertTextFormat: 2 }] });
            const list = await pending;
            expect(list?.suggestions).toHaveLength(1);
            const resolving = f.completion().resolveCompletionItem!(list!.suggestions[0], f.token);
            await vi.waitFor(() => expect(f.requests).toHaveLength(2));
            f.requests[1].resolve({ status: 'ok', kind: 'completionResolve', item: { serverId: 's', itemId: '1', label: 'answer', documentation: '<img src=x> [run](command:evil)',
                additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'import { answer } from "./answer";\n' }] } });
            const item = await resolving;
            expect(item).toMatchObject({ insertText: 'answer(${1:value})', insertTextRules: 4, documentation: { isTrusted: false, supportHtml: false },
                additionalTextEdits: [{ text: 'import { answer } from "./answer";\n' }] });
        } finally { binding.dispose(); f.controller.dispose(); }
    });

    it('cancels on an incompatible edit and never publishes a late result, then disposes model-scoped providers', async () => {
        const f = fixture(); await f.controller.activate();
        const binding = bindMonacoLanguageIntelligence(f.monaco, f.editor, f.controller);
        const pending = f.completion()?.provideCompletionItems(f.model, enginePosition(1, 4), { triggerKind: 0 }, f.token);
        await vi.waitFor(() => expect(f.requests).toHaveLength(1));
        f.edit(); expect(f.requests[0].signal.aborted).toBe(true);
        f.requests[0].resolve({ status: 'ok', kind: 'completion', items: [{ serverId: 's', itemId: '1', label: 'stale' }], isIncomplete: false });
        expect(await pending).toBeNull();
        binding.dispose(); expect(f.registrations.size).toBe(0); f.controller.dispose();
    });

    it.each([true, false])('asks for only the visible intersection for hints and semantic highlighting (native range: %s)', async (nativeRange) => {
        const f = fixture(nativeRange); await f.controller.activate();
        const binding = bindMonacoLanguageIntelligence(f.monaco, f.editor, f.controller);
        try {
            expect(f.semanticColoring()).toBe(true);
            const wide = { startLineNumber: 1, startColumn: 1, endLineNumber: 5000, endColumn: 80 } as Monaco.Range;
            const hints = f.hints()?.provideInlayHints(f.model, wide, f.token);
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            expect(f.requests[0].input.range).toEqual({ start: { line: 0, character: 0 }, end: { line: 2, character: 9 } });
            f.requests[0].resolve({ status: 'ok', kind: 'inlayHint', hints: [] }); await hints;
            const tokens = f.semantic()?.provideDocumentRangeSemanticTokens(f.model, wide, f.token);
            await vi.waitFor(() => expect(f.requests).toHaveLength(2));
            expect(f.requests[1].input.range).toEqual(f.requests[0].input.range);
            f.requests[1].resolve({ status: 'ok', kind: 'semanticTokens', tokens: [] }); await tokens;
        } finally { binding.dispose(); f.controller.dispose(); }
    });
});
