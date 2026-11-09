// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../../../../../../../packages/tests/src/testkit/uiE2e/browserDiagnostics';

const directory = dirname(fileURLToPath(import.meta.url));
const assets = resolve(directory, '../../../../../../public/monaco');
let server: Server;
let browser: Browser;
let origin: string;
let accessibilityAwait: { path: string; line: number; startColumn: number; endColumn: number };
const awaitFailure = 'monaco-accessibility-non-cancellation-await-failure';

// Only the remote candidate is supplied. The vendored Monaco, EditContext, provider,
// keybinding service, DOM rendering and undo history all run in Chromium.
const entry = `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useMonacoEscapeLayer } from './useMonacoEscapeLayer';
import { createMonacoNextEdit } from './monacoNextEdit';
import { useModalPaneBoundary } from '@/components/ui/panels/ModalPaneBoundary';
import { setActiveUnsavedChangesGuard, clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { createMonacoInlineSuggestions } from './monacoInlineSuggestions';
import { createCodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import { bindCodeIntelligenceEditor } from '@/sync/domains/workspaces/languageIntelligence/bindCodeIntelligenceEditor';
import { FilesEditorAiSuggestionsV1Schema } from '@happier-dev/protocol/account/settings/accountSettings';
export function boot(monaco) {
    if (new URLSearchParams(location.search).has('escape-layers')) return bootEscape(monaco);
    const model = monaco.editor.createModel('xTAIL', 'plaintext');
    const editor = monaco.editor.create(document.getElementById('editor'), {
        model, automaticLayout: true, experimentalEditContextEnabled: true,
        inlineSuggest: { enabled: true, suppressSuggestions: false, showToolbar: 'never' },
        minimap: { enabled: false }, quickSuggestions: false,
    });
    editor.setPosition({ lineNumber: 1, column: 2 });
    if (new URLSearchParams(location.search).has('native-only')) {
        let registration;
        const nativeActionErrors = [];
        window.fixture = {
            async empty() { await editor.getAction('editor.action.inlineSuggest.trigger').run(); },
            async nativeRequest() {
                registration = monaco.languages.registerInlineCompletionsProvider('plaintext', {
                    provideInlineCompletions() { return { items: [{ insertText: 'native', range: new monaco.Range(1, 2, 1, 2) }] }; },
                    disposeInlineCompletions() {},
                });
                try { await editor.getAction('editor.action.inlineSuggest.trigger').run(); }
                catch (error) { nativeActionErrors.push(String(error)); }
            },
            read() { return { text: model.getValue(), focused: editor.hasTextFocus(), nativeActionErrors }; },
            dispose() { registration?.dispose(); editor.dispose(); model.dispose(); },
        };
        editor.focus();
        return;
    }
    const events = [];
    const usage = [];
    const inline = createMonacoInlineSuggestions(monaco, editor, model, { readOnly: () => false,
        afterAccept: () => editor.pushUndoStop() });
    inline.handle.onEvent(event => events.push(event));
    let replyText = '';
    const settings = FilesEditorAiSuggestionsV1Schema.parse({ enabled: true, mode: 'onRequest', connectionId: 'source', modelId: 'fim' });
    const descriptor = { id: 'fim', name: 'FIM', contextWindowTokens: 4096,
        inlineCompletion: { operationId: 'fim', tokenAccounting: 'utf8-bytes', outputTokens: 128, promptOverheadTokens: 32 } };
    const controller = createCodeIntelligenceController({
        scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
        getText: () => model.getValue(), openLocation() {}, query: async () => ({ status: 'unavailable', reason: 'no_capable_server' }),
        inlineSuggestions: { getSettings: () => settings, getModel: () => descriptor, onUsage: event => usage.push(event),
            query: async request => ({ status: 'ok', kind: 'ai.inlineSuggest', version: request.version, text: replyText }) },
    });
    const unbind = bindCodeIntelligenceEditor(controller, { getValue: () => model.getValue(), inlineSuggestions: inline.handle });
    window.fixture = {
        async empty() { await editor.getAction('editor.action.inlineSuggest.trigger').run(); },
        reply(text) { replyText = text; },
        read() { return { text: model.getValue(), focused: editor.hasTextFocus(),
            candidate: inline.handle.getSuggestion(), context: inline.handle.getContext(), events, status: controller.inlineSuggestions.getSnapshot(),
            active: document.activeElement?.className, usage }; },
        select(ranges) { editor.setSelections(ranges); },
        list() {
            monaco.languages.registerCompletionItemProvider('plaintext', {
                provideCompletionItems() { return { suggestions: [{ label: 'lspName', filterText: 'x', insertText: 'lspName',
                    kind: monaco.languages.CompletionItemKind.Variable,
                    range: new monaco.Range(1, 1, 1, 2) }] }; },
            });
            editor.trigger('test', 'editor.action.triggerSuggest', null);
        },
        dispose() { unbind(); controller.dispose(); inline.dispose(); editor.dispose(); model.dispose(); },
    };
    editor.focus();
}

// The same surface Escape hook, pane boundary/focus trap, native engine and inference controller
// as the File editor. Only the remote answer and the person's dirty-close choice are scripted.
function bootEscape(monaco) {
    const model = monaco.editor.createModel('function old() {}\\nold();', 'plaintext');
    const editor = monaco.editor.create(document.getElementById('editor'), {
        model, automaticLayout: true, experimentalEditContextEnabled: true, quickSuggestions: false,
        minimap: { enabled: false }, inlineSuggest: { enabled: true, showToolbar: 'never' },
    });
    editor.setPosition({ lineNumber: 1, column: 13 });
    const saved = model.getValue();
    const dirty = { current: false };
    let closed = false;
    let decisions = 0;
    let settleDecision;
    setActiveUnsavedChangesGuard({ isDirtyRef: dirty, tag: 'file-editor',
        prepareGuard() { dirty.current = model.getValue() !== saved; },
        requestDecision() { decisions++; return new Promise(resolve => { settleDecision = resolve; }); },
        onDiscard() { model.setValue(saved); },
    });
    const inline = createMonacoInlineSuggestions(monaco, editor, model, { readOnly: () => false });
    const next = createMonacoNextEdit(editor, model, { getContext: inline.handle.getContext, readOnly: () => false });
    const settings = FilesEditorAiSuggestionsV1Schema.parse({ enabled: true, nextEditEnabled: true,
        mode: 'onRequest', connectionId: 'source', modelId: 'edit-model', nextEditModelId: 'edit-model' });
    const descriptor = { id: 'edit-model', name: 'Edit model', contextWindowTokens: 32768,
        nextEdit: { operationId: 'edit', tokenAccounting: 'utf8-bytes', outputTokens: 4096, promptOverheadTokens: 32 } };
    const controller = createCodeIntelligenceController({
        scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'plaintext',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
        getText: () => model.getValue(), openLocation() {}, query: async () => ({ status: 'unavailable', reason: 'no_capable_server' }),
        inlineSuggestions: { getSettings: () => settings, getModel: () => descriptor,
            query: async request => ({ status: 'ok', kind: 'ai.nextEdit', version: request.version,
                edits: [{ path: 'a.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, oldText: 'old', newText: 'new' }] }) },
    });
    const unbind = bindCodeIntelligenceEditor(controller, { getValue: () => model.getValue(), inlineSuggestions: inline.handle,
        setLanguageIntelligence: port => next.setPort(port?.nextEditSuggestions ?? null) },
        { path: 'a.ts', inlayHints: 'off', semanticHighlighting: false });
    const root = createRoot(document.getElementById('escape-root'));
    function Layers() {
        const boundary = useModalPaneBoundary({ active: true, label: 'Details panel', escapeEnabled: true,
            allowEditableEscape: true, onRequestClose: () => { closed = true; } });
        useMonacoEscapeLayer({ editorRef: { current: editor }, inline, nextEditRef: { current: next },
            find: { isOpen: () => editor.getDomNode().querySelector('.find-widget')?.classList.contains('visible') === true } });
        React.useLayoutEffect(() => { boundary.setOverlayFocusRef(document.getElementById('overlay')); }, [boundary.setOverlayFocusRef]);
        return null;
    }
    flushSync(() => root.render(React.createElement(Layers)));
    let completions;
    window.fixture = {
        read() { return { text: model.getValue(), closed, decisions, next: controller.nextEditSuggestions.getSnapshot().status,
            candidate: inline.handle.getSuggestion() }; },
        list() {
            completions = monaco.languages.registerCompletionItemProvider('plaintext', { provideCompletionItems() {
                const position = editor.getPosition();
                return { suggestions: [{ label: 'completion', insertText: 'completion', kind: monaco.languages.CompletionItemKind.Variable,
                    range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
            } });
            editor.trigger('test', 'editor.action.triggerSuggest', null);
        },
        find() { editor.trigger('test', 'actions.find', null); },
        inline() { inline.handle.set({ id: 'ghost', text: 'More', line: 1, character: editor.getPosition().column - 1 }); },
        decide(decision) { settleDecision?.(decision); },
        dispose() { flushSync(() => root.unmount()); clearActiveUnsavedChangesGuard(); completions?.dispose();
            unbind(); controller.dispose(); next.dispose(); inline.dispose(); editor.dispose(); model.dispose(); },
    };
    editor.focus();
}
`;

