import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const nativeFocus = vi.hoisted(() => ({
    findNodeHandle: vi.fn<(target: unknown) => number | null>(() => null),
    setAccessibilityFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' }, {
        BackHandler: {
            addEventListener: () => ({ remove: () => {} }),
        },
        findNodeHandle: nativeFocus.findNodeHandle,
        AccessibilityInfo: { setAccessibilityFocus: nativeFocus.setAccessibilityFocus },
    });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: () => undefined,
        useLocalSettingMutable: () => [undefined, () => {}],
    });
});

import { View } from 'react-native';
import { ModalPaneBoundaryView, useModalPaneBoundary } from '@/components/ui/panels/ModalPaneBoundary';
import { AppPaneProvider } from './AppPaneProvider';
import { useAppPaneScope, type AppPaneScopeApi } from './hooks/useAppPaneScope';

type NativeNode = Readonly<{ id: number }>;
type NativeElementProps = Readonly<{
    accessible?: boolean;
    accessibilityLabel?: string;
    testID?: string;
}>;

const nativeNodes = {
    opener: { id: 1 } satisfies NativeNode,
    underlay: { id: 10 } satisfies NativeNode,
    overlay: { id: 20 } satisfies NativeNode,
    overlayFocusAnchor: { id: 21 } satisfies NativeNode,
};

let pane: AppPaneScopeApi | null = null;

afterEach(() => {
    pane = null;
    nativeFocus.findNodeHandle.mockClear();
    nativeFocus.setAccessibilityFocus.mockClear();
});

describe('AppPane native overlay focus capture', () => {
    it('returns to the native opener captured before the right pane becomes an overlay', async () => {
        nativeFocus.findNodeHandle.mockImplementation((target) => (
            target === nativeNodes.underlay ? nativeNodes.underlay.id
                : target === nativeNodes.overlay ? nativeNodes.overlay.id
                    : target === nativeNodes.overlayFocusAnchor ? nativeNodes.overlayFocusAnchor.id
                        : null
        ));
        const screen = await renderScreen(
            <AppPaneProvider>
                <NativeRightOverlayHarness />
            </AppPaneProvider>,
            { createNodeMock },
        );
        const captureNativeTouch = pane?.overlayFocusReturnCaptureProps?.onTouchStartCapture;

        expect(captureNativeTouch).toBeTypeOf('function');
        if (!captureNativeTouch || !pane) return;

        await act(async () => {
            captureNativeTouch({ nativeEvent: { target: nativeNodes.opener.id } });
            pane?.openRight({ tabId: 'files' });
        });

        expect(nativeFocus.setAccessibilityFocus).toHaveBeenLastCalledWith(nativeNodes.overlayFocusAnchor.id);

        await act(async () => {
            pane?.closeRight();
        });

        expect(nativeFocus.setAccessibilityFocus).toHaveBeenLastCalledWith(nativeNodes.opener.id);
        expect(nativeFocus.setAccessibilityFocus).not.toHaveBeenLastCalledWith(nativeNodes.underlay.id);
        expect(screen.findByTestId('app-pane-native-overlay')).toBeNull();
    });
});

function NativeRightOverlayHarness(): React.ReactElement {
    const appPane = useAppPaneScope('session:native-focus');
    const active = appPane.scopeState?.right.isOpen === true;
    const boundary = useModalPaneBoundary({
        active,
        label: 'Right sidebar',
        onRequestClose: appPane.closeRight,
        focusReturnRef: appPane.rightOverlayFocusReturnRef,
    });
    pane = appPane;

    return (
        <View testID="app-pane-native-scope" {...appPane.overlayFocusReturnCaptureProps}>
            <ModalPaneBoundaryView
                ref={boundary.setUnderlayFocusRef}
                testID="app-pane-native-underlay"
                {...boundary.underlayProps}
            />
            {active ? (
                <ModalPaneBoundaryView
                    ref={boundary.setOverlayFocusRef}
                    testID="app-pane-native-overlay"
                    {...boundary.overlayProps}
                />
            ) : null}
        </View>
    );
}

function createNodeMock(element: React.ReactElement): NativeNode | null {
    const props = (element as React.ReactElement<NativeElementProps>).props;
    if (props?.accessible === true && props.accessibilityLabel === 'Right sidebar') {
        return nativeNodes.overlayFocusAnchor;
    }

    switch (props?.testID) {
        case 'app-pane-native-underlay':
            return nativeNodes.underlay;
        case 'app-pane-native-overlay':
            return nativeNodes.overlay;
        default:
            return null;
    }
}
