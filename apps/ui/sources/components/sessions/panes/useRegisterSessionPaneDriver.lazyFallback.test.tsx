import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedDriver: any = null;

vi.mock('@/components/appShell/panes/AppPaneProvider', () => {
    const ctx = {
        registerDriver: (driver: any) => {
            capturedDriver = driver;
            return () => {};
        },
    };
    return {
        useAppPaneContext: () => ctx,
        useOptionalAppPaneContext: () => ctx,
    };
});

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

vi.mock('./SessionRightPanel', () => ({
    SessionRightPanel: () => React.createElement('SessionRightPanel'),
}));

vi.mock('./SessionDetailsPanel', () => ({
    SessionDetailsPanel: () => React.createElement('SessionDetailsPanel'),
}));

vi.mock('./bottom/SessionBottomPanel', () => ({
    SessionBottomPanel: () => React.createElement('SessionBottomPanel'),
}));

describe('useRegisterSessionPaneDriver (right pane loading)', () => {
    it('renders the right pane eagerly alongside the details and bottom panes', async () => {
        standardCleanup();
        capturedDriver = null;
        const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');

        const Probe = () => {
            useRegisterSessionPaneDriver('s1');
            return React.createElement('Probe');
        };

        const probe = await renderScreen(<Probe />);

        expect(probe.findAll((node) => String(node.type) === 'Probe')).toHaveLength(1);
        expect(capturedDriver).toBeTruthy();
        expect(typeof capturedDriver.renderDetailsPane).toBe('function');
        expect(typeof capturedDriver.renderBottomPane).toBe('function');

        const rightNode = capturedDriver.renderRightPane();
        const detailsNode = capturedDriver.renderDetailsPane();
        const bottomNode = capturedDriver.renderBottomPane();

        expect(rightNode).toBeTruthy();
        expect(detailsNode).toBeTruthy();
        expect(bottomNode).toBeTruthy();

        const rightScreen = await renderScreen(rightNode);
        const detailsScreen = await renderScreen(detailsNode);
        const bottomScreen = await renderScreen(bottomNode);

        expect(rightScreen.findAll((node) => String(node.type) === 'SessionRightPanel')).toHaveLength(1);
        expect(detailsScreen.findAll((node) => String(node.type) === 'SessionDetailsPanel')).toHaveLength(1);
        expect(bottomScreen.findAll((node) => String(node.type) === 'SessionBottomPanel')).toHaveLength(1);

        expect(rightScreen.getTextContent()).not.toContain('common.loading');
        expect(detailsScreen.getTextContent()).not.toContain('common.loading');
        expect(bottomScreen.getTextContent()).not.toContain('common.loading');

        standardCleanup();
    });
});