type EscapeFixture = {
    read(): { text: string; closed: boolean; decisions: number; next: string; candidate: unknown };
    list(): void;
    find(): void;
    inline(): void;
    decide(decision: 'keepEditing' | 'discard'): void;
    dispose(): void;
};

async function withEscapeEditor(run: (page: Page) => Promise<void>) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
        Object.assign(window, { escapeRejections: [] });
        window.addEventListener('unhandledrejection', event => {
            (window as unknown as { escapeRejections: string[] }).escapeRejections.push(String(event.reason));
        });
    });
    try {
        await page.goto(origin + '/?escape-layers=1');
        await page.waitForFunction(() => Boolean((window as unknown as { fixture?: EscapeFixture }).fixture));
        await page.locator('.native-edit-context').focus();
        await run(page);
        await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.dispose());
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => (window as unknown as { escapeRejections: string[] }).escapeRejections)).toEqual([]);
    } finally { await page.close(); }
}

type Fixture = {
    empty(): Promise<void>;
    reply(text: string): void;
    read(): { text: string; focused: boolean; usage: Array<{ kind: string }>; candidate: { text: string } | null; context: { composing: boolean; suggestWidgetOpen: boolean } };
    select(ranges: Array<{ selectionStartLineNumber: number; selectionStartColumn: number; positionLineNumber: number; positionColumn: number }>): void;
    list(): void;
    dispose(): void;
};
async function request(page: Page, text: string) {
    await page.evaluate(text => (window as unknown as { fixture: Fixture }).fixture.reply(text), text);
    await page.keyboard.press('Alt+Backslash');
}
async function withEditor(run: (page: Page) => Promise<void>, options: { nativeOnly?: boolean; failAtAwait?: boolean } = {}) {
    const page = await browser.newPage();
    const diagnostics = collectBrowserDiagnostics({ page });
    let disposed = false;
    let lastState: unknown;
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.stack ?? String(error)));
    await page.addInitScript(({ failAtAwait, location, message }) => {
        const errors: string[] = [];
        const fault = { injections: 0, stack: '' };
        Object.assign(window, { inlineUnhandledRejections: errors, inlineAwaitFault: fault });
        window.addEventListener('unhandledrejection', event => {
            errors.push(event.reason instanceof Error ? event.reason.stack ?? String(event.reason) : String(event.reason));
        });
        if (failAtAwait) {
            const setTimeout = window.setTimeout.bind(window);
            // The browser clock is the external boundary. Keep the native reaction/catch real.
            window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
                if (delay === 50 && fault.injections === 0) {
                    const error = new Error(message);
                    // A name-only cancellation filter must not swallow a genuine failure.
                    error.name = 'Canceled';
                    const stack = error.stack ?? '';
                    const atAwait = stack.split('\n').some(frame => {
                        const suffix = frame.split(`${location.path}:${location.line}:`)[1];
                        const column = Number(/^\d+/.exec(suffix ?? '')?.[0]);
                        return column >= location.startColumn && column <= location.endColumn;
                    });
                    if (atAwait) {
                        fault.injections++;
                        fault.stack = stack;
                        throw error;
                    }
                }
                return setTimeout(handler, delay, ...args);
            }) as typeof window.setTimeout;
        }
    }, { failAtAwait: options.failAtAwait === true, location: accessibilityAwait, message: awaitFailure });
    try {
        await page.goto(options.nativeOnly ? origin + '/?native-only=1' : origin);
        await page.waitForFunction(() => Boolean((window as unknown as { fixture?: Fixture }).fixture));
        await expect.poll(() => page.locator('.native-edit-context').count()).toBe(1);
        await page.locator('.native-edit-context').focus();
        await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.empty());
        await run(page);
        lastState = await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read());
        await page.evaluate(async () => {
            (window as unknown as { fixture: Fixture }).fixture.dispose();
            // Drain browser turns after teardown, without intercepting or suppressing failures.
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        disposed = true;
        const rejections = await page.evaluate(() => (window as unknown as { inlineUnhandledRejections: string[] }).inlineUnhandledRejections);
        if (options.failAtAwait) {
            expect(await page.evaluate(() => (window as unknown as { inlineAwaitFault: { injections: number } }).inlineAwaitFault.injections)).toBe(1);
            expect(rejections).toHaveLength(1);
            expect(rejections[0]).toContain(awaitFailure);
            expect(pageErrors).toHaveLength(1);
            expect(pageErrors[0]).toContain(awaitFailure);
        } else {
            expect(rejections).toEqual([]);
            expect(pageErrors).toEqual([]);
        }
    } catch (error) {
        const state = disposed ? lastState : await page.evaluate(() => (window as unknown as { fixture?: Fixture }).fixture?.read());
        throw appendBrowserDiagnostics(error, `${JSON.stringify(state)}\n${diagnostics()}`);
    } finally {
        if (!disposed) await page.evaluate(() => (window as unknown as { fixture?: Fixture }).fixture?.dispose());
        await page.close();
    }
}

