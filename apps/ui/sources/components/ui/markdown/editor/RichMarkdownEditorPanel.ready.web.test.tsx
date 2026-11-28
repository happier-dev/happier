// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { describe, expect, it, vi } from 'vitest';

import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import type { MarkdownEditorController, MarkdownSelectionState } from './markdownEditorTypes';
import { RichMarkdownEditorPanel } from './RichMarkdownEditorPanel';
import { CodeEditorWithFind } from '@/components/ui/code/editor/CodeEditorWithFind';
import { KeyboardShortcutProvider, useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { executeFindAction } from '@/keyboard/findActionRuntime';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { useMarkdownEditMode, type MarkdownEditModeState } from './useMarkdownEditMode';
import { storage } from '@/sync/domains/state/storageStore';
import { createEditorDocumentHistory } from '@/components/ui/code/editor/editorDocumentHistory';
import { CodeEditor } from '@/components/ui/code/editor/CodeEditor.web';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Select the real web platform/entry, as Metro does. No panel, controller,
// parser, store or formatting logic is replaced.
vi.mock('react-native', async () => import('react-native-web'));
vi.mock('@/components/ui/markdown/editor/MarkdownEditor', async () => import('./MarkdownEditor.web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const engine = vi.hoisted(() => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    return { ready: false, pending, release, current: null as Editor | null, deferCreation: false, sawNull: false };
});

// Delay only the third-party engine boundary. Once admitted, its actual hook,
// editor, DOM, commands and events run unchanged.
vi.mock('@tiptap/react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@tiptap/react')>();
    return {
        ...actual,
        useEditor(...args: Parameters<typeof actual.useEditor>) {
            if (!engine.ready) throw engine.pending;
            const editor = actual.useEditor({ ...args[0], ...(engine.deferCreation ? { immediatelyRender: false } : {}) }, args[1]);
            if (!editor) engine.sawNull = true;
            engine.current = editor;
            return editor;
        },
    };
});

