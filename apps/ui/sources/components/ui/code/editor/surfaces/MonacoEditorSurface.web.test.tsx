/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const createModelSpy = vi.fn<(...args: unknown[]) => Record<string, unknown>>(() => ({
    getValue: (): string => '',
    setValue: () => {},
    dispose: () => {},
}));

const createEditorSpy = vi.fn<(...args: unknown[]) => Record<string, unknown>>(() => ({
    onDidChangeModelContent: () => ({ dispose: () => {} }),
    onDidBlurEditorText: () => ({ dispose: () => {} }),
    updateOptions: () => {},
    addAction: () => ({ dispose: () => {} }),
    createContextKey: () => ({ set() {}, reset() {} }),
    dispose: () => {},
}));
const defineThemeSpy = vi.fn();
const setThemeSpy = vi.fn();
const typescriptModeSpy = vi.fn();
const javascriptModeSpy = vi.fn();
const webLanguageModeSpies = { json: vi.fn(), css: vi.fn(), scss: vi.fn(), less: vi.fn(), html: vi.fn(), handlebar: vi.fn(), razor: vi.fn() };
const registerInlineCompletionsProviderSpy = vi.fn<(...args: unknown[]) => { dispose(): void }>(() => ({ dispose() {} }));

const darkEditorTheme = {
    dark: true,
    colors: {
        border: { default: '#303030' },
        text: { primary: '#f8f8f2', secondary: '#cfcfcf', tertiary: '#8a8a8a' },
        surface: { base: '#151515', inset: '#1f1f1f', elevated: '#101010', selected: '#2a2a2a' },
        accent: { blue: '#58a6ff' },
        diff: { added: { border: '#3fb950' } },
        syntax: {
            default: '#f8f8f2',
            keyword: '#ff79c6',
            string: '#50fa7b',
            comment: '#6272a4',
            number: '#bd93f9',
            function: '#8be9fd',
        },
    },
};

const lightEditorTheme = {
    dark: false,
    colors: {
        border: { default: '#d0d7de' },
        text: { primary: '#24292f', secondary: '#57606a', tertiary: '#6e7781' },
        surface: { base: '#ffffff', inset: '#f6f8fa', elevated: '#ffffff', selected: '#ddf4ff' },
        accent: { blue: '#0969da' },
        diff: { added: { border: '#1a7f37' } },
        syntax: {
            default: '#24292f',
            keyword: '#cf222e',
            string: '#0a3069',
            comment: '#6e7781',
            number: '#0550ae',
            function: '#8250df',
        },
    },
};

type EditorThemeFixture = typeof darkEditorTheme | typeof lightEditorTheme;

const unistylesState = vi.hoisted(() => ({
    currentTheme: null as unknown as EditorThemeFixture,
}));
const monacoDom = vi.hoisted(() => ({ listeners: new Map<string, EventListener>() }));

function assertCallable(value: unknown, label: string): (...args: unknown[]) => unknown {
    if (typeof value !== 'function') throw new Error(`expected ${label} to be callable`);
    return value as (...args: unknown[]) => unknown;
}

/** The installed Monaco 0.55.1 boundary always includes both language-service defaults. */
function createMonacoLanguageServicesBoundary() {
    const service = (setModeConfiguration: typeof typescriptModeSpy) => ({ modeConfiguration: { foldingRanges: true, colors: true }, setModeConfiguration });
    return { KeyCode: { Tab: 2, RightArrow: 17, Escape: 9, Backslash: 88 }, KeyMod: { CtrlCmd: 2048, WinCtrl: 256, Alt: 512 },
        json: { jsonDefaults: service(webLanguageModeSpies.json) },
        css: { cssDefaults: service(webLanguageModeSpies.css), scssDefaults: service(webLanguageModeSpies.scss), lessDefaults: service(webLanguageModeSpies.less) },
        html: { htmlDefaults: service(webLanguageModeSpies.html), handlebarDefaults: service(webLanguageModeSpies.handlebar), razorDefaults: service(webLanguageModeSpies.razor) },
        languages: { registerInlineCompletionsProvider: registerInlineCompletionsProviderSpy }, typescript: {
        typescriptDefaults: { setModeConfiguration: typescriptModeSpy },
        javascriptDefaults: { setModeConfiguration: javascriptModeSpy },
    } };
}

function setupMonacoGlobals() {
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).document = (globalThis as any).document ?? {};
    window.addEventListener ??= vi.fn();
    window.removeEventListener ??= vi.fn();

    (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
        if (typeof onOk === 'function') onOk();
    };
    (globalThis as any).window.monaco = {
        ...createMonacoLanguageServicesBoundary(),
        editor: {
            createModel: (...args: unknown[]) => {
                const model = createModelSpy(...args);
                const defaults = { uri: { scheme: 'inmemory', path: '/surface-test' }, getLanguageId: () => 'plaintext',
                    getVersionId: () => 1, getEOL: () => '\n', getOffsetAt: (position: { column: number }) => position.column - 1 };
                for (const [key, value] of Object.entries(defaults)) if (!(key in model)) model[key] = value;
                return model;
            },
            create: (...args: unknown[]) => {
                const editor = createEditorSpy(...args);
                // Monaco always supplies this public API, including fixtures that customize unrelated engine methods.
                if (!('createDecorationsCollection' in editor)) editor.createDecorationsCollection = () => ({ set() {}, clear() {} });
                if (!('createContextKey' in editor)) editor.createContextKey = () => ({ set() {}, reset() {} });
                const getDomNode = editor.getDomNode;
                const original = typeof getDomNode === 'function' ? getDomNode() : null;
                // The public engine returns an HTMLElement. Preserve measurement/style boundary fixtures on one.
                if (original && !(original instanceof HTMLElement)) {
                    const node = document.createElement('div');
                    for (const key of ['style', 'getBoundingClientRect']) if (key in original) {
                        Object.defineProperty(node, key, { configurable: true, value: original[key] });
                    }
                    editor.getDomNode = () => node;
                }
                return editor;
            },
            defineTheme: defineThemeSpy,
            setTheme: setThemeSpy,
        },
    };
}

beforeEach(() => {
    createModelSpy.mockClear();
    createEditorSpy.mockClear();
    defineThemeSpy.mockClear();
    setThemeSpy.mockClear();
    typescriptModeSpy.mockClear();
    javascriptModeSpy.mockClear();
    for (const spy of Object.values(webLanguageModeSpies)) spy.mockClear();
    registerInlineCompletionsProviderSpy.mockClear();
    monacoDom.listeners.clear();
    unistylesState.currentTheme = darkEditorTheme;
});

