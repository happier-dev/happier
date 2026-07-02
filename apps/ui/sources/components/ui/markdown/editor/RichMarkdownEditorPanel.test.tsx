import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import type {
    MarkdownEditorController,
    MarkdownEditorProps,
} from '@/components/ui/markdown/editor/markdownEditorTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

// The panel reads the active theme via `useUnistyles()` for its frontmatter
// banner; supply a real theme fixture so banner tokens resolve.
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', async () => {
    const React = await import('react');
    type MockTextProps = React.PropsWithChildren<Record<string, unknown>>;
    return {
        Text: (props: MockTextProps) => React.createElement('Text', props as React.Attributes & MockTextProps),
    };
});

// Capture the props/ref handed to the (heavy) MarkdownEditor surface so we can
// assert the panel wires the handle + controller + value/resetKey correctly,
// without booting TipTap/Monaco/WebView in node env.
const editorSpy = vi.hoisted(() => ({
    lastProps: null as MarkdownEditorProps | null,
    onChange: null as ((v: string) => void) | null,
    onUnavailable: null as ((v: string) => void) | null,
    value: '',
    selectionCallbacks: new Set<(state: any) => void>(),
    menuTriggerCallbacks: new Set<(state: any) => void>(),
    linkBubbleCallbacks: new Set<(state: any) => void>(),
}));

vi.mock('@/components/ui/markdown/editor/MarkdownEditor', async () => {
    const React = await import('react');
    const MarkdownEditor = React.forwardRef<any, MarkdownEditorProps>((props, ref) => {
        editorSpy.lastProps = props;
        editorSpy.onChange = props.onChange;
        editorSpy.onUnavailable = props.onUnavailable ?? null;
        editorSpy.value = props.value;
        React.useImperativeHandle(ref, () => ({
            getValue: () => editorSpy.value,
            flushPendingChange: vi.fn(async () => undefined),
            runCommand: vi.fn(),
            subscribeSelection: (cb: (state: any) => void) => {
                editorSpy.selectionCallbacks.add(cb);
                return () => editorSpy.selectionCallbacks.delete(cb);
            },
            subscribeMenuTrigger: (cb: (state: any) => void) => {
                editorSpy.menuTriggerCallbacks.add(cb);
                return () => editorSpy.menuTriggerCallbacks.delete(cb);
            },
            runMenuCommand: vi.fn(),
            subscribeEditorViewportLayout: vi.fn(() => () => {}),
            measureEditorViewportInWindow: vi.fn(async () => null),
            subscribeLinkBubble: (cb: (state: any) => void) => {
                editorSpy.linkBubbleCallbacks.add(cb);
                return () => editorSpy.linkBubbleCallbacks.delete(cb);
            },
        }));
        return null;
    });
    MarkdownEditor.displayName = 'MarkdownEditorMock';
    return { MarkdownEditor };
});

// Capture the controller the toolbar receives.
const toolbarSpy = vi.hoisted(() => ({
    controller: null as MarkdownEditorController | null,
    renderCount: 0,
}));
vi.mock('@/components/ui/markdown/editorChrome/MarkdownEditorToolbar', () => ({
    MarkdownEditorToolbar: (props: { controller: MarkdownEditorController }) => {
        toolbarSpy.renderCount += 1;
        toolbarSpy.controller = props.controller;
        return null;
    },
}));

const commandMenuSpy = vi.hoisted(() => ({
    props: null as null | {
        open: boolean;
        testID?: string;
        onSelect: (...args: any[]) => void;
    },
}));
vi.mock('@/components/ui/commandMenu', () => ({
    CommandMenu: (props: { open: boolean; testID?: string; onSelect: (...args: any[]) => void }) => {
        commandMenuSpy.props = props;
        return null;
    },
}));

const linkBubbleSpy = vi.hoisted(() => ({
    props: null as null | {
        open: boolean;
        testID?: string;
        onSetLink: (href: string) => void;
    },
}));
vi.mock('@/components/ui/linkBubble', () => ({
    LinkBubble: (props: { open: boolean; testID?: string; onSetLink: (href: string) => void }) => {
        linkBubbleSpy.props = props;
        return null;
    },
}));

