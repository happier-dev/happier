import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastMultiPaneLayout: any = null;

vi.mock('react-native', () => ({
    View: 'View',
    Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));

vi.mock('@/components/ui/panels/MultiPaneHost', () => ({
    MultiPaneHost: (props: any) => {
        lastMultiPaneLayout = props.layout;
        return React.createElement('MultiPaneHostStub');
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiMultiPanePanelsEnabled') return undefined;
        if (key === 'editorFocusModeEnabled') return false;
        if (key === 'rightPaneWidthPx') return 360;
        if (key === 'rightPaneWidthBasisPx') return 1200;
        if (key === 'detailsPaneWidthPx') return 420;
        if (key === 'detailsPaneWidthBasisPx') return 1200;
        return null;
    },
    useLocalSettingMutable: () => [null, vi.fn()],
}));

vi.mock('./AppPaneProvider', () => ({
    useAppPaneContext: () => ({
        dispatch: vi.fn(),
        state: {
            scopes: {
                scope1: {
                    right: { isOpen: true },
                    details: { isOpen: false },
                },
            },
        },
        getDriver: () => null,
        driverRegistryVersion: 1,
    }),
}));

describe('AppPaneScopeHost (multi-pane default)', () => {
    it('treats uiMultiPanePanelsEnabled as enabled when unset', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastMultiPaneLayout = null;

        await act(async () => {
            renderer.create(
                <AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    rightPane={<div />}
                    detailsPane={null}
                />
            );
        });

        expect(lastMultiPaneLayout).not.toBeNull();
        expect(lastMultiPaneLayout.kind).not.toBe('single');
        expect(lastMultiPaneLayout.right).not.toBe('hidden');
    });
});
