import type {
    BrowserViewTargetV1,
    LocalServiceLauncherSnapshotV1,
} from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import {
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import { createLocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/browser/frame/engines/DesktopWebViewEngine', () => ({
    DesktopWebViewEngine: (props: Readonly<Record<string, unknown>>) => React.createElement('View', {
        testID: props.testID ?? 'desktop-webview',
    }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => ({
        featureId,
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [],
        evaluatedAt: 1_000,
        scope: { scopeKind: 'runtime' },
    }),
}));

const runningTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_vite',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Vite app',
        addressLabel: 'localhost:5173',
    },
} satisfies BrowserViewTargetV1;

const runningLauncherSnapshot = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 1_000,
    targets: [{
        id: 'launcher_preview',
        source: 'registered_preview',
        machineId: 'machine_1',
        sessionId: 'session_1',
        title: 'Vite app',
        subtitle: 'localhost:5173',
        kind: 'vite',
        confidence: 'high',
        state: 'available',
        actions: ['open_preview'],
        browserTarget: runningTarget,
    }],
} satisfies LocalServiceLauncherSnapshotV1;

const browserPanelBinding = normalizePluginUiDestinationBindingV1({
    pluginId: 'acme.browser',
    destinationId: 'panel',
    rendererId: 'panel',
    container: 'browserPanel',
    target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
});
if (!browserPanelBinding) throw new Error('Browser panel binding fixture is required');

const browserPanelPlacement = {
    id: 'surfacePlacement:acme.browser:panel',
    pluginId: 'acme.browser',
    contributionKind: 'surfacePlacement',
    descriptorId: 'panel',
    binding: browserPanelBinding,
    target: browserPanelBinding.target,
    renderer: { kind: 'hostedWeb', contributionId: 'panel' },
    display: { label: 'Browser panel' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    headerActions: [],
} as const;

const browserPanelProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    hostedWebById: {
        'hostedWeb:acme.browser:panel': {
            id: 'hostedWeb:acme.browser:panel',
            pluginId: 'acme.browser',
            contributionKind: 'hostedWeb',
            contributionId: 'panel',
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['ready'] },
            sandbox: { scripts: true },
            security: {},
            runtime: {
                state: 'available',
                diagnostics: [],
                decision: {
                    state: 'render',
                    reason: 'available',
                    diagnostics: [],
                },
            },
        },
    },
    surfacePlacementsById: {
        [browserPanelPlacement.id]: browserPanelPlacement,
    },
};

describe('SessionRightPanelBrowserView', () => {
    it('forwards the live launchpad feed into the reusable browser host', async () => {
        const { SessionRightPanelBrowserView } = await import('./SessionRightPanelBrowserView');
        const launcherState = applyLocalServiceLauncherSnapshot(
            createLocalServiceLauncherState(),
            runningLauncherSnapshot,
        );

        const screen = await renderScreen(
            <SessionRightPanelBrowserView
                sessionId="session_1"
                overrides={{
                    machineId: 'machine_1',
                    serverId: 'server_1',
                    platform: 'web',
                    launcherState,
                    localServicePreviewState: createLocalServicePreviewState(),
                    nowMs: () => 1_500,
                }}
            />,
        );

        expect(
            screen.findByTestId('session-rightpanel-browser-launchpad-card:localService:launcher_preview-available'),
        ).not.toBeNull();
    });

    it('mounts a browser panel with the admitted origin, not the focused target identity', async () => {
        const { SessionRightPanelBrowserView } = await import('./SessionRightPanelBrowserView');
        const launcherState = applyLocalServiceLauncherSnapshot(
            createLocalServiceLauncherState(),
            runningLauncherSnapshot,
        );

        const screen = await renderScreen(
            <SessionRightPanelBrowserView
                sessionId="session_1"
                pluginProjection={{
                    pluginUiProjection: browserPanelProjection,
                    pluginBrowserProjection: null,
                    phase: 'current',
                    interactionEnabled: true,
                    machineId: 'machine-admitted',
                    serverId: 'server-admitted',
                    platform: 'web',
                }}
                overrides={{
                    machineId: 'machine_1',
                    serverId: 'server_1',
                    platform: 'web',
                    launcherState,
                    localServicePreviewState: createLocalServicePreviewState(),
                    nowMs: () => 1_500,
                }}
            />,
        );

        await screen.pressByTestIdAsync(
            'session-rightpanel-browser-launchpad-card:localService:launcher_preview',
        );
        await flushHookEffects({ cycles: 2 });

        expect(
            screen.findByTestId('session-rightpanel-browser-plugin-placement-surfacePlacement:acme.browser:panel'),
        ).not.toBeNull();
        expect(screen.findByType(PluginSurfacePlacementHost).props).toMatchObject({
            resourceBrowserTarget: runningTarget,
            machineId: 'machine-admitted',
            serverId: 'server-admitted',
            sessionId: 'session_1',
        });
    });
});
