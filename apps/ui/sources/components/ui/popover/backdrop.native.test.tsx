import * as React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installExpoBlurRequireStub } from '@/dev/testkit/mocks/expoBlur';
import { PopoverBackdrop } from './backdrop';

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return platform.OS; } } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
const restoreExpoBlur = installExpoBlurRequireStub();
afterAll(restoreExpoBlur);
afterEach(() => { platform.OS = 'ios'; });

const backdrop = {
    backdrop: true, backdropBlocksOutsidePointerEvents: false, backdropOutsidePointerEventsMode: 'full',
    backdropPointerEventsEnabled: true, backdropEffect: 'blur',
    backdropSpotlight: false, backdropAnchorOverlay: undefined, backdropStyle: undefined,
    closeOnBackdropPan: false, onRequestClose: undefined, shouldPortal: true, shouldPortalWeb: false,
    portal: { native: true }, portalOpacity: 1, portalPositionOnWeb: 'absolute', fixedPositionOnWeb: 'absolute',
    portalZ: 100, anchorRect: null, windowWidth: 390, windowHeight: 844, portalSpaceHeight: 844,
    webPortalOffsetX: 0, webPortalOffsetY: 0,
} satisfies React.ComponentProps<typeof PopoverBackdrop>;

describe('native popover backdrop material', () => {
    it('uses iOS blur when the native SDK is available', async () => {
        const screen = await renderScreen(<PopoverBackdrop {...backdrop} />);
        expect(screen.findAllByType('BlurView')).toHaveLength(1);
    });
    it('keeps a dim backdrop without mounting targetless Android blur', async () => {
        platform.OS = 'android';
        const screen = await renderScreen(<PopoverBackdrop {...backdrop} />);
        expect(screen.findAllByType('BlurView')).toHaveLength(0);
        expect(screen.findByTestId('popover-backdrop-effect')).toBeTruthy();
    });
});
