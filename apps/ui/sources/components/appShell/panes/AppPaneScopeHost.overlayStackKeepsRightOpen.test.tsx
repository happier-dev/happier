import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const dispatchSpy = vi.fn();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Platform: {
                        OS: 'web',
                        select: (value: Record<string, unknown>) => value.web ?? value.default,
                    },
                    useWindowDimensions: () => ({ width: 600, height: 800 }),
                }
    );
});

vi.mock('@/components/ui/panels/MultiPaneHostWithBottom', () => ({
    MultiPaneHostWithBottom: () => React.createElement('MultiPaneHostStub'),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useLocalSetting: (key: string) => {
        if (key === 'uiMultiPanePanelsEnabled') return true;
        if (key === 'editorFocusModeEnabled') return false;
        if (key === 'rightPaneWidthPx') return 360;
        if (key === 'rightPaneWidthBasisPx') return 600;
        if (key === 'detailsPaneWidthPx') return 420;
        if (key === 'detailsPaneWidthBasisPx') return 600;
        if (key === 'bottomPaneHeightPx') return 320;
        if (key === 'bottomPaneHeightBasisPx') return 900;
        return null;
    },
    useLocalSettingMutable: () => [null, vi.fn()],
});
});

vi.mock('./AppPaneProvider', () => ({
    useAppPaneContext: () => ({
        dispatch: dispatchSpy,
        state: {
            scopes: {
                scope1: {
                    right: { isOpen: true },
                    details: { isOpen: true },
                },
            },
        },
        getDriver: () => null,
        driverRegistryVersion: 1,
    }),
}));

describe('AppPaneScopeHost (overlayStack keeps right open)', () => {
    it('does not auto-dispatch closeRight when both panes are open in overlayStack', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        dispatchSpy.mockClear();

        await renderScreen(<AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    rightPane={<div />}
                    detailsPane={<div />}
                />);

        const closeRightCalls = dispatchSpy.mock.calls.filter((call) => call?.[0]?.type === 'closeRight');
        expect(closeRightCalls).toHaveLength(0);
    });
});
