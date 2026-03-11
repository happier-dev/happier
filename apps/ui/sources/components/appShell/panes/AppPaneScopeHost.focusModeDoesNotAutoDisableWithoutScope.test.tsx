import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setEditorFocusModeEnabledSpy = vi.fn();

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    View: 'View',
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));

vi.mock('@/components/ui/panels/MultiPaneHostWithBottom', () => ({
    MultiPaneHostWithBottom: () => React.createElement('MultiPaneHostStub'),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiMultiPanePanelsEnabled') return true;
        if (key === 'editorFocusModeEnabled') return true;
        if (key === 'rightPaneWidthPx') return 360;
        if (key === 'rightPaneWidthBasisPx') return 1200;
        if (key === 'detailsPaneWidthPx') return 420;
        if (key === 'detailsPaneWidthBasisPx') return 1200;
        if (key === 'bottomPaneHeightPx') return 320;
        if (key === 'bottomPaneHeightBasisPx') return 900;
        return null;
    },
    useLocalSettingMutable: (key: string) => {
        if (key === 'editorFocusModeEnabled') return [true, setEditorFocusModeEnabledSpy];
        return [null, vi.fn()];
    },
}));

vi.mock('./AppPaneProvider', () => ({
    useAppPaneContext: () => ({
        dispatch: vi.fn(),
        state: {
            scopes: {},
        },
        getDriver: () => null,
        driverRegistryVersion: 1,
    }),
}));

describe('AppPaneScopeHost (focus mode auto-disable)', () => {
    it('does not auto-disable focus mode before the scope state exists', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        setEditorFocusModeEnabledSpy.mockClear();

        await act(async () => {
            renderer.create(
                <AppPaneScopeHost
                    scopeId="scope-missing"
                    main={<div />}
                    rightPane={<div />}
                    detailsPane={<div />}
                />
            );
        });

        await act(async () => {});
        expect(setEditorFocusModeEnabledSpy).not.toHaveBeenCalled();
    });
});
