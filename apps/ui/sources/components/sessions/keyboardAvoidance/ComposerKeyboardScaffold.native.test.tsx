import * as React from 'react';
import { Platform, View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const scaffoldLayout = vi.hoisted(() => ({
    lastOptions: undefined as { availablePanelMaxHeight?: number; keyboardLiftSuppressed?: boolean } | undefined,
    measuredHeight: 0,
    scaffoldHeight: 0,
    bottomInset: 0,
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
            bottomInset: { value: scaffoldLayout.bottomInset },
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
            setScaffoldMeasuredHeight: (height: number) => {
                scaffoldLayout.scaffoldHeight = height;
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
    const Animated = {
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('AnimatedView', props, props.children),
        createAnimatedComponent: (component: unknown) => component,
    };

    return {
        __esModule: true,
        default: Animated,
        ...Animated,
        useAnimatedProps: (factory: () => unknown) => factory(),
        useAnimatedStyle: (factory: () => unknown) => factory(),
    };
});

function findComposerAnimatedView(
    tree: Awaited<ReturnType<typeof renderScreen>>['tree'],
    composerTestID: string,
) {
    return tree.root
        .findAllByType('AnimatedView' as never)
        .find((node) => node.props.testID === composerTestID);
}

function resolveStyleOpacity(style: unknown): number | undefined {
    const flattened = Array.isArray(style) ? style : [style];
    let opacity: number | undefined;
    for (const entry of flattened) {
        if (entry && typeof entry === 'object' && 'opacity' in (entry as Record<string, unknown>)) {
            const value = (entry as Record<string, unknown>).opacity;
            if (typeof value === 'number') opacity = value;
        }
    }
    return opacity;
}

function resolveStyleTranslateY(style: unknown): number | undefined {
    const flattened = Array.isArray(style) ? style : [style];
    let translateY: number | undefined;
    for (const entry of flattened) {
        const transform = entry && typeof entry === 'object'
            ? (entry as { transform?: unknown }).transform
            : undefined;
        if (!Array.isArray(transform)) continue;
        for (const op of transform) {
            if (op && typeof op === 'object' && 'translateY' in (op as Record<string, unknown>)) {
                const value = (op as Record<string, unknown>).translateY;
                if (typeof value === 'number') translateY = value;
            }
        }
    }
    return translateY;
}

async function withNativePlatform<TPlatform extends 'android' | 'ios', TResult>(
    platform: TPlatform,
    run: () => Promise<TResult>,
): Promise<TResult> {
    const originalPlatformOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: platform, configurable: true });
    try {
        return await run();
    } finally {
        Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
    }
}

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

function findViewByTestID(screen: RenderedScreen, testID: string) {
    return screen.tree.root
        .findAllByType('View' as never)
        .find((node) => node.props.testID === testID);
}

function resolveStyleBackgroundColor(style: unknown): string | undefined {
    const flattened = Array.isArray(style) ? style.flat() : [style];
    let backgroundColor: string | undefined;
    for (const entry of flattened) {
        if (entry && typeof entry === 'object' && typeof (entry as { backgroundColor?: unknown }).backgroundColor === 'string') {
            backgroundColor = (entry as { backgroundColor: string }).backgroundColor;
        }
    }
    return backgroundColor;
}

describe('ComposerKeyboardScaffold native', () => {
    beforeEach(() => {
        modalState.insideModalBoundary = false;
        modalState.suppressed = false;
        scaffoldLayout.lastOptions = undefined;
        scaffoldLayout.measuredHeight = 0;
        scaffoldLayout.scaffoldHeight = 0;
        scaffoldLayout.bottomInset = 0;
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

    it('renders the new-session composer visible from the first frame with the bottom inset applied', async () => {
        scaffoldLayout.bottomInset = 34;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="newSession"
                composerTestID="composer"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        // The composer must be visible WITHOUT depending on a reveal: no opacity gate is
        // applied. (A prior opacity:0-until-first-onLayout gate left the whole new-session
        // screen blank on device when the first layout never reported a positive height.)
        // The safe-area bottom inset (translateY) is present from the first frame regardless.
        const beforeLayout = findComposerAnimatedView(screen.tree, 'composer');
        expect(beforeLayout).toBeTruthy();
        expect(resolveStyleOpacity(beforeLayout?.props.style)).toBeUndefined();
        expect(resolveStyleTranslateY(beforeLayout?.props.style)).toBe(-34);

        act(() => {
            beforeLayout?.props.onLayout({ nativeEvent: { layout: { height: 220 } } });
        });

        expect(scaffoldLayout.measuredHeight).toBe(220);
        const afterLayout = findComposerAnimatedView(screen.tree, 'composer');
        expect(resolveStyleOpacity(afterLayout?.props.style)).toBeUndefined();
        expect(resolveStyleTranslateY(afterLayout?.props.style)).toBe(-34);
        act(() => {
            screen.tree.unmount();
        });
    });

    it('keeps the new-session scaffold on flex:1 so it inherits the native modal content frame', async () => {
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="newSession"
                headerHeight={44}
                testID="scaffold"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        const scaffold = screen.tree.root
            .findAllByType('View' as never)
            .find((node) => node.props.testID === 'scaffold');
        if (!scaffold) {
            throw new Error('Expected scaffold root to render as a view');
        }

        // The native modal owns the content frame. The scaffold must inherit that frame instead of
        // forcing a window-derived height that can overflow the first cold modal presentation.
        const flattened = Array.isArray(scaffold.props.style) ? scaffold.props.style.flat() : [scaffold.props.style];
        const hasExplicitHeight = flattened.some(
            (entry: unknown) => entry && typeof entry === 'object' && 'height' in (entry as Record<string, unknown>),
        );
        const hasFlexZero = flattened.some(
            (entry: unknown) => entry && typeof entry === 'object' && (entry as { flex?: number }).flex === 0,
        );
        expect(hasExplicitHeight).toBe(false);
        expect(hasFlexZero).toBe(false);

        act(() => {
            screen.tree.unmount();
        });
    });

    it('paints an opaque surface by default so every existing bar and sheet is unchanged', async () => {
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="newSession"
                headerHeight={44}
                testID="scaffold"
                composerTestID="composer-host"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        expect(resolveStyleBackgroundColor(findViewByTestID(screen, 'scaffold')?.props.style)).toBeTruthy();
        expect(resolveStyleBackgroundColor(
            findComposerAnimatedView(screen.tree, 'composer-host')?.props.style,
        )).toBeTruthy();

        act(() => {
            screen.tree.unmount();
        });
    });

    it('paints nothing when the surface is transparent so the screen behind stays visible', async () => {
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="newSession"
                headerHeight={0}
                surface="transparent"
                testID="scaffold"
                composerTestID="composer-host"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        // Both the root and the absolutely-positioned composer wrapper paint `surface.base` in the
        // opaque case. A transparent presentation needs BOTH gone, or the screen behind is covered
        // by an opaque strip even though the navigator stopped painting one.
        expect(resolveStyleBackgroundColor(findViewByTestID(screen, 'scaffold')?.props.style)).toBeUndefined();
        expect(resolveStyleBackgroundColor(
            findComposerAnimatedView(screen.tree, 'composer-host')?.props.style,
        )).toBeUndefined();

        act(() => {
            screen.tree.unmount();
        });
    });

    it('drops the sheet-shaped iOS height cap when the surface is transparent', async () => {
        const screen = await withNativePlatform('ios', async () => {
            const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');
            return renderScreen(
                <ComposerKeyboardScaffold
                    safeAreaTop={62}
                    mode="newSession"
                    headerHeight={0}
                    surface="transparent"
                    testID="scaffold"
                    composer={<React.Fragment>composer</React.Fragment>}
                >
                    <React.Fragment>content</React.Fragment>
                </ComposerKeyboardScaffold>,
            );
        });

        // The cap exists only because a cold `pageSheet` could push the bottom-anchored composer
        // below the visible screen. A transparent presentation has no sheet frame and no header, so
        // a window-derived clamp there is stale geometry. The sheet path keeps it (test above).
        const scaffold = findViewByTestID(screen, 'scaffold');
        const flattened = Array.isArray(scaffold!.props.style) ? scaffold!.props.style.flat() : [scaffold!.props.style];
        const hasMaxHeight = flattened.some(
            (entry: unknown) => entry && typeof entry === 'object' && typeof (entry as { maxHeight?: unknown }).maxHeight === 'number',
        );
        expect(hasMaxHeight).toBe(false);

        act(() => {
            screen.tree.unmount();
        });
    });

    it('caps iOS new-session scaffold height to the visible sheet region on cold modal frames', async () => {
        const screen = await withNativePlatform('ios', async () => {
            const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');
            const modalGeometryProps = { safeAreaTop: 62 };
            return renderScreen(
                <ComposerKeyboardScaffold
                    {...modalGeometryProps}
                    mode="newSession"
                    headerHeight={44}
                    testID="scaffold"
                    composer={<React.Fragment>composer</React.Fragment>}
                >
                    <React.Fragment>content</React.Fragment>
                </ComposerKeyboardScaffold>,
            );
        });

        const scaffold = screen.tree.root
            .findAllByType('View' as never)
            .find((node) => node.props.testID === 'scaffold');
        if (!scaffold) {
            throw new Error('Expected scaffold root to render as a view');
        }

        const flattened = Array.isArray(scaffold.props.style) ? scaffold.props.style.flat() : [scaffold.props.style];
        const maxHeight = flattened.reduce<number | undefined>((value, entry: unknown) => (
            entry && typeof entry === 'object' && typeof (entry as { maxHeight?: unknown }).maxHeight === 'number'
                ? (entry as { maxHeight: number }).maxHeight
                : value
        ), undefined);
        expect(maxHeight).toBe(494);

        act(() => {
            screen.tree.unmount();
        });
    });

    it('does not cap Android new-session scaffold height because the native modal frame is already stable', async () => {
        const screen = await withNativePlatform('android', async () => {
            const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');
            return renderScreen(
                <ComposerKeyboardScaffold
                    mode="newSession"
                    safeAreaTop={62}
                    headerHeight={44}
                    testID="scaffold"
                    composer={<React.Fragment>composer</React.Fragment>}
                >
                    <React.Fragment>content</React.Fragment>
                </ComposerKeyboardScaffold>,
            );
        });

        const scaffold = screen.tree.root
            .findAllByType('View' as never)
            .find((node) => node.props.testID === 'scaffold');
        if (!scaffold) {
            throw new Error('Expected scaffold root to render as a view');
        }

        const flattened = Array.isArray(scaffold.props.style) ? scaffold.props.style.flat() : [scaffold.props.style];
        const hasMaxHeight = flattened.some(
            (entry: unknown) => entry && typeof entry === 'object' && 'maxHeight' in (entry as Record<string, unknown>),
        );
        expect(hasMaxHeight).toBe(false);

        act(() => {
            screen.tree.unmount();
        });
    });

    it('keeps the existing-session scaffold on flex:1 without an explicit sheet height', async () => {
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="session"
                headerHeight={44}
                testID="scaffold"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        const scaffold = screen.tree.root
            .findAllByType('View' as never)
            .find((node) => node.props.testID === 'scaffold');
        if (!scaffold) {
            throw new Error('Expected scaffold root to render as a view');
        }

        const flattened = Array.isArray(scaffold.props.style) ? scaffold.props.style.flat() : [scaffold.props.style];
        const hasExplicitHeight = flattened.some(
            (entry: unknown) => entry && typeof entry === 'object' && 'height' in (entry as Record<string, unknown>),
        );
        expect(hasExplicitHeight).toBe(false);
        act(() => {
            screen.tree.unmount();
        });
    });

    it('renders the existing-session composer visible from the first frame so switches do not flash', async () => {
        scaffoldLayout.bottomInset = 34;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.native');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="session"
                composerTestID="composer"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        // Existing-session scaffolds remount under SessionView's key={sessionId} on every
        // switch; with no opacity gate the composer is visible immediately, so a switch never
        // flashes a fade-in. The bottom inset stays applied throughout.
        const beforeLayout = findComposerAnimatedView(screen.tree, 'composer');
        expect(resolveStyleOpacity(beforeLayout?.props.style)).toBeUndefined();
        expect(resolveStyleTranslateY(beforeLayout?.props.style)).toBe(-34);

        act(() => {
            beforeLayout?.props.onLayout({ nativeEvent: { layout: { height: 220 } } });
        });

        const afterLayout = findComposerAnimatedView(screen.tree, 'composer');
        expect(resolveStyleOpacity(afterLayout?.props.style)).toBeUndefined();
        expect(scaffoldLayout.measuredHeight).toBe(220);
        act(() => {
            screen.tree.unmount();
        });
    });

    it('uses native root layout as the scaffold viewport without passing it as a panel cap', async () => {
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
        expect(scaffoldLayout.scaffoldHeight).toBe(738);
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
