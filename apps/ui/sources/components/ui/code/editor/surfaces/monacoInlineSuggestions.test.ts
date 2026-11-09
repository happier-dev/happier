// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { createMonacoInlineSuggestions } from './monacoInlineSuggestions';

function fixture(initial = 'xTAIL') {
    let text = initial;
    let offset = 1;
    let version = 1;
    let focused = false;
    const node = document.createElement('div');
    const changed = new Set<(event: Monaco.editor.IModelContentChangedEvent) => void>();
    const selected = new Set<() => void>();
    let provider: Monaco.languages.InlineCompletionsProvider | undefined;
    const providers = new Set<Monaco.languages.InlineCompletionsProvider>();
    const disposable = { dispose() {} };
    // Monaco is the actual engine boundary. No intelligence/policy helper is mocked.
    const model = { uri: { scheme: 'inmemory', path: '/inline-test' }, getValue: () => text,
        getVersionId: () => version, getEOL: () => '\r\n', getLanguageId: () => 'plaintext',
        getLineMaxColumn: () => text.length + 1, getLineContent: () => text,
        getValueInRange: (range: Monaco.IRange) => text.slice(range.startColumn - 1, range.endColumn - 1),
        getOffsetAt: (position: Monaco.Position) => position.column - 1,
        getPositionAt: (position: number) => ({ lineNumber: 1, column: position + 1 }),
    } as unknown as Monaco.editor.ITextModel;
    const trigger = vi.fn();
    const engine = { focus: () => { focused = true; }, getPosition: () => ({ lineNumber: 1, column: offset + 1 }),
        createContextKey: () => ({ set() {}, reset() {} }), addAction: () => disposable,
        getSelections: () => [{ isEmpty: () => true }], getDomNode: () => node, trigger,
        onDidChangeModelContent: (callback: (event: Monaco.editor.IModelContentChangedEvent) => void) => {
            changed.add(callback); return { dispose: () => { changed.delete(callback); } };
        },
        onDidChangeCursorSelection: (callback: () => void) => { selected.add(callback); return { dispose: () => { selected.delete(callback); } }; },
        onDidCompositionStart: () => disposable, onDidCompositionEnd: () => disposable,
    } as unknown as Monaco.editor.IStandaloneCodeEditor;
    const monaco = { KeyCode: { Tab: 2, RightArrow: 17, Escape: 9, Backslash: 88 }, KeyMod: { CtrlCmd: 2048, WinCtrl: 256, Alt: 512 },
        languages: { registerInlineCompletionsProvider: (_selector: unknown, value: Monaco.languages.InlineCompletionsProvider) => {
        provider = value; providers.add(value); return { dispose: () => { providers.delete(value); } };
    } } } as unknown as typeof Monaco;
    const binding = createMonacoInlineSuggestions(monaco, engine, model, { readOnly: () => false });
    function query() {
        return provider!.provideInlineCompletions(model, engine.getPosition()!,
            { selectedSuggestionInfo: undefined } as Monaco.languages.InlineCompletionContext,
            { isCancellationRequested: false } as Monaco.CancellationToken);
    }
    return { model, node, binding, trigger, query, provider: () => provider!, activeProviders: () => providers.size, hasFocus: () => focused,
        editBeforeCursorUpdate(insert: string) {
            text = text.slice(0, offset) + insert + text.slice(offset); version++;
            const event = { changes: [{ rangeOffset: offset, rangeLength: 0, text: insert }] } as Monaco.editor.IModelContentChangedEvent;
            for (const listener of changed) listener(event);
            offset += insert.length;
            for (const listener of selected) listener();
        } };
}