describe('Monaco inline suggestions with real EditContext keyboard input', () => {
    beforeAll(async () => {
        const chunk = 'vs/toggleHighContrast-DuqAmExZ.js';
        const source = await readFile(resolve(assets, chunk), 'utf8');
        const awaitCall = 'await a.timeout(50,a.cancelOnDispose(b))';
        const offset = source.indexOf(awaitCall);
        expect(offset).toBeGreaterThan(-1);
        expect(source.indexOf(awaitCall, offset + 1)).toBe(-1);
        const startColumn = offset - source.lastIndexOf('\n', offset);
        accessibilityAwait = { path: `/monaco/${chunk}`, line: source.slice(0, offset).split('\n').length,
            startColumn, endColumn: startColumn + awaitCall.length };
        const bundle = await build({ stdin: { contents: entry, resolveDir: directory, loader: 'ts' },
            alias: { '@': resolve(directory, '../../../../../'), 'react-native': 'react-native-web' }, conditions: ['happier-source', 'browser'],
            resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
            define: { 'process.env.NODE_ENV': '"test"', __DEV__: 'true' },
            bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'InlineFixture' });
        const script = bundle.outputFiles[0]!.text;
        server = createServer(async (request, response) => {
            try {
                const path = new URL(request.url ?? '/', 'http://localhost').pathname;
                if (path === '/') {
                    response.setHeader('content-type', 'text/html');
                    response.end(`<style>#editor{width:800px;height:400px}</style><button>Before</button><div id="overlay"><div id="editor"></div></div><button>After</button><div id="escape-root"></div>
                        <script src="/monaco/vs/loader.js"></script><script src="/fixture.js"></script>
                        <script>require.config({paths:{vs:'/monaco/vs'}});require(['vs/editor/editor.main'],()=>InlineFixture.boot(monaco));</script>`);
                } else if (path === '/fixture.js') {
                    response.setHeader('content-type', 'text/javascript'); response.end(script);
                } else {
                    const file = resolve(assets, `.${path.slice('/monaco'.length)}`);
                    if (!path.startsWith('/monaco/') || !file.startsWith(assets + sep)) { response.writeHead(404); response.end(); return; }
                    response.setHeader('content-type', file.endsWith('.css') ? 'text/css' : file.endsWith('.ttf') ? 'font/ttf' : 'text/javascript');
                    response.end(await readFile(file));
                }
            } catch { response.writeHead(404); response.end(); }
        });
        await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing browser fixture listener');
        origin = `http://127.0.0.1:${address.port}`;
        try { browser = await chromium.launch({ headless: true }); }
        catch (error) {
            // Some compute workers install full Chromium without Playwright's optional headless shell.
            if (!(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error;
            browser = await chromium.launch({ headless: true, channel: 'chromium' });
        }
    });
    afterAll(async () => {
        await browser?.close();
        if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    });

    it('leaves the first Escape to the completion list, then guards the dirty pane close', async () => withEscapeEditor(async page => {
        await page.keyboard.type('X');
        const draft = await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().text);
        await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.list());
        await page.locator('.suggest-widget.visible').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().closed)).toBe(false);
        await page.locator('.suggest-widget.visible').waitFor({ state: 'hidden' });
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read())).toMatchObject({
            text: draft, closed: false, decisions: 0 });
        await page.keyboard.press('Escape');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().decisions)).toBe(1);
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().closed)).toBe(false);
        await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.decide('keepEditing'));
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read())).toMatchObject({ text: draft, closed: false });
        await page.keyboard.press('Escape');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().decisions)).toBe(2);
        await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.decide('discard'));
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().closed)).toBe(true);
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().text)).toBe('function old() {}\nold();');
    }));

    it('leaves Escape to the real find widget without closing a dirty pane', async () => withEscapeEditor(async page => {
        await page.keyboard.type('X');
        const draft = await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().text);
        await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.find());
        await page.locator('.find-widget.visible').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().closed)).toBe(false);
        await page.locator('.find-widget.visible').waitFor({ state: 'hidden' });
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read())).toMatchObject({ text: draft, closed: false, decisions: 0 });
    }));

    it('dismisses only a real next-edit preview on Escape', async () => withEscapeEditor(async page => {
        for (let index = 0; index < 3; index++) await page.keyboard.press('Backspace');
        await page.keyboard.type('new');
        const draft = await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().text);
        await page.keyboard.press('Alt+Backslash');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().next)).toBe('ready');
        await page.keyboard.press('Tab');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().next)).toBe('preview');
        await page.keyboard.press('Escape');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().next)).toBe('idle');
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read())).toMatchObject({ text: draft, closed: false, decisions: 0 });
    }));

    it('dismisses only the real inline ghost on Escape', async () => withEscapeEditor(async page => {
        await page.keyboard.type('X');
        const draft = await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().text);
        await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.inline());
        await page.locator('.ghost-text-decoration').first().waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().candidate)).toBeNull();
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read())).toMatchObject({ text: draft, closed: false, decisions: 0 });
    }));

    it('keeps a dirty pane open for the existing decision when no widget is open', async () => withEscapeEditor(async page => {
        await page.keyboard.type('X');
        const draft = await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read().text);
        await page.keyboard.press('Escape');
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read())).toMatchObject({ text: draft, closed: false, decisions: 1 });
        await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.decide('keepEditing'));
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read())).toMatchObject({ text: draft, closed: false });
    }));

    it('closes a clean pane on Escape when no editor widget is open', async () => withEscapeEditor(async page => {
        await page.keyboard.press('Escape');
        expect(await page.evaluate(() => (window as unknown as { fixture: EscapeFixture }).fixture.read())).toMatchObject({ closed: true, decisions: 0 });
    }));

    it('accepts the whole ghost on real Tab and restores exact bytes with one undo', async () => withEditor(async page => {
        await request(page, ' café 😀\nnext');
        await page.locator('.ghost-text-decoration').first().waitFor({ state: 'visible' });
        await page.keyboard.press('Tab');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().text)).toBe('x café 😀\nnextTAIL');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().usage.filter(event => event.kind === 'acceptedFull').length)).toBe(1);
        expect(await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().focused)).toBe(true);
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().text)).toBe('xTAIL');
    }));

    it('accepts a word with the real modifier arrow', async () => withEditor(async page => {
        await request(page, 'café more');
        await page.locator('.ghost-text-decoration').first().waitFor({ state: 'visible' });
        await page.keyboard.press('ControlOrMeta+ArrowRight');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().text)).toBe('xcaféTAIL');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().usage.filter(event => event.kind === 'acceptedPartial').length)).toBe(1);
    }));

    it('renders repeated requests after Escape at the unchanged caret', async () => withEditor(async page => {
        for (let repeat = 0; repeat < 2; repeat++) {
            await request(page, ' again');
            await page.locator('.ghost-text-decoration').first().waitFor({ state: 'visible' });
            await page.keyboard.press('Escape');
            await expect.poll(() => page.locator('.ghost-text-decoration').count()).toBe(0);
        }
    }));

    it('keeps request, supersede, accept, Escape and repeat free of unhandled failures', async () => withEditor(async page => {
        await request(page, ' old');
        await page.locator('.ghost-text-decoration').first().waitFor({ state: 'visible' });
        await request(page, ' fresh');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().candidate?.text)).toBe(' fresh');
        await page.keyboard.press('Tab');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().text)).toBe('x freshTAIL');
        await page.keyboard.press('ControlOrMeta+z');
        for (let repeat = 0; repeat < 2; repeat++) {
            await request(page, ' repeat');
            await page.locator('.ghost-text-decoration').first().waitFor({ state: 'visible' });
            await page.keyboard.press('Escape');
            await expect.poll(() => page.locator('.ghost-text-decoration').count()).toBe(0);
        }
        expect(await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().text)).toBe('xTAIL');
    }));

    it('contains cancellation in the native engine even without an adapter or an uncaught action promise', async () => withEditor(async page => {
        type NativeFixture = { nativeRequest(): Promise<void>; read(): { nativeActionErrors: string[] } };
        await page.evaluate(() => (window as unknown as { fixture: NativeFixture }).fixture.nativeRequest());
        await page.locator('.ghost-text-decoration').first().waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        expect(await page.evaluate(() => (window as unknown as { fixture: NativeFixture }).fixture.read().nativeActionErrors)).toEqual([]);
    }, { nativeOnly: true }));

    it('keeps a non-cancellation failure at the native accessibility await observable', async () => withEditor(async page => {
        type NativeFixture = { nativeRequest(): Promise<void>; read(): { nativeActionErrors: string[] } };
        await page.evaluate(() => (window as unknown as { fixture: NativeFixture }).fixture.nativeRequest());
        await expect.poll(() => page.evaluate(() => (window as unknown as { inlineAwaitFault: { injections: number } }).inlineAwaitFault.injections)).toBe(1);
        await expect.poll(() => page.evaluate(() => (window as unknown as { inlineUnhandledRejections: string[] }).inlineUnhandledRejections.some(error => error.includes('monaco-accessibility-non-cancellation-await-failure')))).toBe(true);
        expect(await page.evaluate(() => (window as unknown as { fixture: NativeFixture }).fixture.read().nativeActionErrors)).toEqual([]);
    }, { nativeOnly: true, failAtAwait: true }));

    it('keeps the server completion list ahead of ghost Tab and refuses selected text', async () => withEditor(async page => {
        await request(page, ' ghost');
        await page.locator('.ghost-text-decoration').first().waitFor({ state: 'visible' });
        await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.list());
        await expect.poll(() => page.locator('.suggest-widget.visible').count()).toBe(1);
        await page.keyboard.press('Tab');
        await expect.poll(() => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().text)).toBe('lspNameTAIL');
        await page.evaluate(() => {
            const f = (window as unknown as { fixture: Fixture }).fixture;
            f.select([{ selectionStartLineNumber: 1, selectionStartColumn: 1, positionLineNumber: 1, positionColumn: 4 }]);
        });
        await request(page, ' forbidden');
        expect(await page.locator('.ghost-text-decoration').count()).toBe(0);
    }));

    it('retires ghost text during real EditContext composition and refuses multiple carets', async () => withEditor(async page => {
        await request(page, ' forbidden');
        await page.locator('.ghost-text-decoration').first().waitFor({ state: 'visible' });
        await page.locator('.native-edit-context').evaluate(node => {
            const context = (node as HTMLElement & { editContext: EventTarget }).editContext;
            context.dispatchEvent(new CompositionEvent('compositionstart'));
        });
        expect(await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().context.composing)).toBe(true);
        await expect.poll(() => page.locator('.ghost-text-decoration').count()).toBe(0);
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.read().text)).not.toContain('forbidden');
        await page.locator('.native-edit-context').evaluate(node => {
            const context = (node as HTMLElement & { editContext: EventTarget }).editContext;
            context.dispatchEvent(new CompositionEvent('compositionend'));
        });
        await page.locator('.native-edit-context').focus();
        await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.select([
            { selectionStartLineNumber: 1, selectionStartColumn: 1, positionLineNumber: 1, positionColumn: 1 },
            { selectionStartLineNumber: 1, selectionStartColumn: 3, positionLineNumber: 1, positionColumn: 3 },
        ]));
        await request(page, ' forbidden');
        expect(await page.locator('.ghost-text-decoration').count()).toBe(0);
    }));
});