const slashHookSpy = vi.hoisted(() => ({
    controller: null as MarkdownEditorController | null,
}));
vi.mock('@/components/ui/markdown/editor/slash/useMarkdownSlashMenu', () => ({
    useMarkdownSlashMenu: (controller: MarkdownEditorController | null) => {
        slashHookSpy.controller = controller;
        return {
            open: true,
            anchor: { kind: 'rect', rect: { left: 1, top: 2, height: 3 } },
            query: '',
            items: [],
            selectedIndex: -1,
            onMoveUp: vi.fn(),
            onMoveDown: vi.fn(),
            onSelect: vi.fn(),
            onRequestClose: vi.fn(),
        };
    },
}));

const linkHookSpy = vi.hoisted(() => ({
    controller: null as MarkdownEditorController | null,
}));
vi.mock('@/components/ui/markdown/editor/linkBubble/useMarkdownLinkBubble', () => ({
    useMarkdownLinkBubble: (controller: MarkdownEditorController | null) => {
        linkHookSpy.controller = controller;
        return {
            open: true,
            anchor: { kind: 'rect', rect: { left: 4, top: 5, height: 6 } },
            href: 'https://example.com',
            onOpenLink: vi.fn(),
            onUnlink: vi.fn(),
            onSetLink: vi.fn(),
            onRequestClose: vi.fn(),
        };
    },
}));

import { RichMarkdownEditorPanel } from './RichMarkdownEditorPanel';

