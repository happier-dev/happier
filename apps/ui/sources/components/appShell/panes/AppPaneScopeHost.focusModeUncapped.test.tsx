import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastProps: any = null;

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    View: 'View',
    useWindowDimensions: () => ({ width: 1800, height: 900 }),
}));

vi.mock('@/components/ui/panels/MultiPaneHost', () => ({
    MultiPaneHost: (props: any) => {
        lastProps = props;
        return React.createElement('MultiPaneHostStub');
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiMultiPanePanelsEnabled') return true;
        if (key === 'editorFocusModeEnabled') return true;
        if (key === 'rightPaneWidthPx') return 360;
        if (key === 'rightPaneWidthBasisPx') return 1800;
        if (key === 'detailsPaneWidthPx') return 520;
        if (key === 'detailsPaneWidthBasisPx') return 1800;
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
                    details: { isOpen: true },
                },
            },
        },
        getDriver: () => null,
        driverRegistryVersion: 1,
    }),
}));

describe('AppPaneScopeHost (focus mode uncapped)', () => {
    it('allows focus mode to fill widths beyond global max constraints', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;

        await act(async () => {
            renderer.create(
                <AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    rightPane={<div />}
                    detailsPane={<div />}
                />
            );
        });

        expect(lastProps).not.toBeNull();
        expect(lastProps.layout.right).toBe('docked');
        expect(lastProps.layout.details).toBe('docked');
        expect(lastProps.rightDockWidthPx).toBe(360);
        expect(lastProps.detailsDockWidthPx).toBe(1800 - 360);
        expect(lastProps.detailsDockMaxWidthPx).toBe(1800 - 360);
    });
});
