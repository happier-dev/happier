import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import type { MarkdownEditModeState } from './useMarkdownEditMode';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Heavy children replaced with markers so this node-env suite stays surface-free.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => {
    const React = await import('react');
    return {
        CodeEditor: React.forwardRef((props: any, ref: any) => {
            React.useImperativeHandle(ref, () => ({
                getValue: () => props.value,
                flushPendingChange: async () => undefined,
            }));
            return React.createElement('CodeEditor', props);
        }),
    };
});

vi.mock('@/components/ui/markdown/editor/RichMarkdownEditorPanel', async () => {
    const React = await import('react');
    return {
        RichMarkdownEditorPanel: (props: any) => {
            // Mirror the real panel: publish a CodeEditorHandle onto editorRef.current.
            const parentRef = props.editorRef;
            if (parentRef && typeof parentRef === 'object') {
                parentRef.current = {
                    getValue: () => props.value,
                    flushPendingChange: async () => undefined,
                };
            }
            // Mirror the controller publication contract: on mount call
            // onControllerChange with a stub controller, on unmount clear it.
            // The field uses this to decide whether to render the inline toolbar.
            React.useEffect(() => {
                if (typeof props.onControllerChange !== 'function') return;
                const controller = {
                    runCommand: () => undefined,
                    subscribeSelection: () => () => undefined,
                };
                props.onControllerChange(controller);
                return () => props.onControllerChange(null);
            }, [props.onControllerChange]);
            return React.createElement('RichMarkdownEditorPanel', props);
        },
    };
});

vi.mock('@/components/ui/markdown/editorChrome/MarkdownEditModeMenu', async () => {
    const React = await import('react');
    return { MarkdownEditModeMenu: (props: any) => React.createElement('MarkdownEditModeMenu', props) };
});

vi.mock('@/components/ui/markdown/editorChrome/MarkdownEditorToolbar', async () => {
    const React = await import('react');
    return { MarkdownEditorToolbar: (props: any) => React.createElement('MarkdownEditorToolbar', props) };
});

// Drive the field's branching deterministically via a mocked hook.
const hookState = vi.hoisted(() => ({
    value: {
        markdownEditMode: 'rich',
        richEligible: true,
        richDisabledReason: undefined,
        resetKey: 'base:rich:0',
        showToggle: true,
        onToggle: vi.fn(async () => undefined),
        onUnavailable: vi.fn(),
    } as unknown as MarkdownEditModeState,
}));

vi.mock('./useMarkdownEditMode', () => ({
    useMarkdownEditMode: () => hookState.value,
}));

import { MarkdownCodeEditorField } from './MarkdownCodeEditorField';

function setHook(overrides: Partial<MarkdownEditModeState>) {
    hookState.value = { ...hookState.value, ...overrides } as MarkdownEditModeState;
}

beforeEach(() => {
    setHook({
        markdownEditMode: 'rich',
        richEligible: true,
        richDisabledReason: undefined,
        resetKey: 'base:rich:0',
        showToggle: true,
    });
});