describe('rich markdown ready-panel boundary (web)', () => {
    it('uses the full-document history for a raw frontmatter edit and subsequent rich body edits', async () => {
        engine.ready = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const original = '---\ntitle: Before\n---\n# Body\n';
        const draft = original.replace('Before', 'After');
        const history = createEditorDocumentHistory();
        history.record(original, draft);
        const editorRef = { current: null as TextEditorHandle | null };
        let text = draft;
        function Field() {
            return <RichMarkdownEditorPanel editorRef={editorRef} resetKey="full-document-history" value={draft} history={history}
                onChange={(next, change) => { if (!change) history.record(text, next); text = next; }} changeDebounceMs={500} hideFooterToolbar />;
        }
        try {
            await act(async () => root.render(<Field />));
            await act(async () => { await vi.dynamicImportSettled(); });
            expect('undo' in engine.current!.commands).toBe(false);
            await act(async () => {
                container.querySelector('.ProseMirror')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
            });
            expect(text).toBe(original);
            expect(editorRef.current?.getValue()).toBe(original);
            await act(async () => root.render(<Field />));
            expect(editorRef.current?.getValue()).toBe(original);
            const editor = engine.current!;
            await act(async () => { editor.commands.insertContentAt(1, 'Updated '); });
            await act(async () => { await editorRef.current?.flushPendingChange(); });
            const edited = text;
            expect(edited).toContain('Updated');
            await act(async () => { editorRef.current?.runCommand?.('undo'); });
            expect(text).toBe(original);
            await act(async () => { editorRef.current?.runCommand?.('redo'); });
            expect(text).toBe(edited);
            await act(async () => { editor.commands.insertContentAt(1, 'Pending '); });
            const pending = '---\ntitle: Before\n---\n' + editor.getMarkdown();
            const replacement = '---\ntitle: Replacement\n---\n# New body\n';
            await act(async () => { editorRef.current?.runCommand?.({ replaceDocument: replacement }); });
            expect(text).toBe(replacement);
            await act(async () => { editorRef.current?.runCommand?.('undo'); });
            expect(text).toBe(pending);
            await act(async () => { editorRef.current?.runCommand?.('undo'); });
            expect(text).toBe(edited);
            await act(async () => { editorRef.current?.runCommand?.('undo'); });
            expect(text).toBe(original);
        } finally { await act(async () => root.unmount()); container.remove(); }
    });
    it('retains one full-document history through real Raw and Rich mode switches', async () => {
        engine.ready = true;
        const originalSettings = storage.getState().settings;
        storage.setState({ settings: { ...originalSettings, experiments: true, markdownDefaultEditMode: 'rich',
            featureToggles: { ...originalSettings.featureToggles, 'files.editor': true, 'files.markdownRichEditor': true } } });
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const initial = '---\ntitle: Before\n---\n# Guide\n\n- one\n- two\n';
        const history = createEditorDocumentHistory();
        const editorRef = { current: null as TextEditorHandle | null };
        let mode: MarkdownEditModeState | null = null;
        let text = initial;
        const onChange = (next: string, change?: { history: 'undo' | 'redo' }) => {
            if (!change) history.record(text, next);
            text = next;
        };
        function Field() {
            // File hosts keep the seed stable; the mounted surface owns live bytes.
            mode = useMarkdownEditMode({ value: initial, language: 'markdown', baseResetKey: 'mode', editorHandleRef: editorRef, onValueChange: onChange });
            return mode.showRich ? <RichMarkdownEditorPanel editorRef={editorRef} resetKey={mode.resetKey}
                value={mode.seedText} onChange={onChange} history={history} changeDebounceMs={500} hideFooterToolbar />
                : <CodeEditor ref={handle => { editorRef.current = handle; }} resetKey={mode.resetKey}
                    value={mode.seedText} language="markdown" onChange={onChange} history={history} />;
        }
        const currentMode = () => { if (!mode) throw new Error('Mode owner not mounted'); return mode; };
        try {
            await act(async () => root.render(<KeyboardShortcutProvider handlers={{}}><Field /></KeyboardShortcutProvider>));
            await act(async () => { await vi.dynamicImportSettled(); });
            expect(currentMode().showRich).toBe(true);
            await act(async () => { await currentMode().onToggle('raw'); });
            expect(text).toBe(initial);
            expect(currentMode().markdownEditMode).toBe('raw');
            expect(container.querySelector('textarea')).not.toBeNull();
            const raw = initial.replace('Before', 'Raw');
            await act(async () => { editorRef.current!.runCommand!({ replaceDocument: raw }); });
            expect(text).toBe(raw);
            await act(async () => { await currentMode().onToggle('rich'); });
            await act(async () => { await vi.dynamicImportSettled(); });
            expect(text).toBe(raw);
            expect(currentMode().showRich).toBe(true);
            const editor = engine.current!;
            await act(async () => { editor.commands.insertContentAt(1, 'Rich '); });
            const edited = '---\ntitle: Raw\n---\n' + editor.getMarkdown();
            await act(async () => { await currentMode().onToggle('raw'); });
            expect(text).toBe(edited);
            expect(container.querySelector('textarea')?.value).toBe(edited);
            await act(async () => { editorRef.current!.runCommand!('undo'); });
            expect(text).toBe(raw);
            await act(async () => { editorRef.current!.runCommand!('undo'); });
            expect(text).toBe(initial);
            await act(async () => { editorRef.current!.runCommand!('redo'); });
            expect(text).toBe(raw);
            await act(async () => { await currentMode().onToggle('rich'); });
            await act(async () => { await vi.dynamicImportSettled(); });
            await act(async () => { editorRef.current!.runCommand!('redo'); });
            expect(text).toBe(edited);
            expect(editorRef.current!.getValue()).toBe(edited);
        } finally {
            await act(async () => root.unmount()); container.remove(); storage.setState({ settings: originalSettings });
        }
    });

    it('opens and searches the rich surface through the shared registered Find composition', async () => {
        engine.ready = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const editorRef = { current: null as TextEditorHandle | null };
        let open: ReturnType<typeof useFindSurfaceRuntime>['open'] = () => false;
        function Probe() { open = useFindSurfaceRuntime().open; return null; }
        const onChange = vi.fn();
        const value = '# Retries\n\nRetry **now**. Retry now.\n';
        try {
            await act(async () => root.render(<KeyboardShortcutProvider handlers={{}}>
                <PluginSurfaceFocusEligibilityProvider active><Probe /><CodeEditorWithFind
                    editorRef={editorRef} resetKey="rich-find" value={value} language="markdown" onChange={onChange} surfaceId="rich:file"
                    renderEditor={publish => <RichMarkdownEditorPanel editorRef={editorRef} onEditorHandleChange={publish}
                        resetKey="rich-find" value={value} onChange={onChange} hideFooterToolbar />}
                /></PluginSurfaceFocusEligibilityProvider>
            </KeyboardShortcutProvider>));
            await act(async () => { await vi.dynamicImportSettled(); });
            await act(async () => { expect(open('rich:file')).toBe(true); });
            expect(container.querySelector('[data-testid="file-editor-find"]')).not.toBeNull();
            await act(async () => {
                await executeFindAction({ actionId: 'ui.find', input: { op: 'set', query: 'Retry now' }, context: { surface: 'ui' } });
            });
            expect(editorRef.current?.find?.getSnapshot().status).toEqual({ kind: 'results', total: 2, current: 1, coverage: 'complete' });
            expect(container.querySelector('.ProseMirror')).not.toBeNull();
            expect(onChange).not.toHaveBeenCalled();
        } finally { await act(async () => root.unmount()); container.remove(); }
    });

    it('keeps the surface focus handle safe after its real editor is destroyed and focuses the replacement', async () => {
        engine.ready = true;
        engine.deferCreation = true;
        // jsdom has no Range layout API; keep real ranges/selection while
        // supplying only the browser geometry boundary used by focus scrolling.
        const createRange = document.createRange.bind(document);
        const rangeGeometry = vi.spyOn(document, 'createRange').mockImplementation(() => {
            const range = createRange();
            range.getClientRects = () => Object.assign([], { item: () => null });
            range.getBoundingClientRect = () => new DOMRect();
            return range;
        });
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const editorRef: React.MutableRefObject<CodeEditorHandle | null> = { current: null };
        const onChange = vi.fn();
        const render = (resetKey: string) => <RichMarkdownEditorPanel
            resetKey={resetKey} value="**Seed**" editorRef={editorRef} onChange={onChange} presentation="canvas"
        />;
        try {
            await act(async () => root.render(render('first')));
            await act(async () => { await vi.dynamicImportSettled(); });
            const first = engine.current;
            const handle = editorRef.current;
            if (!first || !handle?.focus) throw new Error('The real editor focus handle was not published');
            await act(async () => {
                handle.focus!();
                await vi.waitFor(() => expect(document.activeElement).toBe(first.view.dom));
            });
            await act(async () => {
                // The real SDK nulls commandManager on destroy. The surface can
                // still hold that instance until its replacement effect commits.
                first.destroy();
                expect(first.isDestroyed).toBe(true);
                expect(() => handle.focus!()).not.toThrow();
            });
            await act(async () => root.render(render('replacement')));
            const replacement = engine.current;
            if (!replacement || replacement === first) throw new Error('The editor was not replaced');
            expect(replacement.isDestroyed).toBe(false);
            await act(async () => {
                editorRef.current?.focus?.();
                await vi.waitFor(() => expect(document.activeElement).toBe(replacement.view.dom));
            });
            expect(editorRef.current?.getValue()).toContain('**Seed**');
            expect(onChange).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            container.remove();
            engine.deferCreation = false;
            rangeGeometry.mockRestore();
        }
    });

    it('mounts the footer before the editor exists and receives its first selection', async () => {
        engine.ready = true;
        engine.deferCreation = true;
        engine.sawNull = false;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const editorRef: React.MutableRefObject<CodeEditorHandle | null> = { current: null };
        const onChange = vi.fn();
        const readyValues: string[] = [];
        const onReady = () => { readyValues.push(editorRef.current?.getValue() ?? 'missing-handle'); };
        try {
            await act(async () => {
                root.render(<RichMarkdownEditorPanel resetKey="deferred" value="**Seed**" editorRef={editorRef} onChange={onChange} onReady={onReady} />);
            });
            // Commit the Suspense render before waiting for its lazy imports.
            await act(async () => {
                await vi.dynamicImportSettled();
            });
            expect(engine.sawNull).toBe(true);
            expect(container.querySelector('[data-testid="file-details-rich-editor-toolbar:bold"]')?.getAttribute('aria-pressed')).toBe('true');
            expect(editorRef.current?.getValue()).toContain('**Seed**');
            expect(readyValues).toEqual(['**Seed**']);
            expect(onChange).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            container.remove();
            engine.deferCreation = false;
        }
    });

    it.each(['framed', 'canvas'] as const)('keeps the %s toolbar safe before creation and during editor replacement', async (presentation) => {
        engine.ready = true;
        engine.deferCreation = true;
        engine.sawNull = false;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const editorRef: React.MutableRefObject<CodeEditorHandle | null> = { current: null };
        const onChange = vi.fn();
        const render = (resetKey: string, hideFooterToolbar: boolean) => <RichMarkdownEditorPanel
            resetKey={resetKey} value="**Seed**" editorRef={editorRef} onChange={onChange}
            presentation={presentation} hideFooterToolbar={hideFooterToolbar}
        />;
        try {
            await act(async () => {
                root.render(render('first', true));
                await vi.dynamicImportSettled();
            });
            expect(engine.sawNull).toBe(true);
            const first = engine.current;
            expect(first).not.toBeNull();
            // useEditor destroys the previous instance in its passive effect.
            // A newly mounted toolbar subscribes in that same commit, before
            // React processes the replacement editor snapshot.
            await act(async () => root.render(render('second', false)));
            expect(first?.isDestroyed).toBe(true);
            expect(engine.current).not.toBe(first);
            const bold = container.querySelector<HTMLElement>('[data-testid="file-details-rich-editor-toolbar:bold"]');
            expect(bold).not.toBeNull();
            expect(bold?.getAttribute('aria-pressed')).toBe('true');
            expect(editorRef.current?.getValue()).toContain('**Seed**');
            expect(onChange).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            container.remove();
            engine.deferCreation = false;
        }
    });

    it('admits the latest draft and live controller together, retaining the editor on updates', async () => {
        engine.ready = false;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const editorRef: React.MutableRefObject<CodeEditorHandle | null> = { current: null };
        const selections: MarkdownSelectionState[] = [];
        let controller: MarkdownEditorController | null = null;
        const getController = (): MarkdownEditorController | null => controller;
        let unsubscribe: (() => void) | undefined;
        const onControllerChange = vi.fn((next: MarkdownEditorController | null) => {
            controller = next;
            unsubscribe?.();
            unsubscribe = next?.subscribeSelection((state) => selections.push(state));
        });
        const onChange = vi.fn();
        const render = (value: string) => <RichMarkdownEditorPanel
            resetKey="draft" value={value} editorRef={editorRef} onChange={onChange}
            onControllerChange={onControllerChange} hideFooterToolbar changeDebounceMs={0}
        />;
        try {
            await act(async () => {
                root.render(render('---\ntitle: original\n---\n# Original'));
                await vi.dynamicImportSettled();
            });
            expect(container.querySelector('[data-testid="rich-markdown-editor-loading"]')).not.toBeNull();
            expect(editorRef.current).toBeNull();
            expect(onControllerChange).not.toHaveBeenCalled();

            await act(async () => root.render(render('---\ntitle: latest\n---\n# Latest')));
            await act(async () => {
                engine.ready = true;
                engine.release();
                await vi.dynamicImportSettled();
            });
            const editor = engine.current;
            const publishedController = getController();
            expect(editor).not.toBeNull();
            expect(publishedController).not.toBeNull();
            expect(editorRef.current).not.toBeNull();
            if (!editor || !publishedController || !editorRef.current) throw new Error('The ready editor/controller was not published');
            expect(container.querySelector('[data-testid="rich-markdown-editor-loading"]')).toBeNull();
            expect(editorRef.current.getValue()).toContain('title: latest');
            expect(editorRef.current.getValue()).toContain('# Latest');
            expect(onChange).not.toHaveBeenCalled();
            const content = container.querySelector<HTMLElement>('.ProseMirror');
            expect(content).not.toBeNull();

            await act(async () => {
                editor.commands.setTextSelection({ from: 1, to: 7 });
                publishedController.runCommand({ kind: 'toggleBold' });
            });
            expect(selections.at(-1)?.marks.bold).toBe(true);
            await act(async () => { await editorRef.current?.flushPendingChange(); });
            expect(onChange.mock.calls.at(-1)?.[0]).toContain('title: latest');
            const edited = editorRef.current.getValue();
            await act(async () => root.render(render(edited)));
            expect(engine.current).toBe(editor);
            expect(container.querySelector('.ProseMirror')).toBe(content);
            expect(controller).toBe(publishedController);
            expect(editorRef.current.getValue()).toBe(edited);
        } finally {
            unsubscribe?.();
            await act(async () => root.unmount());
            container.remove();
        }
        expect(editorRef.current).toBeNull();
        expect(controller).toBeNull();
    });
});
