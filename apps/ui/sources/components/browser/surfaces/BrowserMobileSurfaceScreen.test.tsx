import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    applyOpenDetailsTab,
    createEmptyPaneDetailsState,
} from '@/components/appShell/panes/details/workspace/detailsWorkspaceReducer';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { createBrowserViewDetailsTab } from './browserSurfaceDetailsTabModel';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { EMPTY_PLUGIN_BROWSER_PROJECTION } from '@/sync/domains/plugins/browser/targets';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({ machineId: 'machine_1' }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server_1',
}));

const paneStub = vi.hoisted(() => ({ current: null as AppPaneScopeApi | null }));
const sessionRuntimeState = vi.hoisted(() => ({
    runtime: {
        browserShellContext: {
            state: {
                itemsById: {},
                itemOrder: [],
                attachmentsById: {},
                attachmentOrder: [],
                navigationGenerationByViewId: {},
                activeAnnotationByViewId: {},
                annotationDraftByViewId: {},
            },
            contextCapabilities: {
                enabled: true,
                available: true,
                supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
                supportedAdapterKinds: ['chromiumSidecar'],
                screenshot: { supported: true, requiresAttachmentUploads: true },
                text: { maxSelectionChars: 2048, maxSummaryChars: 8192 },
                disabledReasons: [],
                policyDeniedReasons: [],
            },
            enabled: true,
            attachmentsUploadsEnabled: true,
            annotationCaptureProvider: null,
            onStateChange: vi.fn(),
        },
    },
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => paneStub.current,
}));

vi.mock('@/components/sessions/browser/sessionBrowserContextRuntime', () => ({
    useSessionBrowserContextRuntimeContext: () => sessionRuntimeState.runtime,
}));

vi.mock('@/components/browser/surfaces/BrowserSurfaceHost', () => ({
    BrowserSurfaceHost: (props: Record<string, unknown>) => (
        React.createElement('BrowserSurfaceHostMock', { ...props })
    ),
    mergeBrowserSurfaceProductModels: (a: unknown, b: unknown) => a ?? b,
}));

const target = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: { title: 'Preview' },
} as const;

const currentPluginProjection = {
    pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 17 },
    pluginBrowserProjection: { ...EMPTY_PLUGIN_BROWSER_PROJECTION, generation: 17 },
    phase: 'current',
    interactionEnabled: true,
    machineId: 'machine-projection',
    serverId: 'server-projection',
    platform: 'ios',
} satisfies PluginUiProjectionCurrentness;

function basePane(): AppPaneScopeApi {
    return {
        scopeId: 'session:session_1:mobile-browser',
        scopeState: null,
        openDetailsTab: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        unpinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        closeDetails: vi.fn(),
        openRight: vi.fn(),
        closeRight: vi.fn(),
        setRightTab: vi.fn(),
        setRightTabState: vi.fn(),
        openBottom: vi.fn(),
        closeBottom: vi.fn(),
        setBottomTab: vi.fn(),
        setBottomTabState: vi.fn(),
        splitDetailsGroup: vi.fn(),
        moveDetailsTabToGroup: vi.fn(),
        focusDetailsGroup: vi.fn(),
        setMaximizedDetailsGroup: vi.fn(),
        setDetailsSplitRatio: vi.fn(),
        closeDetailsGroup: vi.fn(),
    } as unknown as AppPaneScopeApi;
}

function paneWithBrowserView(): AppPaneScopeApi {
    const tab = createBrowserViewDetailsTab({ target, scope: 'mobile' });
    const details = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab, openAs: 'pinned' });
    return { ...basePane(), scopeState: { details: buildDetailsWorkspaceStateView(details) } } as AppPaneScopeApi;
}

describe('BrowserMobileSurfaceScreen (scoped workspace)', () => {
    it('mounts the details-workspace engine and activates a browser-view tab', async () => {
        paneStub.current = paneWithBrowserView();
        const { BrowserMobileSurfaceScreen } = await import('./BrowserMobileSurfaceScreen');

        const screen = await renderScreen(
            <BrowserMobileSurfaceScreen sessionId="session_1" scopeId="session:session_1:mobile-browser" />,
        );

        // The shared single-view browser content host is mounted by the browser-view renderer,
        // proving the scoped workspace engine drives the mobile surface (not a bespoke host bar).
        const host = screen.root.findAllByType('BrowserSurfaceHostMock')[0];
        expect(host).toBeTruthy();
        expect(host?.props.productModels?.browserRecording?.state).toBeTruthy();
        expect(host?.props.productModels?.browserContext?.state).toBe(sessionRuntimeState.runtime.browserShellContext.state);
        expect(host?.props.productModels?.browserContext?.contextCapabilities.supportedContextKinds).toContain('browserAnnotation');
        expect(host?.props.productModels?.browserContext?.annotationCaptureProvider).toBeNull();
    });

    it('mounts the engine with the launchpad new-tab page when there are no open tabs', async () => {
        paneStub.current = {
            ...basePane(),
            scopeState: { details: buildDetailsWorkspaceStateView(createEmptyPaneDetailsState()) },
        } as AppPaneScopeApi;
        const { BrowserMobileSurfaceScreen } = await import('./BrowserMobileSurfaceScreen');

        const screen = await renderScreen(
            <BrowserMobileSurfaceScreen sessionId="session_1" scopeId="session:session_1:mobile-browser" />,
        );

        expect(screen.root).toBeTruthy();
    });

    it('threads the admitted projection, currentness, Browser target, and execution origin into the mobile Browser host', async () => {
        paneStub.current = paneWithBrowserView();
        const { BrowserMobileSurfaceScreen } = await import('./BrowserMobileSurfaceScreen');
        // This forward contract deliberately keeps the RED at the mobile caller:
        // existing source accepts the object at runtime but drops it before the
        // browser renderer creates the real BrowserSurfaceHost.
        const ScreenWithProjection = BrowserMobileSurfaceScreen as unknown as React.ComponentType<
            React.ComponentProps<typeof BrowserMobileSurfaceScreen> & Readonly<{
                pluginProjection: PluginUiProjectionCurrentness;
            }>
        >;

        const screen = await renderScreen(
            <ScreenWithProjection
                sessionId="session_1"
                scopeId="session:session_1:mobile-browser"
                pluginProjection={currentPluginProjection}
            />,
        );

        const host = screen.root.findAllByType('BrowserSurfaceHostMock')[0];
        expect(host?.props.pluginUiProjection).toBe(currentPluginProjection.pluginUiProjection);
        expect(host?.props.pluginUiInteractionEnabled).toBe(true);
        expect(host?.props.pluginBrowserProjection).toBe(currentPluginProjection.pluginBrowserProjection);
        expect(host?.props.pluginBrowserActionContext).toEqual({
            machineId: 'machine-projection',
            serverId: 'server-projection',
            sessionId: 'session_1',
        });
    });
});
