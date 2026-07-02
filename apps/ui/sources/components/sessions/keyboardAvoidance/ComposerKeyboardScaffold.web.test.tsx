import * as React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const webScaffoldLayout = vi.hoisted(() => ({
    bottomInset: 0,
    lastOptions: undefined as { availablePanelMaxHeight?: number; keyboardLiftSuppressed?: boolean } | undefined,
}));

const modalState = vi.hoisted(() => ({
    insideModalBoundary: false,
    suppressed: false,
}));

vi.mock('./useComposerKeyboardLayout.web', () => ({
    useComposerKeyboardLayout: (options: { availablePanelMaxHeight?: number; keyboardLiftSuppressed?: boolean } = {}) => {
        webScaffoldLayout.lastOptions = options;
        return {
            availablePanelHeight: { value: 0 },
            bottomInset: { value: webScaffoldLayout.bottomInset },
            composerHeight: { value: 0 },
            isKeyboardLiftSuppressed: { value: false },
            keyboardHeightForInset: { value: webScaffoldLayout.bottomInset },
            keyboardHeightLive: { value: webScaffoldLayout.bottomInset },
            keyboardProgress: { value: webScaffoldLayout.bottomInset > 0 ? 1 : 0 },
            listBottomInset: { value: 0 },
            setComposerMeasuredHeight: vi.fn(),
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

describe('ComposerKeyboardScaffold web', () => {
    beforeEach(() => {
        modalState.insideModalBoundary = false;
        modalState.suppressed = false;
        webScaffoldLayout.bottomInset = 0;
        webScaffoldLayout.lastOptions = undefined;
    });

    it('pads the scaffold by the visual viewport keyboard inset', async () => {
        webScaffoldLayout.bottomInset = 320;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="session"
                safeAreaBottom={20}
                testID="scaffold"
                contentTestID="content"
                composer={<React.Fragment>composer</React.Fragment>}
                composerTestID="composer"
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        const scaffold = screen.tree.root
            .findAllByType('AnimatedView' as never)
            .find((node) => node.props.testID === 'scaffold');
        if (!scaffold) {
            throw new Error('Expected scaffold root to render as an animated view');
        }
        expect(StyleSheet.flatten(scaffold.props.style).paddingBottom).toBe(300);
    });

    it('passes the measured scaffold height as the available panel cap', async () => {
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="newSession"
                testID="scaffold"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        const scaffold = screen.tree.root
            .findAllByType('AnimatedView' as never)
            .find((node) => node.props.testID === 'scaffold');
        if (!scaffold) {
            throw new Error('Expected scaffold root to render as an animated view');
        }
        expect(typeof scaffold.props.onLayout).toBe('function');

        act(() => {
            scaffold.props.onLayout({ nativeEvent: { layout: { height: 420 } } });
        });

        expect(webScaffoldLayout.lastOptions?.availablePanelMaxHeight).toBe(420);
    });

    it('suppresses background keyboard lift while a foreground modal owns keyboard avoidance', async () => {
        modalState.suppressed = true;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');

        await renderScreen(
            <ComposerKeyboardScaffold
                mode="session"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        expect(webScaffoldLayout.lastOptions?.keyboardLiftSuppressed).toBe(true);
    });

    it('does not suppress keyboard lift for scaffolds rendered inside a modal boundary', async () => {
        modalState.insideModalBoundary = true;
        modalState.suppressed = true;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');

        await renderScreen(
            <ComposerKeyboardScaffold
                mode="session"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        expect(webScaffoldLayout.lastOptions?.keyboardLiftSuppressed).toBe(false);
    });
});