describe('Monaco inline suggestion engine contract', () => {
    it('focuses an explicit request before inference and projects the result through the native provider', async () => {
        const f = fixture('x');
        const requestedWithFocus: boolean[] = [];
        const stopEvents = f.binding.handle.onEvent(event => {
            if (event.kind === 'trigger') requestedWithFocus.push(f.hasFocus());
        });
        try {
            f.binding.command('inlineSuggestTrigger');
            expect(requestedWithFocus).toEqual([true]);
            f.binding.handle.set({ id: 'one', text: 'return 42;', line: 1, character: 1 });
            const completion = await f.query();
            expect(completion?.items[0]).toMatchObject({ insertText: 'return 42;' });
            f.provider().handleItemDidShow!(completion!, completion!.items[0]!, 'return 42;', {} as Monaco.languages.EditDeltaInfo);
            expect(f.binding.handle.getSuggestion()?.text).toBe('return 42;');
        } finally { stopEvents(); f.binding.dispose(); }
    });
    it('preserves the existing line suffix in a multiline public-API completion range', async () => {
        const f = fixture();
        try {
            f.binding.handle.set({ id: 'multiline', text: 'one\r\ntwo', line: 1, character: 1 });
            const completion = await f.query();
            expect(completion?.items[0]).toMatchObject({ insertText: 'one\r\ntwoTAIL',
                range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 6 } });
        } finally { f.binding.dispose(); }
    });

    it('publishes matching typing only after the model and caret coordinates agree', async () => {
        const f = fixture('x');
        try {
            f.binding.handle.set({ id: 'typing', text: 'café', line: 1, character: 1 });
            const completion = await f.query();
            f.provider().handleItemDidShow!(completion!, completion!.items[0]!, 'café', {} as Monaco.languages.EditDeltaInfo);
            const facts: { offset: number; version: number }[] = [];
            f.binding.handle.subscribeContext(() => {
                const context = f.binding.handle.getContext();
                if (context) facts.push({ offset: context.offset, version: context.version });
            });
            f.editBeforeCursorUpdate('c');
            expect(facts.length).toBeGreaterThan(0);
            expect(facts.every(context => context.version !== 2 || context.offset === 2)).toBe(true);
            expect(f.binding.handle.getSuggestion()).toMatchObject({ id: 'typing', text: 'afé', character: 2 });
        } finally { f.binding.dispose(); }
    });

    it('retires a rendered ghost when the real suggestion widget becomes visible', async () => {
        const f = fixture('x');
        try {
            f.binding.handle.set({ id: 'list', text: 'tail', line: 1, character: 1 });
            const completion = await f.query();
            f.provider().handleItemDidShow!(completion!, completion!.items[0]!, 'tail', {} as Monaco.languages.EditDeltaInfo);
            expect(f.binding.handle.getSuggestion()).not.toBeNull();
            f.node.innerHTML = '<div class="suggest-widget visible"></div>';
            await Promise.resolve();
            expect(f.binding.handle.getSuggestion()).toBeNull();
            expect(f.binding.handle.getContext()?.suggestWidgetOpen).toBe(true);
        } finally { f.binding.dispose(); }
    });

    it('releases the projection provider when Monaco rejects the displayed item', async () => {
        const f = fixture('x');
        try {
            f.binding.handle.set({ id: 'rejected', text: 'tail', line: 1, character: 1 });
            const completion = await f.query();
            f.provider().handleItemDidShow!(completion!, completion!.items[0]!, 'tail', {} as Monaco.languages.EditDeltaInfo);
            expect(f.activeProviders()).toBe(1);
            f.provider().handleEndOfLifetime!(completion!, completion!.items[0]!, { kind: 1 }, {
                requestUuid: 'native-rejection', correlationId: undefined, partiallyAccepted: 0,
                partiallyAcceptedCountSinceOriginal: 0, partiallyAcceptedRatioSinceOriginal: 0,
                partiallyAcceptedCharactersSinceOriginal: 0, shown: true, shownDuration: 1, shownDurationUncollapsed: 1,
                timeUntilShown: 0, timeUntilActuallyShown: 0, timeUntilProviderRequest: 0, timeUntilProviderResponse: 0,
                notShownReason: undefined, editorType: 'test', viewKind: undefined, preceeded: false,
                languageId: 'plaintext', requestReason: 'explicit', typingInterval: 0, typingIntervalCharacterCount: 0,
                selectedSuggestionInfo: false, availableProviders: '',
                skuPlan: undefined, skuType: undefined, renameCreated: undefined, renameDuration: undefined,
                renameTimedOut: undefined, renameDroppedOtherEdits: undefined, renameDroppedRenameEdits: undefined,
                editKind: undefined,
            });
            expect(f.binding.handle.getSuggestion()).toBeNull();
            expect(f.activeProviders()).toBe(0);
        } finally { f.binding.dispose(); }
    });

    it('releases a consumed provider when the controller clears its projection', () => {
        const f = fixture('x');
        try {
            f.binding.handle.set({ id: 'consumed', text: 'tail', line: 1, character: 1 });
            f.editBeforeCursorUpdate('tail');
            f.binding.handle.set(null);
            expect(f.activeProviders()).toBe(0);
        } finally { f.binding.dispose(); }
    });
});
