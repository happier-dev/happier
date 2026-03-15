import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const rightPanelModuleLoaded = vi.fn();
const detailsPanelModuleLoaded = vi.fn();

vi.mock('@/components/appShell/panes/AppPaneProvider', () => {
    const ctx = {
        registerDriver: () => () => {},
    };
    return {
        useAppPaneContext: () => ctx,
        useOptionalAppPaneContext: () => ctx,
    };
});

vi.mock('./SessionRightPanel', () => {
    rightPanelModuleLoaded();
    return {
        SessionRightPanel: () => React.createElement('SessionRightPanel'),
    };
});

vi.mock('./SessionDetailsPanel', () => {
    detailsPanelModuleLoaded();
    return {
        SessionDetailsPanel: () => React.createElement('SessionDetailsPanel'),
    };
});

describe('useRegisterSessionPaneDriver (module prefetch)', () => {
    it('prefetches right/details pane modules after hook mount', async () => {
        rightPanelModuleLoaded.mockClear();
        detailsPanelModuleLoaded.mockClear();

        const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');

        const Probe = () => {
            useRegisterSessionPaneDriver('s1');
            return React.createElement('Probe');
        };

        await act(async () => {
            renderer.create(<Probe />);
        });

        expect(rightPanelModuleLoaded).toHaveBeenCalledTimes(1);
        expect(detailsPanelModuleLoaded).toHaveBeenCalledTimes(1);
    });
});
