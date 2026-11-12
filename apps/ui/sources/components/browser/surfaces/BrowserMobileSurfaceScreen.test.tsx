import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';

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
    usePreferredServerIdForSession: ({ serverId }: { serverId?: string | null }) => serverId ?? home.serverId,
}));

const home = vi.hoisted(() => ({ serverId: '' }));
const paneStub = vi.hoisted(() => ({ current: null as AppPaneScopeApi | null }));
const sessionRuntimeState = vi.hoisted(() => {
  const contextState = {
    itemsById: {},
    itemOrder: [],
    attachmentsById: {},
    attachmentOrder: [],
    navigationGenerationByViewId: {},
    activeAnnotationByViewId: {},
    annotationDraftByViewId: {},
  };
  return {
    runtime: {
        state: contextState,
        browserShellContext: {
            state: contextState,
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
  };
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => paneStub.current,
}));

// Supply the signed-in Home at its HTTP/storage boundary; mounted Action admission stays real.
const account = createProviderSettingsAccountHarness();
beforeEach(async () => { home.serverId = (await account.restore({ machines: [], currentAccount: true })).serverId; });
afterEach(async () => { await account.reset(); });

vi.mock('@/components/sessions/browser/sessionBrowserContextRuntime', () => ({
    useSessionBrowserContextRuntimeContext: () => sessionRuntimeState.runtime,
}));

vi.mock('@/components/browser/surfaces/BrowserSurfaceHost', () => ({
    BrowserSurfaceHost: (props: Record<string, unknown>) => (
        React.createElement('BrowserSurfaceHostMock', { ...props })
    ),
    mergeBrowserSurfaceProductModels: (a: unknown, b: unknown) => a ?? b,
}));

// The screen's import graph is large; loading it at file scope keeps that cost out of the first test's timeout.
const { BrowserMobileSurfaceScreen } = await import('./BrowserMobileSurfaceScreen');

const target = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: { title: 'Preview' },
} as const;

const currentPluginProjection = {
    accountLifetime: null,
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
        // One session browser host (H-UX F-21): the phone tab binds the managed-Chromium capture
        // provider to the session's machine, as the right panel and Details always did.
        expect(host?.props.productModels?.browserContext?.annotationCaptureProvider).toMatchObject({ available: true });
        expect(host?.props.productModels?.browserContext?.managedAnnotationCaptureProvider).toBe(true);
    });

    it('mounts the engine with the launchpad new-tab page when there are no open tabs', async () => {
        paneStub.current = {
            ...basePane(),
            scopeState: { details: buildDetailsWorkspaceStateView(createEmptyPaneDetailsState()) },
        } as AppPaneScopeApi;

        const screen = await renderScreen(
            <BrowserMobileSurfaceScreen sessionId="session_1" scopeId="session:session_1:mobile-browser" />,
        );

        expect(screen.root).toBeTruthy();
    });

    it('threads the admitted projection, currentness, Browser target, and execution origin into the mobile Browser host', async () => {
        paneStub.current = paneWithBrowserView();
        const screen = await renderScreen(
            <BrowserMobileSurfaceScreen
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

    it('lets an open page fill the phone pane: no large header, no one-tab strip, + and × in the page (lab Qp)', async () => {
        const slot = await import('@/components/appShell/panes/paneHeaderSlot');
        function HeaderProbe(): React.ReactElement {
            return React.createElement('HeaderProbe', { immersive: slot.usePublishedPaneHeaderContent('browser')?.immersive ?? null });
        }
        const render = () => (
            <slot.PaneHeaderSlotProvider>
                <HeaderProbe />
                <slot.PaneHeaderSlotScope slotKey="browser">
                    <BrowserMobileSurfaceScreen sessionId="session_1" scopeId="session:session_1:mobile-browser" />
                </slot.PaneHeaderSlotScope>
            </slot.PaneHeaderSlotProvider>
        );
        const pane = paneWithBrowserView();
        paneStub.current = pane;
        const screen = await renderScreen(render());
        expect(screen.root.findAllByType('HeaderProbe')[0]?.props.immersive).toBe(true);
        expect(screen.findByTestId('session-mobile-browser-new-tab')).toBeNull();
        const host = screen.root.findAllByType('BrowserSurfaceHostMock')[0];
        host?.props.onCloseTab();
        expect(pane.closeDetailsTab).toHaveBeenCalledWith(pane.scopeState!.details.tabs[0]!.key);
        host?.props.onOpenNewTab();
        expect(pane.openDetailsTab).toHaveBeenCalledWith(expect.objectContaining({ key: expect.any(String) }), { intent: 'pinned' });

        // The launchpad keeps its large header (lab Lp).
        paneStub.current = { ...basePane(), scopeState: { details: buildDetailsWorkspaceStateView(createEmptyPaneDetailsState()) } } as AppPaneScopeApi;
        const launchpad = await renderScreen(render());
        expect(launchpad.root.findAllByType('HeaderProbe')[0]?.props.immersive).toBe(false);
    });

    it('tells its pane header where the previews come from (session-tabs lab Wp)', async () => {
        paneStub.current = {
            ...basePane(),
            scopeState: { details: buildDetailsWorkspaceStateView(createEmptyPaneDetailsState()) },
        } as AppPaneScopeApi;
        const slot = await import('@/components/appShell/panes/paneHeaderSlot');
        function HeaderLineProbe(): React.ReactElement {
            const published = slot.usePublishedPaneHeaderContent('browser');
            return React.createElement('HeaderLineProbe', {
                segments: published?.line?.segments ?? null,
            });
        }

        const screen = await renderScreen(
            <slot.PaneHeaderSlotProvider>
                <HeaderLineProbe />
                <slot.PaneHeaderSlotScope slotKey="browser">
                    <BrowserMobileSurfaceScreen sessionId="session_1" scopeId="session:session_1:mobile-browser" />
                </slot.PaneHeaderSlotScope>
            </slot.PaneHeaderSlotProvider>,
        );

        const probe = screen.root.findAllByType('HeaderLineProbe')[0];
        expect(JSON.stringify(probe?.props.segments)).toContain('browserLaunchpad.pane.previews');
    });
});
