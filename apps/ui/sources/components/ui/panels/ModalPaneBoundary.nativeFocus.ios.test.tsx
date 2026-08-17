import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';

const nativeFocus = vi.hoisted(() => ({
    findNodeHandle: vi.fn<(target: unknown) => number | null>(() => null),
    setAccessibilityFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        findNodeHandle: nativeFocus.findNodeHandle,
        AccessibilityInfo: { setAccessibilityFocus: nativeFocus.setAccessibilityFocus },
    });
});

import { View } from 'react-native';
import { ModalPaneBoundaryView, useModalPaneBoundary } from './ModalPaneBoundary';

type NativeNode = Readonly<{ id: number }>;

const nativeNodes = {
    underlay: { id: 11 } satisfies NativeNode,
    overlay: { id: 22 } satisfies NativeNode,
    overlayFocusAnchor: { id: 23 } satisfies NativeNode,
};

afterEach(() => {
    nativeFocus.findNodeHandle.mockClear();
    nativeFocus.setAccessibilityFocus.mockClear();
});

describe('ModalPaneBoundary iOS accessibility focus', () => {
    it('moves VoiceOver into an opened pane and returns to its current opener after close', async () => {
        const opener = { focus: vi.fn(), isConnected: true } satisfies NonNullable<FocusReturnTarget>;
        const focusReturnRef: React.MutableRefObject<FocusReturnTarget> = { current: opener };
        nativeFocus.findNodeHandle.mockImplementation((target) => (
            target === nativeNodes.overlayFocusAnchor ? nativeNodes.overlayFocusAnchor.id
                : target === nativeNodes.overlay ? nativeNodes.overlay.id
                : target === nativeNodes.underlay ? nativeNodes.underlay.id
                    : target === opener ? 3
                        : null
        ));

        const screen = await renderBoundary({ active: true, focusReturnRef });

        expect(nativeFocus.setAccessibilityFocus).toHaveBeenCalledWith(nativeNodes.overlayFocusAnchor.id);
        expect(screen.findByTestId('native-pane-overlay')?.props.accessible).not.toBe(true);

        await screen.update(<NativePaneBoundary active={false} focusReturnRef={focusReturnRef} />);

        expect(opener.focus).toHaveBeenCalledExactlyOnceWith();
        expect(nativeFocus.setAccessibilityFocus).toHaveBeenLastCalledWith(3);
    });

    it('returns to the stable pane host when the captured opener has retired', async () => {
        const retiredOpener: { focus: () => void; isConnected: boolean } = {
            focus: vi.fn(),
            isConnected: true,
        };
        const focusReturnRef: React.MutableRefObject<FocusReturnTarget> = { current: retiredOpener };
        nativeFocus.findNodeHandle.mockImplementation((target) => (
            target === nativeNodes.overlayFocusAnchor ? nativeNodes.overlayFocusAnchor.id
                : target === nativeNodes.overlay ? nativeNodes.overlay.id
                : target === nativeNodes.underlay ? nativeNodes.underlay.id
                    : null
        ));

        const screen = await renderBoundary({ active: true, focusReturnRef });
        retiredOpener.isConnected = false;
        focusReturnRef.current = null;
        await screen.update(<NativePaneBoundary active={false} focusReturnRef={focusReturnRef} />);

        expect(retiredOpener.focus).not.toHaveBeenCalled();
        expect(nativeFocus.setAccessibilityFocus).toHaveBeenLastCalledWith(nativeNodes.underlay.id);
    });
});

function NativePaneBoundary(props: Readonly<{
    active: boolean;
    focusReturnRef: React.MutableRefObject<FocusReturnTarget>;
}>): React.ReactElement {
    const boundary = useModalPaneBoundary({
        active: props.active,
        label: 'Details panel',
        onRequestClose: () => {},
        focusReturnRef: props.focusReturnRef,
    });

    return (
        <>
            <ModalPaneBoundaryView
                ref={boundary.setUnderlayFocusRef}
                testID="native-pane-underlay"
                {...boundary.underlayProps}
            />
            {props.active ? (
                <ModalPaneBoundaryView
                    ref={boundary.setOverlayFocusRef}
                    testID="native-pane-overlay"
                    {...boundary.overlayProps}
                >
                    <View testID="native-pane-overlay-content" />
                </ModalPaneBoundaryView>
            ) : null}
        </>
    );
}

function renderBoundary(input: Readonly<{
    active: boolean;
    focusReturnRef: React.MutableRefObject<FocusReturnTarget>;
}>) {
    return renderScreen(
        <NativePaneBoundary {...input} />,
        {
            createNodeMock: (element) => {
                const props = (element as Readonly<{
                    props?: Readonly<{
                        accessible?: boolean;
                        accessibilityLabel?: string;
                        testID?: string;
                    }>;
                }>).props;
                if (props?.accessible === true && props.accessibilityLabel === 'Details panel') {
                    return nativeNodes.overlayFocusAnchor;
                }
                const testID = props?.testID;
                switch (testID) {
                    case 'native-pane-underlay':
                        return nativeNodes.underlay;
                    case 'native-pane-overlay':
                        return nativeNodes.overlay;
                    default:
                        return null;
                }
            },
        },
    );
}