vi.mock('react-native', async () => {
    const React = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const View = React.forwardRef((props: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({
            addEventListener: (type: string, listener: EventListener) => monacoDom.listeners.set(type, listener),
            removeEventListener: (type: string) => monacoDom.listeners.delete(type),
        }), []);
        return React.createElement('View', props, props.children);
    });
    return createReactNativeWebMock({
        View,
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const base = await createUnistylesMock();
    const baseRuntime = base.useUnistyles().rt;
    const baseTheme = base.useUnistyles().theme;
    return {
        ...base,
        useUnistyles: () => ({ theme: { ...baseTheme, ...unistylesState.currentTheme,
            colors: { ...baseTheme.colors, ...unistylesState.currentTheme.colors,
                diff: { ...baseTheme.colors.diff, ...unistylesState.currentTheme.colors.diff } } }, rt: baseRuntime }),
    };
});

import { MonacoEditorSurface } from './MonacoEditorSurface.web';
import type { CodeEditorHandle } from '../codeEditorTypes';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { createEditorDocumentHistory } from '../editorDocumentHistory';
import { createCodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import { bindCodeIntelligenceEditor } from '@/sync/domains/workspaces/languageIntelligence/bindCodeIntelligenceEditor';
import { FilesEditorAiSuggestionsV1Schema } from '@happier-dev/protocol/account/settings/accountSettings';
import type { LanguageIntelligenceQueryResult } from '@happier-dev/protocol/machines/languageIntelligence';
import { dispatchEscapeToLayerStack, ESCAPE_LAYER_PRIORITIES, EscapeLayerProvider, registerEscapeLayer } from '@/keyboard/escape';


describe('MonacoEditorSurface (web)', () => {
    it.each(['pending', 'preview'] as const)('dismisses next-edit %s through the real Escape layer without taking IME or list Escape', async phase => {
        vi.useFakeTimers();
        setupMonacoGlobals();
        const node = document.createElement('div');
        const input = document.createElement('textarea');
        node.append(input);
        let text = 'old(); old();', version = 1, column = 4;
        const changed = new Set<(event: { changes: Array<{ rangeOffset: number; rangeLength: number; text: string }> }) => void>();
        const selected = new Set<() => void>();
        const model = { getValue: () => text, getVersionId: () => version, getEOL: () => '\n',
            getLineCount: () => 1, getLineContent: () => text, getLineMaxColumn: () => text.length + 1,
            getOffsetAt: (position: { column: number }) => position.column - 1,
            getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }), dispose() {} };
        createModelSpy.mockReturnValueOnce(model);
        createEditorSpy.mockReturnValueOnce({ ...createEditorSpy.getMockImplementation()!(), trigger: vi.fn(),
            getDomNode: () => node, getModel: () => model, getPosition: () => ({ lineNumber: 1, column }),
            getSelections: () => [{ isEmpty: () => true }], focus() {},
            setPosition: (position: { column: number }) => { column = position.column; for (const listener of selected) listener(); },
            createDecorationsCollection: () => ({ set() {}, clear() {} }),
            onDidChangeModelContent: (listener: Parameters<typeof changed.add>[0]) => { changed.add(listener); return { dispose: () => changed.delete(listener) }; },
            onDidChangeCursorSelection: (listener: () => void) => { selected.add(listener); return { dispose: () => selected.delete(listener) }; },
        });
        const ref = React.createRef<CodeEditorHandle>();
        const screen = await renderScreen(<MonacoEditorSurface ref={ref} resetKey="next-edit-escape" value={text} language={null} onChange={() => {}} />);
        const settings = FilesEditorAiSuggestionsV1Schema.parse({ enabled: true, nextEditEnabled: true,
            mode: 'onRequest', connectionId: 'source', modelId: 'edit-model' });
        const descriptor = { id: 'edit-model', name: 'Edit model', contextWindowTokens: 32768,
            nextEdit: { operationId: 'edit', tokenAccounting: 'utf8-bytes' as const, outputTokens: 4096, promptOverheadTokens: 32 } };
        const requests: { signal: AbortSignal; resolve(value: LanguageIntelligenceQueryResult): void }[] = [];
        const controller = createCodeIntelligenceController({ scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
            path: 'a.ts', languageId: 'typescript', getText: () => text,
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            query: async () => ({ status: 'unavailable', reason: 'no_capable_server' }), openLocation() {},
            inlineSuggestions: { getSettings: () => settings, getModel: () => descriptor,
                query: (_input, signal) => new Promise(resolve => requests.push({ signal, resolve })) },
        });
        let unbind = () => {};
        const answer = async (index: number) => {
            await act(async () => {
                requests[index]!.resolve({ status: 'ok', kind: 'ai.nextEdit', version,
                    edits: [{ path: 'a.ts', range: { start: { line: 0, character: 11 }, end: { line: 0, character: 14 } }, oldText: 'old', newText: 'renamed' }] });
                await vi.runAllTimersAsync();
            });
        };
        const escape = async (isComposing = false) => {
            const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, isComposing });
            Object.defineProperty(event, 'target', { value: input });
            let handled = false;
            await act(async () => { handled = dispatchEscapeToLayerStack(event); });
            if (ref.current!.inlineSuggestions!.getContext()?.suggestWidgetOpen) expect(event.defaultPrevented).toBe(false);
            return handled;
        };
        try {
            await act(async () => {
                unbind = bindCodeIntelligenceEditor(controller, ref.current!, { path: 'a.ts', inlayHints: 'off', semanticHighlighting: false });
                text = 'renamed(); old();'; version++; column = 8;
                for (const listener of changed) listener({ changes: [{ rangeOffset: 0, rangeLength: 3, text: 'renamed' }] });
                controller.nextEditSuggestions.trigger();
                await vi.runAllTimersAsync();
            });
            expect(requests).toHaveLength(1);
            if (phase === 'preview') {
                await answer(0);
                await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })); });
                expect(controller.nextEditSuggestions.getSnapshot().status).toBe('preview');
            } else expect(controller.nextEditSuggestions.getSnapshot().status).toBe('requesting');
            expect(await escape(true)).toBe(false);
            if (phase === 'pending') expect(requests[0]!.signal.aborted).toBe(false);
            expect(await escape()).toBe(true);
            if (phase === 'pending') { expect(requests[0]!.signal.aborted).toBe(true); await answer(0); }
            expect(controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
            expect(text).toBe('renamed(); old();');

            await act(async () => { controller.nextEditSuggestions.trigger(); await vi.runAllTimersAsync(); });
            const list = document.createElement('div'); list.className = 'suggest-widget visible';
            await act(async () => { node.append(list); await flushHookEffects(); });
            expect(ref.current!.inlineSuggestions!.getContext()?.suggestWidgetOpen).toBe(true);
            expect(await escape()).toBe(true);
            await answer(1);
            expect(controller.nextEditSuggestions.getSnapshot().suggestion).toBeNull();
        } finally { unbind(); controller.dispose(); await screen.unmount(); vi.useRealTimers(); }
    });
    it('dismisses a visible inline suggestion before its containing modal on Escape', async () => {
        setupMonacoGlobals();
        const node = document.createElement('div');
        const input = document.createElement('textarea');
        node.append(input);
        const parent = { parent: null };
        const closeModal = vi.fn();
        const unregister = registerEscapeLayer({ priority: ESCAPE_LAYER_PRIORITIES.modal, allowEditableTarget: true,
            scope: parent, onEscape: closeModal });
        const model = { getValue: () => 'x', getLineCount: () => 1, dispose() {} };
        createModelSpy.mockReturnValueOnce(model);
        createEditorSpy.mockReturnValueOnce({ ...createEditorSpy.getMockImplementation()!(), trigger: vi.fn(), getDomNode: () => node,
            getPosition: () => ({ lineNumber: 1, column: 2 }), getSelections: () => [{ isEmpty: () => true }] });
        const ref = React.createRef<CodeEditorHandle>();
        const screen = await renderScreen(<EscapeLayerProvider layer={parent}>
            <MonacoEditorSurface ref={ref} resetKey="inline-escape" value="x" language={null} onChange={() => {}} />
        </EscapeLayerProvider>);
        try {
            ref.current!.inlineSuggestions!.set({ id: 'escape', text: ' café', line: 1, character: 1 });
            const provider = registerInlineCompletionsProviderSpy.mock.calls.at(-1)![1] as import('monaco-editor').languages.InlineCompletionsProvider;
            const completions = await provider.provideInlineCompletions(model as unknown as import('monaco-editor').editor.ITextModel,
                { lineNumber: 1, column: 2 } as import('monaco-editor').Position,
                {} as import('monaco-editor').languages.InlineCompletionContext,
                { isCancellationRequested: false } as import('monaco-editor').CancellationToken);
            provider.handleItemDidShow!(completions!, completions!.items[0]!, ' café', {} as import('monaco-editor').languages.EditDeltaInfo);
            const escape = () => {
                const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
                Object.defineProperty(event, 'target', { value: input });
                return dispatchEscapeToLayerStack(event);
            };
            expect(escape()).toBe(true);
            expect(ref.current!.inlineSuggestions!.getSuggestion()).toBeNull();
            expect(ref.current!.getValue()).toBe('x');
            expect(closeModal).not.toHaveBeenCalled();
            expect(escape()).toBe(true);
            expect(closeModal).toHaveBeenCalledOnce();
        } finally { unregister(); await screen.unmount(); }
    });
    it('publishes the live inline handle before notifying readiness on boot, reset and remount', async () => {
        setupMonacoGlobals();
        const ref = React.createRef<CodeEditorHandle>();
        const observations: Array<{ inline: CodeEditorHandle['inlineSuggestions']; context: ReturnType<NonNullable<CodeEditorHandle['inlineSuggestions']>['getContext']> | undefined }> = [];
        const onReady = vi.fn(() => {
            const inline = ref.current?.inlineSuggestions;
            observations.push({ inline, context: inline?.getContext() });
        });
        const prepareEditor = (column: number) => {
            createModelSpy.mockReturnValueOnce({ getValue: () => 'text', getLineCount: () => 1, dispose() {} });
            createEditorSpy.mockReturnValueOnce({ ...createEditorSpy.getMockImplementation()!(),
                getPosition: () => ({ lineNumber: 1, column }), getSelections: () => [{ isEmpty: () => true }] });
        };
        prepareEditor(2);
        const screen = await renderScreen(<MonacoEditorSurface key="first" ref={ref} resetKey="one" value="text" language={null} onChange={() => {}} onReady={onReady} />);
        try {
            expect(onReady).toHaveBeenCalledTimes(1);
            expect(observations[0]?.inline).toBeDefined();
            expect(observations[0]?.context).toMatchObject({ line: 1, character: 1, offset: 1 });
            prepareEditor(3);
            await screen.update(<MonacoEditorSurface key="first" ref={ref} resetKey="two" value="text" language={null} onChange={() => {}} onReady={onReady} />);
            expect(onReady).toHaveBeenCalledTimes(2);
            expect(observations[1]?.inline).toBeDefined();
            expect(observations[1]?.inline).not.toBe(observations[0]?.inline);
            expect(observations[1]?.context).toMatchObject({ line: 1, character: 2, offset: 2 });
            prepareEditor(4);
            await screen.update(<MonacoEditorSurface key="second" ref={ref} resetKey="three" value="text" language={null} onChange={() => {}} onReady={onReady} />);
            expect(onReady).toHaveBeenCalledTimes(3);
            expect(observations[2]?.inline).toBeDefined();
            expect(observations[2]?.inline).not.toBe(observations[1]?.inline);
            expect(observations[2]?.context).toMatchObject({ line: 1, character: 3, offset: 3 });
        } finally { await screen.unmount(); }
    });
    it.each(['replacement', 'format'] as const)('keeps an explicit %s in one undo step separate from pending typing', async (command) => {
        setupMonacoGlobals();
        const history = createEditorDocumentHistory();
        let value = 'a', owner = 'a';
        const listeners = new Set<(event: Record<string, unknown>) => void>();
        const changed = () => { for (const listener of listeners) listener({}); };
        const model = { getValue: () => value, getLineCount: () => 1, getEOL: () => '\n',
            getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }), dispose: () => {} };
        createModelSpy.mockReturnValueOnce(model);
        createEditorSpy.mockReturnValueOnce({ ...createEditorSpy.getMockImplementation()!(), pushUndoStop: () => {},
            getModel: () => model,
            getAction: () => ({ run: async () => { value = 'formatted'; changed(); } }),
            onDidChangeModelContent: (listener: (event: Record<string, unknown>) => void) => {
                listeners.add(listener); return { dispose: () => { listeners.delete(listener); } };
            },
            executeEdits: (_source: string, edits: Array<{ range: { startColumn: number; endColumn: number }; text: string }>) => {
                for (const edit of edits) value = value.slice(0, edit.range.startColumn - 1) + edit.text + value.slice(edit.range.endColumn - 1);
                changed();
            } });
        const ref = React.createRef<CodeEditorHandle>();
        const screen = await renderScreen(<MonacoEditorSurface ref={ref} resetKey="command-boundaries" value={value} language={null}
            history={history} onChange={(next, change) => { if (!change?.history) history.record(owner, next); owner = next; }} />);
        const controller = createCodeIntelligenceController({ scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
            path: 'a.ts', languageId: 'typescript', getText: () => owner,
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            query: async () => ({ status: 'unavailable', reason: 'no_capable_server' }), openLocation() {} });
        try {
            if (command === 'format') ref.current!.setLanguageIntelligence!({ ...controller, path: 'a.ts', inlayHints: 'off', semanticHighlighting: false });
            const availability = vi.fn();
            const unsubscribe = ref.current!.subscribeHistory(availability);
            availability.mockClear();
            await act(async () => {
                value = 'ab'; changed();
                if (command === 'format') await ref.current!.formatDocument!();
                else ref.current!.runCommand({ replaceDocument: 'formatted' });
            });
            if (command === 'replacement') expect(availability).toHaveBeenCalledTimes(1);
            unsubscribe();
            await act(async () => {
                ref.current!.runCommand('undo');
            });
            expect(ref.current!.getValue()).toBe('ab');
            await act(async () => { ref.current!.runCommand('undo'); });
            expect(ref.current!.getValue()).toBe('a');
        } finally { controller.dispose(); await screen.unmount(); }
    });

    it('projects guarded inline completions without augmenting the server list or taking its Tab', async () => {
        setupMonacoGlobals();
        const model = { getValue: () => 'x', getLanguageId: () => 'plaintext', getVersionId: () => 1, getEOL: () => '\n',
            getOffsetAt: () => 1, getLineCount: () => 1, dispose() {} };
        const selection = { isEmpty: () => true };
        const trigger = vi.fn();
        createModelSpy.mockReturnValueOnce(model);
        createEditorSpy.mockReturnValueOnce({ ...createEditorSpy.getMockImplementation()!(), trigger,
            getPosition: () => ({ lineNumber: 1, column: 2 }), getSelections: () => [selection], getSelection: () => selection });
        const ref = React.createRef<CodeEditorHandle>();
        const screen = await renderScreen(<MonacoEditorSurface ref={ref} resetKey="inline" value="x" language={null} onChange={() => {}} />);
        try {
            ref.current!.inlineSuggestions!.set({ id: 'one', text: ' café', line: 1, character: 1 });
            const provider = registerInlineCompletionsProviderSpy.mock.calls.at(-1)![1] as import('monaco-editor').languages.InlineCompletionsProvider;
            const position = { lineNumber: 1, column: 2 } as import('monaco-editor').Position;
            const context = { selectedSuggestionInfo: undefined } as import('monaco-editor').languages.InlineCompletionContext;
            const token = { isCancellationRequested: false } as import('monaco-editor').CancellationToken;
            const result = await provider.provideInlineCompletions(model as unknown as import('monaco-editor').editor.ITextModel, position, context, token);
            expect(result).toMatchObject({ suppressSuggestions: false, items: [{ insertText: ' café' }] });
            provider.handleItemDidShow!(result!, result!.items[0]!, ' café', {} as import('monaco-editor').languages.EditDeltaInfo);
            trigger.mockClear();
            ref.current!.runCommand('inlineSuggestAccept');
            expect(trigger).not.toHaveBeenCalledWith(expect.anything(), 'editor.action.inlineSuggest.commit', expect.anything());
            ref.current!.inlineSuggestions!.setAcceptGuard(() => true);
            ref.current!.runCommand('inlineSuggestAccept');
            expect(trigger).toHaveBeenCalledWith(expect.anything(), 'editor.action.inlineSuggest.commit', null);
            const augmented = await provider.provideInlineCompletions(model as unknown as import('monaco-editor').editor.ITextModel, position,
                { ...context, selectedSuggestionInfo: {} } as import('monaco-editor').languages.InlineCompletionContext, token);
            expect(augmented).toBeNull();
        } finally { await screen.unmount(); }
    });
    it('uses retained history for engine actions, keyboard and system Undo after remount', async () => {
        setupMonacoGlobals();
        const history = createEditorDocumentHistory();
        history.record('a', 'ab'); history.record('ab', 'abc');
        let value = 'abc';
        let changed: (event: Record<string, unknown>) => void = () => {};
        const trigger = vi.fn();
        const actions = new Map<string, () => unknown>();
        createModelSpy.mockReturnValueOnce({ getValue: () => value, getLineCount: () => 1, getEOL: () => '\n',
            getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
            canUndo: () => false, canRedo: () => false, dispose: () => {} });
        createEditorSpy.mockReturnValueOnce({ ...createEditorSpy.getMockImplementation()!(), trigger, pushUndoStop: () => {},
            addAction: (action: { id: string; run(): unknown }) => {
                actions.set(action.id, action.run); return { dispose: () => { actions.delete(action.id); } };
            },
            onDidChangeModelContent: (listener: typeof changed) => { changed = listener; return { dispose: () => {} }; },
            executeEdits: (_source: string, edits: Array<{ range: { startColumn: number; endColumn: number }; text: string }>) => {
                for (const edit of edits) value = value.slice(0, edit.range.startColumn - 1) + edit.text + value.slice(edit.range.endColumn - 1);
                changed({});
            } });
        const ref = React.createRef<CodeEditorHandle>();
        const onChange = vi.fn();
        const screen = await renderScreen(<MonacoEditorSurface ref={ref} resetKey="remounted" value={value} language={null}
            history={history} onChange={onChange} />);
        try {
            const states: Array<{ canUndo: boolean; canRedo: boolean }> = [];
            ref.current!.subscribeHistory((state) => states.push(state));
            expect(states.at(-1)).toEqual({ canUndo: true, canRedo: false });
            await act(async () => { await actions.get('undo')?.(); });
            expect(ref.current!.getValue()).toBe('ab');
            expect(onChange).toHaveBeenLastCalledWith('ab', { history: 'undo' });
            const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true });
            await act(async () => { monacoDom.listeners.get('keydown')?.(event); });
            expect(event.defaultPrevented).toBe(true);
            expect(ref.current!.getValue()).toBe('a');
            const systemRedo = new InputEvent('beforeinput', { inputType: 'historyRedo', cancelable: true });
            await act(async () => { monacoDom.listeners.get('beforeinput')?.(systemRedo); });
            expect(systemRedo.defaultPrevented).toBe(true);
            expect(ref.current!.getValue()).toBe('ab');
            await act(async () => { await actions.get('redo')?.(); });
            expect(ref.current!.getValue()).toBe('abc');
            expect(trigger).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

    it('makes a failed engine load editable and retries from the newest fallback draft', async () => {
        setupMonacoGlobals();
        const onReady = vi.fn();
        const onChange = vi.fn();
        const ref = React.createRef<CodeEditorHandle>();
        const loadedMonaco = window.monaco;
        window.monaco = undefined;
        window.require = Object.assign((_deps: unknown, _ok: unknown, fail: (error: Error) => void) => {
            fail(new Error('engine chunk unavailable'));
        }, { config: () => {} }) as typeof window.require;
        const screen = await renderScreen(<MonacoEditorSurface ref={ref} value="original" resetKey="first" language={null}
            onChange={onChange} onReady={onReady} />);
        try {
            await flushHookEffects();
            // Ready means a usable text surface, including the plain fallback after a chunk failure.
            expect(onReady).toHaveBeenCalledOnce();
            const { TextInput } = await import('@/components/ui/text/Text');
            const fallback = screen.findByType(TextInput);
            expect(fallback.props.editable).toBe(true);
            await act(async () => { fallback.props.onChangeText('unsaved fallback draft'); });
            expect(ref.current?.getValue()).toBe('unsaved fallback draft');
            expect(onChange).toHaveBeenLastCalledWith('unsaved fallback draft');
            // Retrying the external engine must use the current draft rather than the initial seed.
            window.monaco = loadedMonaco;
            createModelSpy.mockImplementationOnce((value) => ({ getValue: () => value, getLineCount: () => 1, dispose: () => {} }));
            await act(async () => { screen.update(<MonacoEditorSurface ref={ref} value="unsaved fallback draft" resetKey="retry" language={null}
                onChange={onChange} onReady={onReady} />); });
            await flushHookEffects();
            expect(createModelSpy).toHaveBeenLastCalledWith('unsaved fallback draft', 'plaintext');
            expect(ref.current?.getValue()).toBe('unsaved fallback draft');
        } finally { await screen.unmount(); setupMonacoGlobals(); }
    });

    it('aligns its measured five-digit gutter with the shared code-view and review inset', async () => {
        setupMonacoGlobals();
        // Monaco sizes its number box in whole digits of the 13 px code font (7.8 px each here); the code view
        // draws 11 px numbers. The box is widened to cover the code view's number column and the slack padded.
        const digitWidth = 7.8;
        let minChars = 5;
        const updateOptions = vi.fn((options: { lineNumbersMinChars?: number }) => {
            if (options.lineNumbersMinChars !== undefined) minChars = options.lineNumbersMinChars;
        });
        const model = { ...createModelSpy.getMockImplementation()!(), getLineCount: () => 1 };
        const style = new Map<string, string>();
        // Monaco's public option boundary: font metrics and the current number-box width in digits.
        (globalThis as any).window.monaco.editor.EditorOption = { fontInfo: 'fontInfo', lineNumbersMinChars: 'lineNumbersMinChars' };
        const editorBoundary = { ...createEditorSpy.getMockImplementation()!(), updateOptions,
            getLayoutInfo: () => ({ lineNumbersWidth: Math.round(minChars * digitWidth), contentLeft: 69 }),
            getOption: (id: string) => id === 'fontInfo' ? { maxDigitWidth: digitWidth } : minChars,
            getDomNode: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }),
                style: { setProperty: (name: string, value: string) => { style.set(name, value); } } }),
        };
        createModelSpy.mockReturnValueOnce(model);
        createEditorSpy.mockReturnValueOnce(editorBoundary);
        await renderScreen(<MonacoEditorSurface resetKey="gutter" value="one" language="text" onChange={vi.fn()} lineNumberDigits={5} reviewLaneWidth={32}
            contentPaddingHorizontal={16} />);
        expect(createEditorSpy.mock.calls[0]?.[1]).toMatchObject({ lineNumbersMinChars: 5, glyphMargin: false });
        // Code view: inset 16 + row 8 + review lane 32 + 4 + five 11 px digits (33) = digits end at 93, text at 111.
        expect(updateOptions).toHaveBeenCalledWith({ lineNumbersMinChars: 12 });
        expect(updateOptions).toHaveBeenLastCalledWith({ lineDecorationsWidth: 111 - Math.round(12 * digitWidth) });
        expect(style.get('--happier-line-number-slack')).toBe(`${Math.round(12 * digitWidth) - 93}px`);
    });
    it('captures Monaco goto chords and dispatches the app commands before built-in handlers', async () => {
        setupMonacoGlobals();
        const definition = vi.fn();
        const references = vi.fn();
        const peek = vi.fn(); const typeDefinition = vi.fn(); const implementation = vi.fn();
        await renderScreen(<KeyboardShortcutProvider handlers={{ 'code.goToDefinition': definition, 'code.findReferences': references,
            'code.peekReferences': peek, 'code.goToTypeDefinition': typeDefinition, 'code.goToImplementation': implementation }}>
            <MonacoEditorSurface resetKey="intelligence-keys" value="const value = 1" language="typescript" onChange={vi.fn()} />
        </KeyboardShortcutProvider>);
        const capture = monacoDom.listeners.get('keydown');
        expect(capture).toEqual(expect.any(Function));
        for (const modifiers of [{}, { altKey: true }, { shiftKey: true }, { ctrlKey: true }, { ctrlKey: true, shiftKey: true }]) {
            const event = { key: 'F12', ...modifiers, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), isComposing: false };
            capture!(event as unknown as Event);
            expect(event.preventDefault).toHaveBeenCalledOnce();
            expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
        }
        expect(definition).toHaveBeenCalledOnce();
        expect(references).toHaveBeenCalledOnce();
        expect(peek).toHaveBeenCalledOnce(); expect(typeDefinition).toHaveBeenCalledOnce(); expect(implementation).toHaveBeenCalledOnce();
    });
    it('reads the live selection, rounds its anchor range and releases selection subscriptions', async () => {
        setupMonacoGlobals();
        let selection = { startLineNumber: 1, startColumn: 3, endLineNumber: 3, endColumn: 1 };
        let changed: (() => void) | undefined;
        const caretAnchor = vi.fn(() => ({ left: 20, top: 40, height: 18 }));
        const text = 'first\nsecond\nthird';
        const model = {
            ...createModelSpy.getMockImplementation()!(),
            getValue: () => text,
            getLineContent: (line: number) => text.split('\n')[line - 1],
            getValueInRange: () => 'rst\nsecond\n',
            getOffsetAt: ({ lineNumber, column }: { lineNumber: number; column: number }) => [0, 6, 13][lineNumber - 1] + column - 1,
        };
        createModelSpy.mockReturnValueOnce(model);
        createEditorSpy.mockReturnValueOnce({
            ...createEditorSpy.getMockImplementation()!(),
            getSelection: () => selection,
            getScrolledVisiblePosition: caretAnchor,
            getDomNode: () => ({ getBoundingClientRect: () => ({ left: 100, top: 200 }) }),
            onDidChangeCursorSelection: (listener: () => void) => { changed = listener; return { dispose: vi.fn() }; },
        });
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(<MonacoEditorSurface ref={ref} resetKey="selection" value={text} language="text" onChange={vi.fn()} />);
        expect(ref.current?.getSelection?.()).toEqual({ startLine: 1, endLine: 2, text: 'rst\nsecond\n', range: { start: 2, end: 13 }, collapsed: false, rect: { x: 120, y: 240, width: 0, height: 18 } });
        const listener = vi.fn();
        const unsubscribe = ref.current!.subscribeSelection!(listener);
        selection = { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 };
        changed!();
        expect(listener).toHaveBeenCalledTimes(1);
        // A caret with no range shows no toolbar, so reading it must not force Monaco to lay the view out (every keystroke reads it).
        caretAnchor.mockClear();
        expect(ref.current!.getSelection!()).toMatchObject({ startLine: 2, endLine: 2, text: 'second', range: { start: 8, end: 8 }, collapsed: true, rect: null });
        expect(caretAnchor).not.toHaveBeenCalled();
        unsubscribe();
        listener.mockClear();
        changed!();
        expect(listener).not.toHaveBeenCalled();
    });
    it('disables every built-in TS and JS service before creating a model and delegates hover to the host', async () => {
        setupMonacoGlobals();
        await renderScreen(<MonacoEditorSurface resetKey="intelligence-order" value="const answer = 42" language="typescript" onChange={vi.fn()} />);
        const off = {
            completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false,
            documentHighlights: false, rename: false, diagnostics: false, documentRangeFormattingEdits: false,
            signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false,
        };
        expect(typescriptModeSpy).toHaveBeenCalledWith(off);
        expect(javascriptModeSpy).toHaveBeenCalledWith(off);
        expect(typescriptModeSpy.mock.invocationCallOrder[0]).toBeLessThan(createModelSpy.mock.invocationCallOrder[0]);
        expect(javascriptModeSpy.mock.invocationCallOrder[0]).toBeLessThan(createModelSpy.mock.invocationCallOrder[0]);
        expect(createModelSpy.mock.calls[0]).toEqual(['const answer = 42', 'typescript']);
        expect(createEditorSpy.mock.calls[0]?.[1]).toMatchObject({ hover: { enabled: false } });
    });
    it('does not let bundled web language services compete with Machine intelligence', async () => {
        setupMonacoGlobals();
        await renderScreen(<MonacoEditorSurface resetKey="web-intelligence-owner" value="{}" language="json" onChange={vi.fn()} />);
        for (const spy of Object.values(webLanguageModeSpies)) {
            expect(spy).toHaveBeenCalledWith(expect.objectContaining({ completionItems: false, hovers: false, documentSymbols: false,
                diagnostics: false, documentHighlights: false, rename: false, documentFormattingEdits: false, documentRangeFormattingEdits: false, selectionRanges: false,
                foldingRanges: true, colors: true }));
            expect(spy.mock.invocationCallOrder[0]).toBeLessThan(createModelSpy.mock.invocationCallOrder[0]);
        }
    });
    it('publishes pointer and activation UTF-16 positions and releases subscribers', async () => {
        setupMonacoGlobals();
        let mouseMove: ((event: unknown) => void) | undefined;
        let mouseLeave: (() => void) | undefined;
        createEditorSpy.mockReturnValueOnce({
            ...createEditorSpy.getMockImplementation()!(),
            getPosition: () => ({ lineNumber: 2, column: 4 }),
            getTargetAtClientPoint: () => ({ position: { lineNumber: 2, column: 4 } }),
            getScrolledVisiblePosition: () => ({ left: 20, top: 30, height: 22 }),
            getDomNode: () => ({ getBoundingClientRect: () => ({ left: 100, top: 200 }) }),
            onMouseMove: (cb: (event: unknown) => void) => { mouseMove = cb; return { dispose: vi.fn() }; },
            onMouseLeave: (cb: () => void) => { mouseLeave = cb; return { dispose: vi.fn() }; },
        });
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(<MonacoEditorSurface ref={ref} resetKey="intelligence-events" value="one\n😀 symbol" language="text" onChange={vi.fn()} />);
        const pointer = vi.fn();
        const activate = vi.fn();
        const stopPointer = ref.current!.onPointerPosition!(pointer);
        const stopActivate = ref.current!.onActivatePosition!(activate);
        expect(ref.current!.getCursorPosition!()).toEqual({ line: 2, character: 3 });
        mouseMove!({ target: { position: { lineNumber: 2, column: 4 } } });
        expect(pointer).toHaveBeenLastCalledWith({ line: 2, character: 3, rect: { x: 120, y: 230, width: 0, height: 22 } });
        const preventDefault = vi.fn();
        const stopImmediatePropagation = vi.fn();
        const mouseDown = monacoDom.listeners.get('mousedown')!;
        mouseDown({ clientX: 120, clientY: 230, metaKey: true, preventDefault, stopImmediatePropagation } as unknown as Event);
        expect(preventDefault).toHaveBeenCalled();
        expect(stopImmediatePropagation).toHaveBeenCalled();
        expect(activate).toHaveBeenLastCalledWith({ line: 2, character: 3 });
        mouseLeave!();
        expect(pointer).toHaveBeenLastCalledWith(null);
        stopPointer(); stopActivate();
        pointer.mockClear(); activate.mockClear();
        mouseMove!({ target: { position: { lineNumber: 2, column: 4 } } });
        mouseDown({ clientX: 120, clientY: 230, ctrlKey: true, preventDefault, stopImmediatePropagation } as unknown as Event);
        expect(pointer).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
    });
    it('reveals a line, performs a minimal undoable replacement and ignores accessory commands during composition', async () => {
        setupMonacoGlobals();
        const text = 'first\nsecond\nlast';
        let compositionStart: (() => void) | undefined;
        let compositionEnd: (() => void) | undefined;
        const executeEdits = vi.fn();
        const trigger = vi.fn();
        const setPosition = vi.fn();
        const setSelection = vi.fn();
        const revealLineInCenter = vi.fn();
        const setScrollTop = vi.fn();
        const focus = vi.fn();
        const model = {
            getValue: () => text, setValue: vi.fn(), dispose: vi.fn(),
            getEOL: () => '\n',
            getLineCount: () => 3, getLineMaxColumn: () => 7,
            getPositionAt: (offset: number) => ({ lineNumber: offset < 6 ? 1 : offset < 13 ? 2 : 3, column: offset < 6 ? offset + 1 : offset < 13 ? offset - 5 : offset - 12 }),
            canUndo: () => false, canRedo: () => false,
        };
        createModelSpy.mockReturnValueOnce(model);
        createEditorSpy.mockReturnValueOnce({
            ...createEditorSpy.getMockImplementation()!(), executeEdits, trigger, setPosition, setSelection, revealLineInCenter, focus,
            setScrollTop, getTopForLineNumber: (line: number) => 16 + (line - 1) * 22,
            pushUndoStop: vi.fn(),
            onDidCompositionStart: (cb: () => void) => { compositionStart = cb; return { dispose: vi.fn() }; },
            onDidCompositionEnd: (cb: () => void) => { compositionEnd = cb; return { dispose: vi.fn() }; },
        });
        const ref = React.createRef<CodeEditorHandle>();
        const onReady = vi.fn();
        await renderScreen(<MonacoEditorSurface ref={ref} resetKey="commands" value={text} language="text" onChange={vi.fn()} onReady={onReady} />);
        ref.current!.revealLine(2, { select: true, focus: true, behavior: 'instant' });
        expect(setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 });
        expect(setSelection).toHaveBeenCalledWith({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 7 });
        expect(revealLineInCenter).toHaveBeenCalledWith(2, 1);
        expect(focus).toHaveBeenCalled();
        expect(onReady).toHaveBeenCalled();
        // Edit from View keeps the reader's top row (cut off by 5 px) instead of centring the caret line.
        revealLineInCenter.mockClear();
        ref.current!.revealLine(3, { top: { line: 2, offset: -5 }, behavior: 'instant' });
        expect(setPosition).toHaveBeenLastCalledWith({ lineNumber: 3, column: 1 });
        expect(setScrollTop).toHaveBeenCalledWith(16 + 22 + 5, 1);
        expect(revealLineInCenter).not.toHaveBeenCalled();
        ref.current!.runCommand({ replaceDocument: 'first\nSECOND\nlast' });
        expect(executeEdits).toHaveBeenCalledWith('happier.command', [{
            range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 7 }, text: 'SECOND', forceMoveMarkers: true,
        }]);
        const history = vi.fn();
        const unsubscribe = ref.current!.subscribeHistory(history);
        expect(history).toHaveBeenCalledWith({ canUndo: false, canRedo: false });
        ref.current!.runCommand('undo');
        expect(trigger).toHaveBeenLastCalledWith('happier.command', 'undo', null);
        compositionStart!();
        trigger.mockClear();
        ref.current!.runCommand('indent');
        expect(trigger).not.toHaveBeenCalled();
        compositionEnd!();
        ref.current!.runCommand('indent');
        expect(trigger).toHaveBeenLastCalledWith('happier.command', 'editor.action.indentLines', null);
        unsubscribe();
    });
    it('opens room for the change peek under its line, reads the line from its start and reports where the room is', async () => {
        setupMonacoGlobals();
        // Monaco's public view-zone boundary: zones push the lines after them down by their height.
        const zones = new Map<string, { afterLineNumber: number; heightInPx: number }>();
        let nextZone = 0;
        let scrollTop = 0;
        const setScrollLeft = vi.fn();
        const setScrollTop = vi.fn((top: number) => { scrollTop = top; });
        const layoutZone = vi.fn();
        const zonesBefore = (line: number) => [...zones.values()].filter((zone) => zone.afterLineNumber < line).reduce((sum, zone) => sum + zone.heightInPx, 0);
        const lineTop = (line: number) => 16 + (line - 1) * 22 + zonesBefore(line);
        const model = { ...createModelSpy.getMockImplementation()!(), getLineCount: () => 40 };
        createModelSpy.mockReturnValueOnce(model);
        createEditorSpy.mockReturnValueOnce({
            ...createEditorSpy.getMockImplementation()!(),
            changeViewZones: (callback: (accessor: unknown) => void) => callback({
                addZone: (zone: { afterLineNumber: number; heightInPx: number }) => { const id = `zone-${nextZone++}`; zones.set(id, zone); return id; },
                removeZone: (id: string) => { zones.delete(id); },
                layoutZone,
            }),
            getTopForLineNumber: (line: number, includeViewZones = false) => includeViewZones ? 16 + (line - 1) * 22 + zonesBefore(line - 1) : lineTop(line),
            getBottomForLineNumber: (line: number) => 16 + line * 22 + zonesBefore(line),
            getScrollTop: () => scrollTop,
            setScrollTop,
            setScrollLeft,
            getLayoutInfo: () => ({ contentLeft: 69, contentWidth: 500, height: 300 }),
            getDomNode: () => ({ getBoundingClientRect: () => ({ left: 100, top: 200 }), style: { setProperty: () => {} } }),
        });
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(<MonacoEditorSurface ref={ref} resetKey="peek-zone" value="one" language="text" onChange={vi.fn()} />);
        const moved = vi.fn();
        ref.current!.subscribeSelection!(moved);

        ref.current!.setPeekZone!({ afterLine: 2, height: 60 });
        expect([...zones.values()]).toEqual([expect.objectContaining({ afterLineNumber: 2, heightInPx: 60 })]);
        // Line 3 now starts below the room; an editor scrolled sideways shows the change from its first column.
        expect(lineTop(3)).toBe(16 + 2 * 22 + 60);
        expect(setScrollLeft).toHaveBeenCalledWith(0);
        expect(setScrollTop).not.toHaveBeenCalled();
        expect(ref.current!.getPeekZoneRect!()).toEqual({ x: 169, y: 200 + 16 + 2 * 22, width: 500, height: 60 });
        expect(moved).toHaveBeenCalled();

        // The peek grew: the same room is resized in place, and the reading position is not reset again.
        setScrollLeft.mockClear();
        ref.current!.setPeekZone!({ afterLine: 2, height: 90 });
        expect(zones.size).toBe(1);
        expect([...zones.values()][0]).toMatchObject({ heightInPx: 90 });
        expect(layoutZone).toHaveBeenCalled();
        expect(setScrollLeft).not.toHaveBeenCalled();

        // A change near the foot scrolls just enough for the whole room to show.
        ref.current!.setPeekZone!({ afterLine: 14, height: 60 });
        expect(zones.size).toBe(1);
        expect(setScrollTop).toHaveBeenCalledWith(16 + 14 * 22 + 60 - 300);
        expect(ref.current!.getPeekZoneRect!()).toMatchObject({ y: 200 + 16 + 14 * 22 - scrollTop });

        // A change taller than the editor peeks under the last of its lines in view, not 30 lines further down.
        setScrollTop.mockClear();
        scrollTop = 0;
        ref.current!.setPeekZone!({ afterLine: 40, firstLine: 1, height: 60 });
        expect([...zones.values()]).toEqual([expect.objectContaining({ afterLineNumber: 10 })]);
        expect(setScrollTop).not.toHaveBeenCalled();

        ref.current!.setPeekZone!(null);
        expect(zones.size).toBe(0);
        expect(ref.current!.getPeekZoneRect!()).toBeNull();
    });
    it('keeps a seeded query and line pending through a later open while the engine boots', async () => {
        setupMonacoGlobals();
        // The engine is still loading: the boot callback runs only when Monaco arrives.
        let boot: (() => void) | null = null;
        (globalThis as any).window.require = (_deps: unknown, onOk?: () => void) => { if (typeof onOk === 'function') boot = onOk; };
        const trigger = vi.fn();
        const setPosition = vi.fn();
        createEditorSpy.mockReturnValueOnce({ ...createEditorSpy.getMockImplementation()!(), trigger, setPosition, revealPositionInCenter: vi.fn() });
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(<MonacoEditorSurface ref={ref} resetKey="boot-seed" value="one" language="text" onChange={vi.fn()} />);
        // Edit hands the reader's Find over as a seed; the Find surface handoff then asks the engine to show Find.
        ref.current?.find?.seed('needle', { matchCase: false, regex: false }, { line: 40 });
        ref.current?.find?.open();
        await act(async () => { boot?.(); });
        expect(setPosition).toHaveBeenCalledWith({ lineNumber: 40, column: 1 });
        const finds = trigger.mock.calls.filter(([, id]) => id === 'editor.actions.findWithArgs').map(([, , args]) => args);
        // The seed reaches the engine first; a bare open after it keeps Monaco's now non-empty query.
        expect(finds[0]).toEqual(expect.objectContaining({ searchString: 'needle' }));
        expect(finds.every((args) => !args || (args as { searchString?: string }).searchString === 'needle')).toBe(true);
    });
    it('exposes the canonical decoration channel before the editor finishes booting', async () => {
        setupMonacoGlobals();
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(<MonacoEditorSurface ref={ref} resetKey="decoration" value="one" language="text" onChange={vi.fn()} />);
        expect(ref.current).toHaveProperty('setDecorations', expect.any(Function));
        expect(ref.current).toHaveProperty('onDecorationPress', expect.any(Function));
    });
    it('seeds the native find widget through the public action without changing the model', async () => {
        setupMonacoGlobals();
        // Monaco replaces a given search string with the word at the caret while its own Find state is
        // empty, unless selection seeding is off for that start; the seed's query must be what it shows.
        let seedFromSelection: unknown = 'always';
        const seedingAtTrigger: unknown[] = [];
        const trigger = vi.fn((_source: string, id: string) => { if (id === 'editor.actions.findWithArgs') seedingAtTrigger.push(seedFromSelection); });
        const updateOptions = vi.fn((options: { find?: { seedSearchStringFromSelection?: unknown } }) => {
            if (options.find && 'seedSearchStringFromSelection' in options.find) seedFromSelection = options.find.seedSearchStringFromSelection;
        });
        const setPosition = vi.fn();
        const revealPositionInCenter = vi.fn();
        const model = { getValue: () => 'first\r\nsecond\\n', setValue: vi.fn(), dispose: vi.fn() };
        createModelSpy.mockReturnValueOnce(model);
        const editorBoundary = {
            ...createEditorSpy.getMockImplementation()!(), trigger, setPosition, revealPositionInCenter, updateOptions,
        };
        createEditorSpy.mockReturnValueOnce(editorBoundary);
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(React.createElement(MonacoEditorSurface, {
            ref, resetKey: 'seed', value: model.getValue(), language: 'plaintext', onChange: vi.fn(),
        }));
        ref.current?.find?.seed('\\n', { matchCase: true, regex: false }, { line: 2, column: 7 });
        expect(trigger).toHaveBeenCalledWith('happier.find', 'editor.actions.findWithArgs', {
            searchString: '\\n', isRegex: false, isCaseSensitive: true, matchWholeWord: false, findInSelection: false,
        });
        expect(seedingAtTrigger).toEqual(['never']);
        // The person's own Cmd+F keeps seeding from the caret afterwards.
        expect(seedFromSelection).toBe('always');
        expect(setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 7 });
        expect(revealPositionInCenter).toHaveBeenCalledWith({ lineNumber: 2, column: 7 });
        expect(model.setValue).not.toHaveBeenCalled();
        expect(ref.current?.find?.presentation).toBe('native');
    });
    it('updates material paint without replacing the editor or dimming syntax', async () => {
        setupMonacoGlobals();
        const { storage } = await import('@/sync/domains/state/storage');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const previous = storage.getState().settings;
        const materials = glassPresetMaterials('everywhere');
        try {
            storage.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: materials } });
            await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true }}>
                <MonacoEditorSurface resetKey="glass" value="const x = 1;" language="typescript" onChange={() => {}} />
            </GlassRuntimeEnvironmentProvider>);
            expect(defineThemeSpy).toHaveBeenLastCalledWith('happier-editor-dark', expect.objectContaining({
                colors: expect.objectContaining({ 'editor.background': '#1f1f1f00', 'editor.foreground': '#f8f8f2' }),
            }));
            await act(async () => {
                storage.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: { ...materials, content: { blur: 'off', opacity: 1 } } } });
            });
            expect(createEditorSpy).toHaveBeenCalledTimes(1);
            expect(createModelSpy).toHaveBeenCalledTimes(1);
            expect(defineThemeSpy).toHaveBeenLastCalledWith('happier-editor-dark', expect.objectContaining({
                colors: expect.objectContaining({ 'editor.background': '#1f1f1f', 'editor.foreground': '#f8f8f2' }),
            }));
        } finally {
            await act(async () => { storage.setState({ settings: previous }); });
        }
    });
    it('boots Monaco even when initially not ready', async () => {
        setupMonacoGlobals();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange: vi.fn(),
                    wrapLines: true,
                    showLineNumbers: true,
                }));

        expect(createModelSpy).toHaveBeenCalledTimes(1);
        expect(createEditorSpy).toHaveBeenCalledTimes(1);
    });

    it('boots Monaco with a theme derived from app theme tokens', async () => {
        setupMonacoGlobals();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'const message = "hello";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }));

        expect(defineThemeSpy).toHaveBeenCalledWith(
            'happier-editor-dark',
            expect.objectContaining({
                base: 'vs-dark',
                inherit: true,
                colors: expect.objectContaining({
                    'editor.background': '#1f1f1f',
                    'editor.foreground': '#f8f8f2',
                    'editorLineNumber.foreground': '#8a8a8a',
                }),
                rules: expect.arrayContaining([
                    expect.objectContaining({ token: 'keyword', foreground: 'ff79c6' }),
                    expect.objectContaining({ token: 'string', foreground: '50fa7b' }),
                    expect.objectContaining({ token: 'comment', foreground: '6272a4' }),
                ]),
            }),
        );
        expect(setThemeSpy).toHaveBeenLastCalledWith('happier-editor-dark');
        expect(createEditorSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ theme: 'happier-editor-dark' }),
        );
    });

    it('updates the Monaco theme when the app theme changes after mount', async () => {
        setupMonacoGlobals();

        const result = await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'const message = "hello";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }));

        expect(setThemeSpy).toHaveBeenLastCalledWith('happier-editor-dark');

        unistylesState.currentTheme = lightEditorTheme;
        await act(async () => {
            await result.update(
                React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'const message = "hello";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }),
            );
            await flushHookEffects();
        });

        expect(defineThemeSpy).toHaveBeenLastCalledWith(
            'happier-editor-light',
            expect.objectContaining({
                base: 'vs',
                colors: expect.objectContaining({
                    'editor.background': '#f6f8fa',
                    'editor.foreground': '#24292f',
                }),
            }),
        );
        expect(setThemeSpy).toHaveBeenLastCalledWith('happier-editor-light');
    });

    it('debounces onChange when changeDebounceMs is set', async () => {
        let currentValue = 'start';
        let changeHandler: null | ((..._args: any[]) => void) = null;
        let blurHandler: null | ((..._args: any[]) => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    uri: { scheme: 'inmemory', path: '/surface-test' },
                    getValue: () => currentValue,
                    getLineCount: () => currentValue.split('\n').length,
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    createContextKey: () => ({ set() {}, reset() {} }), addAction: () => ({ dispose() {} }),
                    createDecorationsCollection: () => ({ set() {}, clear() {} }),
                    onDidChangeModelContent: (handler: (..._args: any[]) => void) => {
                        changeHandler = handler;
                        return { dispose: () => {} };
                    },
                    onDidBlurEditorText: (handler: (..._args: any[]) => void) => {
                        blurHandler = handler;
                        return { dispose: () => {} };
                    },
                    updateOptions: () => {},
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: currentValue,
                    language: 'markdown',
                    onChange,
                    changeDebounceMs: 50,
                }));

        const triggerChange = assertCallable(changeHandler, 'change handler');

        currentValue = 'a';
        triggerChange({});
        currentValue = 'ab';
        triggerChange({});
        currentValue = 'abc';
        triggerChange({});

        expect(onChange).toHaveBeenCalledTimes(0);

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 75));
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith('abc');
        currentValue = 'ab';
        triggerChange({ isUndoing: true });
        expect(onChange).toHaveBeenLastCalledWith('ab', { history: 'undo' });
        currentValue = 'abc';
        triggerChange({ isRedoing: true });
        expect(onChange).toHaveBeenLastCalledWith('abc', { history: 'redo' });
    });

    it('flushes pending debounced change on blur', async () => {
        let currentValue = 'start';
        let changeHandler: null | ((..._args: any[]) => void) = null;
        let blurHandler: null | ((..._args: any[]) => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    uri: { scheme: 'inmemory', path: '/surface-test' },
                    getValue: () => currentValue,
                    getLineCount: () => currentValue.split('\n').length,
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    createContextKey: () => ({ set() {}, reset() {} }), addAction: () => ({ dispose() {} }),
                    createDecorationsCollection: () => ({ set() {}, clear() {} }),
                    onDidChangeModelContent: (handler: (..._args: any[]) => void) => {
                        changeHandler = handler;
                        return { dispose: () => {} };
                    },
                    onDidBlurEditorText: (handler: (..._args: any[]) => void) => {
                        blurHandler = handler;
                        return { dispose: () => {} };
                    },
                    updateOptions: () => {},
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: currentValue,
                    language: 'markdown',
                    onChange,
                    changeDebounceMs: 50,
                }));

        const triggerChange = assertCallable(changeHandler, 'change handler');
        const triggerBlur = assertCallable(blurHandler, 'blur handler');

        currentValue = 'blur-me';
        triggerChange({});

        expect(onChange).toHaveBeenCalledTimes(0);

        await act(async () => {
            triggerBlur({});
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith('blur-me');
    });

    it('keeps unflushed local edits when an external value arrives mid-typing (flushes instead of replacing the doc)', async () => {
        let currentValue = 'seed';
        let changeHandler: null | ((..._args: any[]) => void) = null;
        const setValueSpy = vi.fn((next: string) => {
            currentValue = next;
        });
        const executeEditsSpy = vi.fn((_source: string, edits: Array<{ text: string }>) => {
            currentValue = edits[0]?.text ?? currentValue;
        });

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    uri: { scheme: 'inmemory', path: '/surface-test' },
                    getValue: () => currentValue,
                    getLineCount: () => currentValue.split('\n').length,
                    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: currentValue.length + 1 }),
                    setValue: setValueSpy,
                    dispose: () => {},
                }),
                create: () => ({
                    createContextKey: () => ({ set() {}, reset() {} }), addAction: () => ({ dispose() {} }),
                    createDecorationsCollection: () => ({ set() {}, clear() {} }),
                    onDidChangeModelContent: (handler: (..._args: any[]) => void) => {
                        changeHandler = handler;
                        return { dispose: () => {} };
                    },
                    onDidBlurEditorText: () => ({ dispose: () => {} }),
                    updateOptions: () => {},
                    executeEdits: executeEditsSpy,
                    getSelections: () => null,
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(MonacoEditorSurface, {
            resetKey: '1',
            value: currentValue,
            language: 'markdown',
            onChange,
            changeDebounceMs: 100,
        }));

        const triggerChange = assertCallable(changeHandler, 'change handler');

        currentValue = 'local draft';
        triggerChange({});

        await act(async () => {
            await screen.update(React.createElement(MonacoEditorSurface, {
                resetKey: '1',
                value: 'external seed',
                language: 'markdown',
                onChange,
                changeDebounceMs: 100,
            }));
        });
        await flushHookEffects();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 125));
        });

        // The user's unflushed local edit is the source of truth: the stale/racing
        // external value must not replace the document (that resets the cursor and
        // loses keystrokes). The pending change is flushed upward so the parent
        // state converges to the editor instead.
        expect(executeEditsSpy).not.toHaveBeenCalled();
        expect(setValueSpy).not.toHaveBeenCalled();
        expect(currentValue).toBe('local draft');
        expect(onChange).toHaveBeenCalledWith('local draft');
    });

    it('exposes a stable imperative handle for flush/getValue', async () => {
        const ref = React.createRef<any>();

        let currentValue = 'hello';
        let blurHandler: null | (() => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    uri: { scheme: 'inmemory', path: '/surface-test' },
                    getValue: () => currentValue,
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    createContextKey: () => ({ set() {}, reset() {} }), addAction: () => ({ dispose() {} }),
                    createDecorationsCollection: () => ({ set() {}, clear() {} }),
                    onDidChangeModelContent: () => ({ dispose: () => {} }),
                    onDidBlurEditorText: (handler: () => void) => {
                        blurHandler = handler;
                        return { dispose: () => {} };
                    },
                    updateOptions: () => {},
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    ref,
                    resetKey: '1',
                    value: currentValue,
                    language: 'markdown',
                    onChange,
                    changeDebounceMs: 50,
                }));

        expect(ref.current).toBeTruthy();
        expect(typeof ref.current.getValue).toBe('function');
        expect(typeof ref.current.flushPendingChange).toBe('function');
        expect(ref.current.getValue()).toBe('hello');

        currentValue = 'world';
        expect(ref.current.getValue()).toBe('world');

        // Flush should be safe to call even if no timer is pending; blur handler should exist.
        await act(async () => {
            await ref.current.flushPendingChange();
        });
        expect(blurHandler).not.toBeNull();
    });

    it('applies external value changes through editor edits so selection and scroll position are preserved', async () => {
        let currentValue = 'first line\nsecond line';
        const setValueSpy = vi.fn((next: string) => {
            currentValue = next;
        });
        const executeEditsSpy = vi.fn((_source: string, edits: Array<{ text: string }>) => {
            currentValue = edits[0]?.text ?? currentValue;
        });
        const getSelectionsSpy = vi.fn(() => [{ startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4 }]);
        const setSelectionsSpy = vi.fn();
        const getScrollTopSpy = vi.fn(() => 42);
        const getScrollLeftSpy = vi.fn(() => 7);
        const setScrollTopSpy = vi.fn();
        const setScrollLeftSpy = vi.fn();

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    getValue: () => currentValue,
                    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 12 }),
                    setValue: setValueSpy,
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: () => ({ dispose: () => {} }),
                    onDidBlurEditorText: () => ({ dispose: () => {} }),
                    updateOptions: () => {},
                    executeEdits: executeEditsSpy,
                    getSelections: getSelectionsSpy,
                    setSelections: setSelectionsSpy,
                    getScrollTop: getScrollTopSpy,
                    getScrollLeft: getScrollLeftSpy,
                    setScrollTop: setScrollTopSpy,
                    setScrollLeft: setScrollLeftSpy,
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(MonacoEditorSurface, {
            resetKey: '1',
            value: currentValue,
            language: 'markdown',
            onChange,
        }));

        await act(async () => {
            await screen.update(React.createElement(MonacoEditorSurface, {
                resetKey: '1',
                value: 'first line\nchanged second line',
                language: 'markdown',
                onChange,
            }));
            await flushHookEffects();
        });

        expect(executeEditsSpy).toHaveBeenCalledWith(
            'happier.external-value',
            [expect.objectContaining({ text: 'first line\nchanged second line' })],
            expect.anything(),
        );
        expect(setValueSpy).not.toHaveBeenCalled();
        expect(setSelectionsSpy).toHaveBeenCalledWith([{ startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4 }]);
        expect(setScrollTopSpy).toHaveBeenCalledWith(42);
        expect(setScrollLeftSpy).toHaveBeenCalledWith(7);
    });

    it('updates editor readOnly mode when the prop changes after mount', async () => {
        const updateOptionsSpy = vi.fn();

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    getValue: () => 'hello',
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: () => ({ dispose: () => {} }),
                    onDidBlurEditorText: () => ({ dispose: () => {} }),
                    updateOptions: updateOptionsSpy,
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: true,
                }));

        updateOptionsSpy.mockClear();

        await act(async () => {
            await screen.update(
                React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: false,
                }),
            );
            await flushHookEffects();
        });

        expect(updateOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({ readOnly: false }));
    });

    it('boots Monaco with the latest readOnly mode when props change before Monaco resolves', async () => {
        const createEditorWithLatestOptionsSpy = vi.fn(() => ({
            onDidChangeModelContent: () => ({ dispose: () => {} }),
            onDidBlurEditorText: () => ({ dispose: () => {} }),
            updateOptions: () => {},
            dispose: () => {},
        }));

        let resolveEditorMain: null | (() => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        delete (globalThis as any).window.monaco;
        (globalThis as any).window.require = Object.assign(
            (deps: any, onOk?: any, _onErr?: any) => {
                if (Array.isArray(deps) && deps[0] === 'vs/editor/editor.main') {
                    resolveEditorMain = () => {
                        (globalThis as any).window.monaco = {
                            ...createMonacoLanguageServicesBoundary(),
                            editor: {
                                createModel: () => ({
                                    getValue: () => 'hello',
                                    setValue: () => {},
                                    dispose: () => {},
                                }),
                                create: createEditorWithLatestOptionsSpy,
                            },
                        };
                        if (typeof onOk === 'function') onOk();
                    };
                    return;
                }
                if (typeof onOk === 'function') onOk();
            },
            { config: vi.fn() },
        );

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: true,
                }));

        await act(async () => {
            await screen.update(
                React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: false,
                }),
            );
            await flushHookEffects();
        });

        expect(createEditorWithLatestOptionsSpy).not.toHaveBeenCalled();

        await act(async () => {
            if (!resolveEditorMain) throw new Error('expected editor main loader callback');
            resolveEditorMain();
            await flushHookEffects();
        });

        expect(createEditorWithLatestOptionsSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ readOnly: false }),
        );
    });
});
