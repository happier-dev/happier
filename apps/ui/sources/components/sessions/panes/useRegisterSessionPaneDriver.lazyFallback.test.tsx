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

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({ machineId: 'machine-s1', basePath: '/repo' }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-s1',
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => ({
        pluginUiProjection: { generation: 7 },
        pluginBrowserProjection: { generation: 8 },
        phase: 'current',
        interactionEnabled: true,
        platform: 'web',
    }),
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
        expect(capturedDriver.surfaceScope).toEqual({
            targetKind: 'session',
            sessionId: 's1',
            machineId: 'machine-s1',
            serverId: 'server-s1',
            pluginUiProjection: { generation: 7 },
            pluginBrowserProjection: { generation: 8 },
            projectionPhase: 'current',
            interactionEnabled: true,
            platform: 'web',
        });
        expect(capturedDriver.rightPaneBuiltinAdapter).toBeTruthy();
        expect(capturedDriver.detailsPaneBuiltinAdapter).toBeTruthy();
        expect(capturedDriver.bottomPaneBuiltinAdapter).toBeTruthy();

        const rightNode = capturedDriver.rightPaneBuiltinAdapter.render({ scopeId: 'session:s1', destinationId: 'files' });
        const rightSidebarNode = capturedDriver.rightSidebarAdapter.render({ scopeId: 'session:s1' });
        const detailsNode = capturedDriver.detailsPaneBuiltinAdapter.render({ scopeId: 'session:s1', destinationId: 'session-details' });
        const bottomNode = capturedDriver.bottomPaneBuiltinAdapter.render({ scopeId: 'session:s1', destinationId: 'terminal' });

        expect(rightNode).toBeTruthy();
        expect(rightSidebarNode).toBeTruthy();
        expect(detailsNode).toBeTruthy();
        expect(bottomNode).toBeTruthy();

        // The details renderer consumes the exact scope produced by this
        // registered driver. It must not reconstruct a second target from
        // session state after AppPane has resolved the destination.
        expect(detailsNode.props.paneSurfaceScope).toBe(capturedDriver.surfaceScope);
        // The right pane is the same driver-owned AppPane surface. It must
        // consume the exact target/projection object, rather than resolve a
        // second Session target after AppPane selected its destination.
        expect(rightNode.props.paneSurfaceScope).toBe(capturedDriver.surfaceScope);
        expect(rightSidebarNode.props.paneSurfaceScope).toBe(capturedDriver.surfaceScope);

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
