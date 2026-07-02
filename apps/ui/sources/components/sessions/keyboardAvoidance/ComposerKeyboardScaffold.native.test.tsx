import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const scaffoldLayout = vi.hoisted(() => ({
    lastOptions: undefined as { availablePanelMaxHeight?: number; keyboardLiftSuppressed?: boolean } | undefined,
    measuredHeight: 0,
}));

const modalState = vi.hoisted(() => ({
    insideModalBoundary: false,
    suppressed: false,
}));

vi.mock('./useComposerKeyboardLayout.native', () => ({
    useComposerKeyboardLayout: (options: { availablePanelMaxHeight?: number; keyboardLiftSuppressed?: boolean } = {}) => {
        scaffoldLayout.lastOptions = options;
        const composerHeight = { value: scaffoldLayout.measuredHeight };
        return {
            availablePanelHeight: { value: 0 },
            bottomInset: { value: 0 },
            composerHeight,
            isKeyboardLiftSuppressed: { value: false },
            keyboardHeightForInset: { value: 0 },
            keyboardHeightLive: { value: 0 },
            keyboardProgress: { value: 0 },
            listBottomInset: { value: 0 },
            setComposerMeasuredHeight: (height: number) => {
                scaffoldLayout.measuredHeight = height;
                composerHeight.value = height;
            },
        };
    },
}));

vi.mock('@/modal', () => ({
    useOptionalModal: () => ({
        isKeyboardLiftSuppressedByModal: modalState.suppressed,
        state: { modals: modalState.suppressed ? [{ id: 'modal', type: 'custom' }] : [] },
    }),
}));

vi.mock('@/modal/context/ModalBoundaryContext', () => ({
    useIsInsideModalBoundary: () => modalState.insideModalBoundary,
}));

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        __esModule: true,
        default: {
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('AnimatedView', props, props.children),
        },
        useAnimatedStyle: (factory: () => unknown) => factory(),
    };
});

describe('ComposerKeyboardScaffold native', () => {
    beforeEach(() => {
        modalState.insideModalBoundary = false;
        modalState.suppressed = false;
        scaffoldLayout.lastOptions = undefined;
        scaffoldLayout.measuredHeight = 0;
    });

    it('forwards stable slots and records measured composer height', async () => {
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');
        const onTouchStart = vi.fn();
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="session"
                testID="scaffold"
                contentTestID="content"
                composerTestID="composer"
                contentProps={{ onTouchStart }}
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        const content = screen.tree.root.findByProps({ testID: 'content' });
        expect(content.props.onTouchStart).toBe(onTouchStart);

        const composer = screen.tree.root.findByProps({ testID: 'composer' });
        act(() => {
            composer.props.onLayout({ nativeEvent: { layout: { height: 144 } } });
        });

        expect(scaffoldLayout.measuredHeight).toBe(144);
        expect(screen.tree.root.findAllByType('AnimatedView' as never)).toHaveLength(1);
        act(() => {
            screen.tree.unmount();
        });
    });

    it('ignores native root layout as an available panel cap', async () => {
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="newSession"
                headerHeight={106}
                testID="scaffold"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        expect(scaffoldLayout.lastOptions?.availablePanelMaxHeight).toBeUndefined();

        const scaffold = screen.tree.root
            .findAllByType('View' as never)
            .find((node) => node.props.testID === 'scaffold');
        if (!scaffold) {
            throw new Error('Expected scaffold root to render as a view');
        }

        if (typeof scaffold.props.onLayout === 'function') {
            act(() => {
                scaffold.props.onLayout({ nativeEvent: { layout: { height: 738 } } });
            });
        }

        expect(scaffoldLayout.lastOptions?.availablePanelMaxHeight).toBeUndefined();
        act(() => {
            screen.tree.unmount();
        });
    });

    it('suppresses background keyboard lift while a foreground modal owns keyboard avoidance', async () => {
        modalState.suppressed = true;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');

        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="session"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        expect(scaffoldLayout.lastOptions?.keyboardLiftSuppressed).toBe(true);
        act(() => {
            screen.tree.unmount();
        });
    });

    it('does not suppress keyboard lift for scaffolds rendered inside a modal boundary', async () => {
        modalState.insideModalBoundary = true;
        modalState.suppressed = true;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');

        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="session"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        expect(scaffoldLayout.lastOptions?.keyboardLiftSuppressed).toBe(false);
        act(() => {
            screen.tree.unmount();
        });
    });
});
