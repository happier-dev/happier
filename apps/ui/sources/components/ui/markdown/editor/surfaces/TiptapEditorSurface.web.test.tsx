import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import type { MarkdownSelectionState } from '../markdownEditorTypes';
import { createEditorDocumentHistory } from '@/components/ui/code/editor/editorDocumentHistory';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A lightweight stand-in for a live TipTap `Editor`.
 *
 * Mirrors the Monaco surface test strategy (mock the heavy editor engine at the
 * boundary, exercise the surface's own ref/debounce/handle/controller logic).
 * The fake records the markdown it was seeded with, lets the test drive
 * `update`/`selectionUpdate` events, and reports a controllable markdown value
 * for `getMarkdown()`.
 */
type FakeEditorEvents = {
    update: Array<() => void>;
    selectionUpdate: Array<() => void>;
    transaction: Array<() => void>;
};

function createFakeEditor(initialMarkdown: string) {
    const events: FakeEditorEvents = { update: [], selectionUpdate: [], transaction: [] };
    const doc = (markdownValue: string) => ({ markdownValue, content: { size: Math.max(2, markdownValue.length + 2) },
        eq: (other: { markdownValue: string }) => other.markdownValue === markdownValue });
    const editor: any = {
        markdownValue: initialMarkdown,
        destroyed: false,
        focusCalled: 0,
        lastSetContent: null as unknown,
        lastSetTextSelection: null as unknown,
        state: {
            selection: { from: 1, to: 1 },
            doc: doc(initialMarkdown),
        },
        view: {
            dom: {
                parentElement: { scrollTop: 0, scrollLeft: 0 },
                style: { setProperty: () => undefined },
            },
        },
        on(name: keyof FakeEditorEvents, handler: () => void) {
            events[name].push(handler);
            return editor;
        },
        off() {
            return editor;
        },
        registerPlugin() {},
        unregisterPlugin() {},
        getMarkdown() {
            return editor.markdownValue;
        },
        getJSON() {
            return { type: 'doc', markdownValue: editor.markdownValue };
        },
        commands: {
            setContent: (content: unknown) => {
                editor.lastSetContent = content;
                const markdownValue = typeof content === 'object' && content !== null && 'markdownValue' in content
                    ? String(content.markdownValue ?? '')
                    : '';
                editor.state.doc = doc(markdownValue);
                return true;
            },
            setTextSelection: (selection: unknown) => {
                editor.lastSetTextSelection = selection;
                return true;
            },
            focus: () => {
                editor.focusCalled += 1;
                return true;
            },
        },
        setEditable: vi.fn(),
        isActive: () => false,
        destroy() {
            editor.destroyed = true;
        },
        // Helpers the test uses to drive events.
        __emitUpdate(nextMarkdown?: string, sameDocument = false) {
            if (typeof nextMarkdown === 'string') {
                editor.markdownValue = nextMarkdown;
                if (!sameDocument) editor.state.doc = doc(nextMarkdown);
            }
            for (const handler of events.update) handler();
        },
        __emitSelection() {
            for (const handler of events.selectionUpdate) handler();
        },
    };
    Object.defineProperty(editor.view, 'state', { get: () => ({ ...editor.state, schema: { nodes: {} } }) });
    return editor;
}

const editorState = vi.hoisted(() => ({
    current: null as any,
    selectionState: null as null | MarkdownSelectionState,
    lastCommand: null as unknown,
    lastCommandOptions: null as any,
    runCommandSpy: null as any,
}));

vi.mock('react-native', async () => {
    const ReactLib = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const View = ReactLib.forwardRef((props: any, ref: any) => {
        ReactLib.useImperativeHandle(ref, () => ({}), []);
        return ReactLib.createElement('View', props, props.children);
    });
    return createReactNativeWebMock({ View });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const base = await createUnistylesMock();
    const { createThemeFixture } = await import('@/dev/testkit/fixtures/themeFixtures');
    const baseRuntime = base.useUnistyles().rt;
    const theme = createThemeFixture({
        dark: true,
        colors: {
            border: { default: '#303030' },
            text: { primary: '#f8f8f2', secondary: '#cfcfcf', tertiary: '#8a8a8a' },
            surface: { base: '#151515', inset: '#1f1f1f', elevated: '#101010' },
            state: { active: { foreground: '#58a6ff' } },
        },
    });
    return {
        ...base,
        useUnistyles: () => ({ theme, rt: baseRuntime }),
    };
});

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

vi.mock('@/components/ui/code/editor/codeEditorFontMetrics', () => ({
    resolveCodeEditorFontMetrics: () => ({ scale: 1, fontSize: 14, lineHeight: 22 }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@tiptap/react', () => ({
    useEditor: (_options: any) => editorState.current,
    EditorContent: (props: any) => React.createElement('EditorContent', props),
}));

vi.mock('../core/tiptap/markdownSerialization', () => ({
    markdownToDoc: (markdown: string) => ({ type: 'doc', markdownValue: markdown }),
    docToMarkdown: (doc: any) => (doc?.markdownValue ?? ''),
}));

vi.mock('../core/tiptap/markdownEditorCommands', () => ({
    runMarkdownEditorCommand: (...args: unknown[]) => {
        editorState.lastCommand = args[1];
        editorState.lastCommandOptions = args[2];
        if (editorState.runCommandSpy) editorState.runCommandSpy(...args);
    },
    readSelectionState: (_editor: any): MarkdownSelectionState =>
        editorState.selectionState ?? {
            marks: { bold: false, italic: false, strike: false, code: false },
            blockType: 'paragraph',
            isLinkActive: false,
            canUndo: false,
            canRedo: false,
        },
    readActiveLinkHref: (_editor: unknown): string | undefined => undefined,
}));

import { TiptapEditorSurface } from './TiptapEditorSurface.web';

beforeEach(() => {
    editorState.current = null;
    editorState.selectionState = null;
    editorState.lastCommand = null;
    editorState.lastCommandOptions = null;
    editorState.runCommandSpy = vi.fn();
});

describe('TiptapEditorSurface (web)', () => {
    it('notifies the host after the delayed engine and its focus handle are ready', async () => {
        const ref = React.createRef<import('../MarkdownEditor').MarkdownEditorSurfaceRef>();
        const onReady = vi.fn(() => ref.current?.focus?.());
        const props = { resetKey: 'delayed-focus', value: '', onChange: vi.fn(), onReady };
        const screen = await renderScreen(<TiptapEditorSurface {...props} ref={ref} />);
        expect(onReady).not.toHaveBeenCalled();
        const editor = createFakeEditor('');
        editorState.current = editor;
        await screen.update(<TiptapEditorSurface {...props} ref={ref} />);
        expect(editor.focusCalled).toBe(1);
        await screen.update(<TiptapEditorSurface {...props} ref={ref} value="updated" />);
        expect(editor.focusCalled).toBe(1);
        await screen.unmount();
    });

    it('flushes pending rich edits before shared Undo and publishes exact source bytes with history metadata', async () => {
        const editor = createFakeEditor('original');
        editorState.current = editor;
        const history = createEditorDocumentHistory();
        let value = 'original';
        const onChange = vi.fn((next: string, change?: { history: 'undo' | 'redo' }) => {
            if (!change) history.record(value, next);
            value = next;
        });
        const ref = React.createRef<import('./TiptapWebViewSurface.native').MarkdownEditorSurfaceRef>();
        await renderScreen(<TiptapEditorSurface ref={ref} resetKey="shared-history" value="original" onChange={onChange} changeDebounceMs={500} history={history} />);
        await act(async () => { editor.__emitUpdate('pending rich edit'); });
        await act(async () => { ref.current!.runTextCommand!('undo'); });
        expect(onChange.mock.calls).toEqual([['pending rich edit'], ['original', { history: 'undo' }]]);
        expect(ref.current!.getValue()).toBe('original');
        expect(history.getSnapshot()).toEqual({ canUndo: false, canRedo: true });
    });
    it('renders and is not dirty on mount: getValue() === seed and no onChange (R-A7)', async () => {
        const editor = createFakeEditor('# Seed');
        editorState.current = editor;
        const onChange = vi.fn();
        const ref = React.createRef<any>();

        await renderScreen(
            React.createElement(TiptapEditorSurface, {
                ref,
                resetKey: '1',
                value: '# Seed',
                onChange,
            }),
        );

        // Seeding the editor must not fire onChange.
        await act(async () => {
            editor.__emitUpdate('# Seed');
            await flushHookEffects();
        });

        expect(onChange).toHaveBeenCalledTimes(0);
        expect(ref.current.getValue()).toBe('# Seed');
    });

    it('does not read the serializer\'s trailing blank line after a list as a user edit of an unedited document', async () => {
        const seed = '# Guide\n\n- one\n- two\n';
        const editor = createFakeEditor(seed);
        editorState.current = editor;
        const onChange = vi.fn();

        await renderScreen(
            React.createElement(TiptapEditorSurface, { resetKey: '1', value: seed, onChange, changeDebounceMs: 0 }),
        );

        await act(async () => {
            editor.__emitUpdate(`${seed}\n`, true);
            await flushHookEffects();
        });
        expect(onChange).toHaveBeenCalledTimes(0);

        await act(async () => {
            editor.__emitUpdate('# Guide\n\n- one\n- two\n- three\n\n');
            await flushHookEffects();
        });
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('emits onChange(markdown) on a real user edit', async () => {
        const editor = createFakeEditor('hello');
        editorState.current = editor;
        const onChange = vi.fn();

        await renderScreen(
            React.createElement(TiptapEditorSurface, {
                resetKey: '1',
                value: 'hello',
                onChange,
                changeDebounceMs: 0,
            }),
        );

        await act(async () => {
            editor.__emitUpdate('hello world');
            await flushHookEffects();
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith('hello world');
    });

    it('debounces onChange and flushes pending change via the handle', async () => {
        const editor = createFakeEditor('start');
        editorState.current = editor;
        const onChange = vi.fn();
        const ref = React.createRef<any>();

        await renderScreen(
            React.createElement(TiptapEditorSurface, {
                ref,
                resetKey: '1',
                value: 'start',
                onChange,
                changeDebounceMs: 1000,
            }),
        );

        await act(async () => {
            editor.__emitUpdate('a');
            editor.__emitUpdate('ab');
            await flushHookEffects();
        });

        expect(onChange).toHaveBeenCalledTimes(0);

        await act(async () => {
            await ref.current.flushPendingChange();
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith('ab');
    });

    it('keeps unflushed local edits when an external value arrives mid-typing (flushes instead of replacing the doc)', async () => {
        const editor = createFakeEditor('seed');
        editorState.current = editor;
        const onChange = vi.fn();

        const screen = await renderScreen(
            React.createElement(TiptapEditorSurface, {
                resetKey: '1',
                value: 'seed',
                onChange,
                changeDebounceMs: 100,
            }),
        );

        await act(async () => {
            editor.__emitUpdate('local draft');
            await flushHookEffects();
        });

        await act(async () => {
            await screen.update(
                React.createElement(TiptapEditorSurface, {
                    resetKey: '1',
                    value: 'external seed',
                    onChange,
                    changeDebounceMs: 100,
                }),
            );
        });
        await flushHookEffects();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 125));
        });

        // The user's unflushed local edit is the source of truth: the stale/racing
        // external value must not replace the document (that resets the cursor and
        // loses keystrokes). The pending change is flushed upward so the parent
        // state converges to the editor instead.
        expect(editor.lastSetContent).toBeNull();
        expect(onChange).toHaveBeenCalledWith('local draft');
    });

    it('runs a command through the controller exposed on the ref', async () => {
        const editor = createFakeEditor('x');
        editorState.current = editor;
        const ref = React.createRef<any>();

        await renderScreen(
            React.createElement(TiptapEditorSurface, {
                ref,
                resetKey: '1',
                value: 'x',
                onChange: vi.fn(),
            }),
        );

        // The ref merges the imperative handle + the controller (R-A: web + native
        // expose the same combined ref so the integration is identical).
        expect(typeof ref.current.getValue).toBe('function');
        expect(typeof ref.current.runCommand).toBe('function');
        expect(typeof ref.current.subscribeSelection).toBe('function');

        await act(async () => {
            ref.current.runCommand({ kind: 'toggleBold' });
        });

        expect(editorState.lastCommand).toEqual({ kind: 'toggleBold' });
    });

    it('notifies selection subscribers with link metadata on transactions', async () => {
        const editor = createFakeEditor('x');
        editorState.current = editor;
        editorState.selectionState = {
            marks: { bold: true, italic: false, strike: false, code: false },
            blockType: 'paragraph',
            isLinkActive: true,
            linkHref: 'https://example.com',
            canUndo: true,
            canRedo: false,
        };
        const ref = React.createRef<any>();

        await renderScreen(
            React.createElement(TiptapEditorSurface, {
                ref,
                resetKey: '1',
                value: 'x',
                onChange: vi.fn(),
                changeDebounceMs: 0,
            }),
        );

        const received: MarkdownSelectionState[] = [];
        let unsubscribe: (() => void) | undefined;
        await act(async () => {
            unsubscribe = ref.current.subscribeSelection((state: MarkdownSelectionState) => {
                received.push(state);
            });
            editor.__emitSelection();
            await flushHookEffects();
        });

        const last = received[received.length - 1];
        expect(last.isLinkActive).toBe(true);
        expect(last.linkHref).toBe('https://example.com');
        expect(last.marks.bold).toBe(true);
        unsubscribe?.();
    });

    it('hands subscribers the same selection state while typing leaves it unchanged, so the toolbar is not re-rendered per key', async () => {
        const editor = createFakeEditor('x');
        editorState.current = editor;
        const ref = React.createRef<any>();
        await renderScreen(
            React.createElement(TiptapEditorSurface, { ref, resetKey: '1', value: 'x', onChange: vi.fn(), changeDebounceMs: 0 }),
        );
        const received: MarkdownSelectionState[] = [];
        await act(async () => {
            ref.current.subscribeSelection((state: MarkdownSelectionState) => { received.push(state); });
            for (let key = 0; key < 3; key += 1) editor.__emitSelection();
            await flushHookEffects();
        });
        expect(received.length).toBeGreaterThanOrEqual(3);
        expect(new Set(received).size).toBe(1);
    });

    it('preserves selection and scroll while syncing external value changes', async () => {
        const editor = createFakeEditor('seed content');
        editor.state.selection = { from: 7, to: 7 };
        editor.view.dom.parentElement.scrollTop = 80;
        editor.view.dom.parentElement.scrollLeft = 6;
        editorState.current = editor;
        const onChange = vi.fn();
        const screen = await renderScreen(
            React.createElement(TiptapEditorSurface, {
                resetKey: '1',
                value: 'seed content',
                onChange,
                changeDebounceMs: 0,
            }),
        );

        await act(async () => {
            await screen.update(
                React.createElement(TiptapEditorSurface, {
                    resetKey: '1',
                    value: 'external content update',
                    onChange,
                    changeDebounceMs: 0,
                }),
            );
            await flushHookEffects();
        });

        expect(editor.lastSetTextSelection).toEqual({ from: 7, to: 7 });
        expect(editor.view.dom.parentElement.scrollTop).toBe(80);
        expect(editor.view.dom.parentElement.scrollLeft).toBe(6);
        expect(onChange).toHaveBeenCalledTimes(0);
    });

    it('syncs external value changes without firing onChange', async () => {
        const editor = createFakeEditor('seed');
        editorState.current = editor;
        const onChange = vi.fn();
        const screen = await renderScreen(
            React.createElement(TiptapEditorSurface, {
                resetKey: '1',
                value: 'seed',
                onChange,
                changeDebounceMs: 0,
            }),
        );

        await act(async () => {
            await screen.update(
                React.createElement(TiptapEditorSurface, {
                    resetKey: '1',
                    value: 'external update',
                    onChange,
                    changeDebounceMs: 0,
                }),
            );
            await flushHookEffects();
        });

        // External value change pushes content into the editor without emitting.
        expect(editor.lastSetContent).toEqual({ type: 'doc', markdownValue: 'external update' });
        expect(onChange).toHaveBeenCalledTimes(0);
    });

    it('falls back to a TextInput before the editor is ready', async () => {
        editorState.current = null; // useEditor returns null -> not ready yet.
        const onChange = vi.fn();

        const result = await renderScreen(
            React.createElement(TiptapEditorSurface, {
                resetKey: '1',
                value: 'fallback content',
                onChange,
            }),
        );

        const inputs = result.tree.root.findAllByType('TextInput' as any);
        expect(inputs.length).toBeGreaterThan(0);
        expect(inputs[0].props.value).toBe('fallback content');
    });
});
