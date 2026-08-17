import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';

type HardwareBackHandler = () => boolean | null | undefined;

const nativeBack = vi.hoisted(() => {
    let handlers: HardwareBackHandler[] = [];
    return {
        addEventListener: vi.fn((_eventName: string, handler: HardwareBackHandler) => {
            handlers = [...handlers, handler];
            return {
                remove: () => {
                    handlers = handlers.filter((candidate) => candidate !== handler);
                },
            };
        }),
        emit() {
            for (const handler of [...handlers].reverse()) {
                if (handler()) return true;
            }
            return false;
        },
        reset() {
            handlers = [];
            this.addEventListener.mockClear();
        },
    };
});

const nativeFocus = vi.hoisted(() => ({
    findNodeHandle: vi.fn<(target: unknown) => number | null>(() => null),
    setAccessibilityFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' }, {
        BackHandler: nativeBack,
        findNodeHandle: nativeFocus.findNodeHandle,
        AccessibilityInfo: { setAccessibilityFocus: nativeFocus.setAccessibilityFocus },
    });
});

import { View } from 'react-native';
import { ModalPaneBoundaryView, useModalPaneBoundary } from './ModalPaneBoundary';

type NativeNode = Readonly<{ id: number }>;
type NativeElementProps = Readonly<{
    accessible?: boolean;
    accessibilityLabel?: string;
    testID?: string;
}>;

const nativeNodes = {
    opener: { id: 1 } satisfies NativeNode,
    outerUnderlay: { id: 10 } satisfies NativeNode,
    outerOverlay: { id: 20 } satisfies NativeNode,
    outerFocusAnchor: { id: 21 } satisfies NativeNode,
    innerUnderlay: { id: 30 } satisfies NativeNode,
    innerOverlay: { id: 40 } satisfies NativeNode,
    innerFocusAnchor: { id: 41 } satisfies NativeNode,
};

afterEach(() => {
    nativeBack.reset();
    nativeFocus.findNodeHandle.mockClear();
    nativeFocus.setAccessibilityFocus.mockClear();
});

describe('ModalPaneBoundary Android accessibility focus', () => {
    it('returns TalkBack to the exact opener after Android Back closes the active pane', async () => {
        const opener = { focus: vi.fn(), isConnected: true } satisfies NonNullable<FocusReturnTarget>;
        const focusReturnRef: React.MutableRefObject<FocusReturnTarget> = { current: opener };
        nativeFocus.findNodeHandle.mockImplementation((target) => (
            target === nativeNodes.outerFocusAnchor ? nativeNodes.outerFocusAnchor.id
                : target === nativeNodes.outerOverlay ? nativeNodes.outerOverlay.id
                : target === nativeNodes.outerUnderlay ? nativeNodes.outerUnderlay.id
                    : target === opener ? nativeNodes.opener.id
                        : null
        ));

        const screen = await renderScreen(
            <DismissiblePane focusReturnRef={focusReturnRef} />,
            { createNodeMock },
        );

        expect(nativeFocus.setAccessibilityFocus).toHaveBeenCalledWith(nativeNodes.outerFocusAnchor.id);

        await act(async () => {
            expect(nativeBack.emit()).toBe(true);
        });

        expect(opener.focus).toHaveBeenCalledExactlyOnceWith();
        expect(nativeFocus.setAccessibilityFocus).toHaveBeenLastCalledWith(nativeNodes.opener.id);
        expect(screen.findByTestId('android-pane-overlay')).toBeNull();
    });

    it('retains the exact opener snapshot when the AppPane owner clears its pending ref before close', async () => {
        const opener = { focus: vi.fn(), isConnected: true } satisfies NonNullable<FocusReturnTarget>;
        const focusReturnRef: React.MutableRefObject<FocusReturnTarget> = { current: opener };
        nativeFocus.findNodeHandle.mockImplementation((target) => (
            target === nativeNodes.outerFocusAnchor ? nativeNodes.outerFocusAnchor.id
                : target === nativeNodes.outerUnderlay ? nativeNodes.outerUnderlay.id
                    : target === opener ? nativeNodes.opener.id
                        : null
        ));
        const screen = await renderScreen(
            <ControlledPane active focusReturnRef={focusReturnRef} />,
            { createNodeMock },
        );

        // AppPane clears its command-time ref before reducing the close action.
        // The pane boundary must keep the activation-time snapshot instead of
        // silently returning only to its retained-underlay fallback.
        focusReturnRef.current = null;
        await screen.update(<ControlledPane active={false} focusReturnRef={focusReturnRef} />);

        expect(opener.focus).toHaveBeenCalledExactlyOnceWith();
        expect(nativeFocus.setAccessibilityFocus).toHaveBeenLastCalledWith(nativeNodes.opener.id);
        expect(nativeFocus.setAccessibilityFocus).not.toHaveBeenLastCalledWith(nativeNodes.outerUnderlay.id);
    });

    it('keeps focus at the topmost nested pane and returns only to its enclosing host on close', async () => {
        nativeFocus.findNodeHandle.mockImplementation((target) => {
            for (const node of Object.values(nativeNodes)) {
                if (target === node) return node.id;
            }
            return null;
        });
        const screen = await renderScreen(<NestedPaneHarness innerActive={false} />, { createNodeMock });

        expect(nativeFocus.setAccessibilityFocus).toHaveBeenLastCalledWith(nativeNodes.outerFocusAnchor.id);

        await screen.update(<NestedPaneHarness innerActive />);
        expect(nativeFocus.setAccessibilityFocus).toHaveBeenLastCalledWith(nativeNodes.innerFocusAnchor.id);

        await screen.update(<NestedPaneHarness innerActive={false} />);
        expect(nativeFocus.setAccessibilityFocus).toHaveBeenLastCalledWith(nativeNodes.innerUnderlay.id);
    });
});