describe('RichMarkdownEditorPanel', () => {
    beforeEach(() => {
        toolbarSpy.controller = null;
        toolbarSpy.renderCount = 0;
        commandMenuSpy.props = null;
        linkBubbleSpy.props = null;
        slashHookSpy.controller = null;
        linkHookSpy.controller = null;
    });

    it('forwards value and resetKey to the MarkdownEditor surface', async () => {
        const editorRef = React.createRef<CodeEditorHandle>() as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value="# Doc"
                onChange={vi.fn()}
            />,
        );

        expect(editorSpy.lastProps?.value).toBe('# Doc');
        expect(editorSpy.lastProps?.resetKey).toBe('rk-1');
    });

    it('exposes the surface handle on the parent editorRef as a CodeEditorHandle', async () => {
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value="# Doc"
                onChange={vi.fn()}
            />,
        );

        expect(editorRef.current).not.toBeNull();
        expect(typeof editorRef.current?.getValue).toBe('function');
        expect(typeof editorRef.current?.flushPendingChange).toBe('function');
        expect(editorRef.current?.getValue()).toBe('# Doc');
    });

    it('passes a controller (runCommand + subscribeSelection) to the toolbar', async () => {
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value="# Doc"
                onChange={vi.fn()}
            />,
        );

        expect(toolbarSpy.controller).not.toBeNull();
        expect(typeof toolbarSpy.controller?.runCommand).toBe('function');
        expect(typeof toolbarSpy.controller?.subscribeSelection).toBe('function');
    });

    it('does not render the toolbar when the editor is read-only', async () => {
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value="# Doc"
                onChange={vi.fn()}
                readOnly
            />,
        );

        expect(toolbarSpy.renderCount).toBe(0);
        expect(toolbarSpy.controller).toBeNull();
    });

    it('does not render the footer toolbar when hideFooterToolbar is set', async () => {
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value="# Doc"
                onChange={vi.fn()}
                hideFooterToolbar
            />,
        );

        // The footer toolbar is suppressed (an ancestor hosts an inline one),
        // but the controller is still published so the ancestor can drive it.
        expect(toolbarSpy.renderCount).toBe(0);
    });

    it('publishes the controller to onControllerChange on mount and clears it on unmount', async () => {
        const onControllerChange = vi.fn();
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        const { unmount } = await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value="# Doc"
                onChange={vi.fn()}
                onControllerChange={onControllerChange}
            />,
        );

        // Published the controller on mount.
        expect(onControllerChange).toHaveBeenCalledTimes(1);
        const controller = onControllerChange.mock.calls[0][0];
        expect(controller).not.toBeNull();
        expect(typeof controller.runCommand).toBe('function');
        expect(typeof controller.subscribeSelection).toBe('function');

        await unmount();
        // Cleared the controller on unmount.
        expect(onControllerChange).toHaveBeenLastCalledWith(null);
    });

    it('passes through slash-menu and link-bubble controller methods to the surface', async () => {
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value="# Doc"
                onChange={vi.fn()}
            />,
        );

        expect(slashHookSpy.controller).not.toBeNull();
        expect(linkHookSpy.controller).not.toBeNull();
        expect(typeof slashHookSpy.controller?.subscribeMenuTrigger).toBe('function');
        expect(typeof slashHookSpy.controller?.runMenuCommand).toBe('function');
        expect(typeof slashHookSpy.controller?.subscribeEditorViewportLayout).toBe('function');
        expect(typeof linkHookSpy.controller?.subscribeLinkBubble).toBe('function');
    });

    it('renders the markdown slash menu and link bubble surfaces', async () => {
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value="# Doc"
                onChange={vi.fn()}
            />,
        );

        expect(commandMenuSpy.props?.testID).toBe('markdown-slash-menu');
        expect(linkBubbleSpy.props?.testID).toBe('markdown-link-bubble');
    });

    it('forwards onChange from the surface up to the parent', async () => {
        const onChange = vi.fn();
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value="# Doc"
                onChange={onChange}
            />,
        );

        await act(async () => {
            editorSpy.onChange?.('# Edited');
        });
        expect(onChange).toHaveBeenCalledWith('# Edited');
    });

    it('forwards onUnavailable from the surface up to the parent (R-A17)', async () => {
        const onUnavailable = vi.fn();
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value="# Doc"
                onChange={vi.fn()}
                onUnavailable={onUnavailable}
            />,
        );

        await act(async () => {
            editorSpy.onUnavailable?.('# Latest');
        });
        expect(onUnavailable).toHaveBeenCalledWith('# Latest');
    });

    // --- S1: frontmatter strip / reattach ---------------------------------

    const FRONTMATTER = '---\ntitle: Doc\ntags: [a, b]\n---\n';
    const BODY = '# Heading\n\nbody text\n';
    const FULL_DOC = FRONTMATTER + BODY;

    it('seeds the editor with the body only when the doc has YAML frontmatter (S1)', async () => {
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value={FULL_DOC}
                onChange={vi.fn()}
            />,
        );

        // The surface must never see the frontmatter — only the body.
        expect(editorSpy.lastProps?.value).toBe(BODY);
    });

    it('reattaches frontmatter byte-identically via the published getValue (S1)', async () => {
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value={FULL_DOC}
                onChange={vi.fn()}
            />,
        );

        // The surface mock mirrors its seed as getValue(); the panel's published
        // handle must reattach the frontmatter so save sees the FULL doc.
        expect(editorRef.current?.getValue()).toBe(FULL_DOC);
    });

    it('reattaches frontmatter on onChange before it reaches the parent (S1)', async () => {
        const onChange = vi.fn();
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value={FULL_DOC}
                onChange={onChange}
            />,
        );

        await act(async () => {
            editorSpy.onChange?.('# Edited body\n');
        });
        expect(onChange).toHaveBeenCalledWith(FRONTMATTER + '# Edited body\n');
    });

    it('reattaches frontmatter on the native onUnavailable fallback (S1)', async () => {
        const onUnavailable = vi.fn();
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value={FULL_DOC}
                onChange={vi.fn()}
                onUnavailable={onUnavailable}
            />,
        );

        await act(async () => {
            editorSpy.onUnavailable?.('# Edited body\n');
        });
        expect(onUnavailable).toHaveBeenCalledWith(FRONTMATTER + '# Edited body\n');
    });

    it('renders the frontmatter read-only banner when frontmatter is present (S1)', async () => {
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        const { tree } = await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value={FULL_DOC}
                onChange={vi.fn()}
            />,
        );

        const banner = tree.root.findAll(
            (node) => node.props?.testID === 'file-details-rich-editor-frontmatter',
        );
        expect(banner.length).toBe(1);
    });

    it('does not render the banner and forwards the full value when there is no frontmatter (S1)', async () => {
        const editorRef = { current: null } as React.MutableRefObject<CodeEditorHandle | null>;
        const { tree } = await renderScreen(
            <RichMarkdownEditorPanel
                resetKey="rk-1"
                editorRef={editorRef}
                value={BODY}
                onChange={vi.fn()}
            />,
        );

        const banner = tree.root.findAll(
            (node) => node.props?.testID === 'file-details-rich-editor-frontmatter',
        );
        expect(banner.length).toBe(0);
        expect(editorSpy.lastProps?.value).toBe(BODY);
        expect(editorRef.current?.getValue()).toBe(BODY);
    });
});
