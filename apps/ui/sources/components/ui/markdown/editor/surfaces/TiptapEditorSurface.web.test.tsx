import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import type { MarkdownSelectionState } from '../markdownEditorTypes';

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
    const editor: any = {
        markdownValue: initialMarkdown,
        destroyed: false,
        focusCalled: 0,
        lastSetContent: null as unknown,
        on(name: keyof FakeEditorEvents, handler: () => void) {
            events[name].push(handler);
            return editor;
        },
        off() {
            return editor;
        },
        getMarkdown() {
            return editor.markdownValue;
        },
        getJSON() {
            return { type: 'doc', markdownValue: editor.markdownValue };
        },
        commands: {
            setContent: (content: unknown) => {
                editor.lastSetContent = content;
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
        __emitUpdate(nextMarkdown?: string) {
            if (typeof nextMarkdown === 'string') {
                editor.markdownValue = nextMarkdown;
            }
            for (const handler of events.update) handler();
        },
        __emitSelection() {
            for (const handler of events.selectionUpdate) handler();
        },
    };
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
    const baseRuntime = base.useUnistyles().rt;
    const theme = {
        dark: true,
        colors: {
            border: { default: '#303030' },
            text: { primary: '#f8f8f2', secondary: '#cfcfcf', tertiary: '#8a8a8a' },
            surface: { base: '#151515', inset: '#1f1f1f', elevated: '#101010' },
            state: { active: { foreground: '#58a6ff' } },
        },
    };
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

    it('opens an active link via window.open with noopener,noreferrer on web', async () => {
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

        // Drive the openLink command through the controller; the surface wires its
        // own opener (window.open) into the command registry options.
        await act(async () => {
            ref.current.runCommand({ kind: 'openLink' });
        });

        const opener = editorState.lastCommandOptions?.openLink as ((href: string) => void) | undefined;
        expect(typeof opener).toBe('function');

        // Provide a window.open spy and invoke the captured opener.
        const openSpy = vi.fn();
        const priorWindow = (globalThis as any).window;
        (globalThis as any).window = { open: openSpy };
        try {
            opener?.('https://example.com/page');
        } finally {
            if (priorWindow === undefined) {
                delete (globalThis as any).window;
            } else {
                (globalThis as any).window = priorWindow;
            }
        }

        expect(openSpy).toHaveBeenCalledWith('https://example.com/page', '_blank', 'noopener,noreferrer');
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

    it('passes readOnly through to the editor editability', async () => {
        const editor = createFakeEditor('x');
        editorState.current = editor;

        await renderScreen(
            React.createElement(TiptapEditorSurface, {
                resetKey: '1',
                value: 'x',
                onChange: vi.fn(),
                readOnly: true,
            }),
        );

        await act(async () => {
            await flushHookEffects();
        });

        expect(editor.setEditable).toHaveBeenCalledWith(false);
    });

    it('syncs external value changes without firing onChange', async () => {
        const editor = createFakeEditor('seed');
        editorState.current = editor;
        const onChange = vi.fn();
        let tree: any;

        tree = (await renderScreen(
            React.createElement(TiptapEditorSurface, {
                resetKey: '1',
                value: 'seed',
                onChange,
                changeDebounceMs: 0,
            }),
        )).tree;

        await act(async () => {
            tree.update(
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