function DismissiblePane(props: Readonly<{
    focusReturnRef: React.MutableRefObject<FocusReturnTarget>;
}>): React.ReactElement {
    const [active, setActive] = React.useState(true);
    const boundary = useModalPaneBoundary({
        active,
        label: 'Right sidebar',
        onRequestClose: () => setActive(false),
        focusReturnRef: props.focusReturnRef,
    });

    return (
        <>
            <ModalPaneBoundaryView
                ref={boundary.setUnderlayFocusRef}
                testID="android-pane-underlay"
                {...boundary.underlayProps}
            />
            {active ? (
                <ModalPaneBoundaryView
                    ref={boundary.setOverlayFocusRef}
                    testID="android-pane-overlay"
                    {...boundary.overlayProps}
                />
            ) : null}
        </>
    );
}

function ControlledPane(props: Readonly<{
    active: boolean;
    focusReturnRef: React.MutableRefObject<FocusReturnTarget>;
}>): React.ReactElement {
    const boundary = useModalPaneBoundary({
        active: props.active,
        label: 'Right sidebar',
        onRequestClose: () => {},
        focusReturnRef: props.focusReturnRef,
    });

    return (
        <>
            <ModalPaneBoundaryView
                ref={boundary.setUnderlayFocusRef}
                testID="controlled-pane-underlay"
                {...boundary.underlayProps}
            />
            {props.active ? (
                <ModalPaneBoundaryView
                    ref={boundary.setOverlayFocusRef}
                    testID="controlled-pane-overlay"
                    {...boundary.overlayProps}
                />
            ) : null}
        </>
    );
}

function NestedPaneHarness(props: Readonly<{ innerActive: boolean }>): React.ReactElement {
    const outer = useModalPaneBoundary({
        active: true,
        label: 'Details panel',
        onRequestClose: () => {},
    });
    const inner = useModalPaneBoundary({
        active: props.innerActive,
        label: 'Nested sidebar',
        onRequestClose: () => {},
    });

    return (
        <>
            <ModalPaneBoundaryView
                ref={outer.setUnderlayFocusRef}
                testID="nested-outer-underlay"
                {...outer.underlayProps}
            />
            <ModalPaneBoundaryView
                ref={outer.setOverlayFocusRef}
                testID="nested-outer-overlay"
                {...outer.overlayProps}
            >
                <ModalPaneBoundaryView
                    ref={inner.setUnderlayFocusRef}
                    testID="nested-inner-underlay"
                    {...inner.underlayProps}
                />
                {props.innerActive ? (
                    <ModalPaneBoundaryView
                        ref={inner.setOverlayFocusRef}
                        testID="nested-inner-overlay"
                        {...inner.overlayProps}
                    />
                ) : null}
            </ModalPaneBoundaryView>
        </>
    );
}

function createNodeMock(element: React.ReactElement): NativeNode | null {
    const props = (element as React.ReactElement<NativeElementProps>).props;
    if (props?.accessible === true) {
        if (props.accessibilityLabel === 'Details panel') return nativeNodes.outerFocusAnchor;
        if (props.accessibilityLabel === 'Right sidebar') return nativeNodes.outerFocusAnchor;
        if (props.accessibilityLabel === 'Nested sidebar') return nativeNodes.innerFocusAnchor;
    }

    switch (props?.testID) {
        case 'android-pane-underlay':
        case 'controlled-pane-underlay':
        case 'nested-outer-underlay':
            return nativeNodes.outerUnderlay;
        case 'android-pane-overlay':
        case 'controlled-pane-overlay':
        case 'nested-outer-overlay':
            return nativeNodes.outerOverlay;
        case 'nested-inner-underlay':
            return nativeNodes.innerUnderlay;
        case 'nested-inner-overlay':
            return nativeNodes.innerOverlay;
        default:
            return null;
    }
}
