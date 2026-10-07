// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { describe, expect, it, vi } from 'vitest';

import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import type { MarkdownEditorController, MarkdownSelectionState } from './markdownEditorTypes';
import { RichMarkdownEditorPanel } from './RichMarkdownEditorPanel';

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
    return { ready: false, pending, release, current: null as Editor | null };
});

// Delay only the third-party engine boundary. Once admitted, its actual hook,
// editor, DOM, commands and events run unchanged.
vi.mock('@tiptap/react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@tiptap/react')>();
    return {
        ...actual,
        useEditor(...args: Parameters<typeof actual.useEditor>) {
            if (!engine.ready) throw engine.pending;
            const editor = actual.useEditor(...args);
            engine.current = editor;
            return editor;
        },
    };
});

describe('rich markdown ready-panel boundary (web)', () => {
    it('admits the latest draft and live controller together, retaining the editor on updates', async () => {
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