describe('MarkdownCodeEditorField', () => {
    it('renders the rich panel when mode is rich and the value is eligible', async () => {
        const { tree } = await renderScreen(
            <MarkdownCodeEditorField value="# Doc" onChange={vi.fn()} resetKey="base" language="markdown" />,
        );
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType('CodeEditor' as any).length).toBe(0);
    });

    it('renders the raw CodeEditor when mode is raw', async () => {
        setHook({ markdownEditMode: 'raw', resetKey: 'base:raw:0' });
        const { tree } = await renderScreen(
            <MarkdownCodeEditorField value="# Doc" onChange={vi.fn()} resetKey="base" language="markdown" />,
        );
        expect(tree.findAllByType('CodeEditor' as any).length).toBe(1);
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(0);
    });

    it('renders the raw CodeEditor when mode is rich but the value is ineligible', async () => {
        setHook({ richEligible: false, richDisabledReason: 'footnotes' });
        const { tree } = await renderScreen(
            <MarkdownCodeEditorField value="# Doc" onChange={vi.fn()} resetKey="base" language="markdown" />,
        );
        expect(tree.findAllByType('CodeEditor' as any).length).toBe(1);
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(0);
    });

    it('shows the Raw/Rich menu only when the hook reports showToggle', async () => {
        const visible = await renderScreen(
            <MarkdownCodeEditorField value="# Doc" onChange={vi.fn()} resetKey="base" language="markdown" />,
        );
        expect(visible.tree.findAllByType('MarkdownEditModeMenu' as any).length).toBe(1);

        setHook({ showToggle: false });
        const hidden = await renderScreen(
            <MarkdownCodeEditorField value="# Doc" onChange={vi.fn()} resetKey="base" language="markdown" />,
        );
        expect(hidden.tree.findAllByType('MarkdownEditModeMenu' as any).length).toBe(0);
    });

    it('forwards the composite resetKey to the active surface', async () => {
        const { tree } = await renderScreen(
            <MarkdownCodeEditorField value="# Doc" onChange={vi.fn()} resetKey="base" language="markdown" />,
        );
        expect(tree.findByType('RichMarkdownEditorPanel' as any).props.resetKey).toBe('base:rich:0');
    });

    it('forwards the active surface handle onto the parent editorRef (rich)', async () => {
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <MarkdownCodeEditorField value="# Doc" onChange={vi.fn()} resetKey="base" language="markdown" editorRef={editorRef} />,
        );
        expect(editorRef.current).not.toBeNull();
        expect(editorRef.current?.getValue()).toBe('# Doc');
    });

    it('forwards the raw surface handle onto the parent editorRef (raw)', async () => {
        setHook({ markdownEditMode: 'raw', resetKey: 'base:raw:0' });
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <MarkdownCodeEditorField value="raw content" onChange={vi.fn()} resetKey="base" language="markdown" editorRef={editorRef} />,
        );
        expect(editorRef.current).not.toBeNull();
        expect(editorRef.current?.getValue()).toBe('raw content');
    });

    it('renders an inline header toolbar to the left of the dropdown in rich mode', async () => {
        const { tree } = await renderScreen(
            <MarkdownCodeEditorField value="# Doc" onChange={vi.fn()} resetKey="base" language="markdown" />,
        );
        const toolbars = tree.findAllByType('MarkdownEditorToolbar' as any);
        expect(toolbars.length).toBe(1);
        expect(toolbars[0].props.variant).toBe('inline');
        // The rich panel is asked NOT to render its own footer toolbar (the field
        // hosts the inline one in its header instead — no double chrome).
        const panel = tree.findByType('RichMarkdownEditorPanel' as any);
        expect(panel.props.hideFooterToolbar).toBe(true);
    });

    it('does not render an inline toolbar in raw mode', async () => {
        setHook({ markdownEditMode: 'raw', resetKey: 'base:raw:0' });
        const { tree } = await renderScreen(
            <MarkdownCodeEditorField value="raw content" onChange={vi.fn()} resetKey="base" language="markdown" />,
        );
        expect(tree.findAllByType('MarkdownEditorToolbar' as any).length).toBe(0);
    });

    it('does not render an inline toolbar when rich is ineligible (raw is shown)', async () => {
        setHook({ richEligible: false, richDisabledReason: 'footnotes' });
        const { tree } = await renderScreen(
            <MarkdownCodeEditorField value="# Doc" onChange={vi.fn()} resetKey="base" language="markdown" />,
        );
        expect(tree.findAllByType('MarkdownEditorToolbar' as any).length).toBe(0);
    });

    it('does not render an inline toolbar when readOnly', async () => {
        const { tree } = await renderScreen(
            <MarkdownCodeEditorField value="# Doc" onChange={vi.fn()} resetKey="base" language="markdown" readOnly />,
        );
        expect(tree.findAllByType('MarkdownEditorToolbar' as any).length).toBe(0);
    });
});
