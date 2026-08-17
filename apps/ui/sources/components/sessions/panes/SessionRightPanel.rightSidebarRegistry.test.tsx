import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { renderScreen } from '@/dev/testkit';
import {
    createPluginSurfaceDestinationNavigationBinding,
    PluginSurfaceDestinationNavigationBindingProvider,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiSurfacePlacementProjection,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let terminalFeatureEnabled = true;
let scopeState: any = {
    right: { isOpen: true, activeTabId: 'browser', tabState: {} },
};

const pluginProjectionState = vi.hoisted<{
    value: {
        pluginUiProjection: unknown;
        phase: 'establishing' | 'current' | 'retainedOffline' | 'unavailable';
        interactionEnabled?: boolean;
        machineId: string | null;
        serverId: string | null;
        platform: 'web';
    };
}>(() => ({
    value: {
        pluginUiProjection: null,
        phase: 'unavailable',
        machineId: 'machine-1',
        serverId: 'server-1',
        platform: 'web',
    },
}));
const useScopedPluginUiProjectionMock = vi.hoisted(() => vi.fn());
const sessionRightPanelDeviceType = vi.hoisted(() => ({ value: 'tablet' as 'phone' | 'tablet' }));

const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
const selectRightDestinationSpy = vi.fn();

installSessionDetailsPanelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useLocalSetting: (key: string) => {
                if (key === 'embeddedTerminalDockLocation') return 'sidebar';
                return null;
            },
        });
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (fn: any) => fn(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'terminal.embeddedPty' ? terminalFeatureEnabled : false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => sessionRightPanelDeviceType.value,
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState,
        openRight: openRightSpy,
        setRightTab: setRightTabSpy,
        selectRightDestination: selectRightDestinationSpy,
        closeRight: vi.fn(),
        openDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
    SessionRepositoryTreeBrowserView: () => React.createElement('FilesView'),
}));

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitView', () => ({
    SessionRightPanelGitView: () => React.createElement('GitView'),
}));

vi.mock('@/components/sessions/panes/agents/SessionRightPanelAgentsView', () => ({
    SessionRightPanelAgentsView: () => React.createElement('AgentsView'),
}));

vi.mock('@/components/sessions/panes/terminal/SessionRightPanelTerminalView', () => ({
    SessionRightPanelTerminalView: () => React.createElement('TerminalView'),
}));

vi.mock('@/components/browser/surfaces', () => ({
    BrowserSurfaceHost: (props: Record<string, unknown>) => React.createElement('BrowserSurfaceHostStub', props),
    // SVC-2: SessionRightPanel mounts useServicesOpenInBrowser, which pulls these from the barrel.
    // resolveBrowserSurfacePlatform runs at hook level (render); the opener/mapper run only on open.
    resolveBrowserSurfacePlatform: () => 'desktop',
    mapLocalServiceLaunchTargetToBrowserTarget: () => null,
    createOpenBrowserTargetInWorkspace: () => () => undefined,
}));

vi.mock('@/components/sessions/localServices', () => ({
    DetectedLocalServicesPane: (props: Record<string, unknown>) => React.createElement('DetectedLocalServicesPaneStub', props),
    LocalServicesSurfaceHost: (props: Record<string, unknown>) => React.createElement(
        'DetectedLocalServicesPaneStub',
        props,
    ),
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: (params: unknown) => useScopedPluginUiProjectionMock(params),
}));

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({ machineId: 'machine-1', basePath: '/repo' }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-1',
}));

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: (props: Record<string, unknown>) => React.createElement('PluginSurfacePlacementHostStub', props),
    PluginSurfacePlacementStack: (props: Record<string, unknown>) => React.createElement('PluginSurfacePlacementStackStub', props),
}));

// The shared mock installer above runs during module evaluation. Load the panel after those
// boundaries are installed, but before individual assertions so graph transform time cannot
// consume the test-body timeout and cascade unmounted-renderer failures under shared load.
const { SessionRightPanel } = await import('./SessionRightPanel');

const REVIEW_PLUGIN_ID = 'acme.review';

function createPluginProjection(input: Readonly<{
    includeSameDestinationDetailsTab?: boolean;
    includePhoneRejectedRightPane?: boolean;
}> = {}): PluginUiProjectionModel {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: REVIEW_PLUGIN_ID,
        destinationId: 'review-panel',
        rendererId: 'review-panel-web',
        container: 'rightSidebarTab',
        target: { kind: 'session' },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 session right-sidebar binding');
    }
    const placement = {
        id: `surfacePlacement:${REVIEW_PLUGIN_ID}:review-panel`,
        pluginId: REVIEW_PLUGIN_ID,
        contributionKind: 'surfacePlacement',
        descriptorId: 'review-panel',
        binding,
        target: binding.target,
        renderer: { kind: 'hostedWeb', contributionId: 'review-panel-web' },
        display: { developerFallback: 'Review' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
        hostOrigin: {
            machineId: 'machine-1',
            serverId: 'server-1',
            generation: 4,
            phase: 'current',
            interactionEnabled: true,
            executionOrigin: {
                serverIdentityId: 'srv_account_one',
                materializationRef: {
                    pluginId: REVIEW_PLUGIN_ID,
                    machineId: 'machine-1',
                    materializationId: 'review-panel-install-a',
                },
            } satisfies PluginMachineExecutionOriginV1,
        },
    } satisfies PluginUiSurfacePlacementProjection;
    const detailsBinding = input.includeSameDestinationDetailsTab
        ? normalizePluginUiDestinationBindingV1({
            pluginId: REVIEW_PLUGIN_ID,
            destinationId: 'review-panel',
            rendererId: 'review-panel-details',
            container: 'detailsTab',
            target: { kind: 'session' },
        })
        : null;
    if (input.includeSameDestinationDetailsTab && !detailsBinding) {
        throw new Error('test fixture must use an admitted V2 session details binding');
    }
    const detailsPlacement = detailsBinding
        ? {
            ...placement,
            id: `surfacePlacement:${REVIEW_PLUGIN_ID}:review-panel-details`,
            descriptorId: 'review-panel-details',
            binding: detailsBinding,
            target: detailsBinding.target,
            renderer: { kind: 'hostedWeb' as const, contributionId: 'review-panel-details' },
        }
        : null;
    const rejectedPaneBinding = input.includePhoneRejectedRightPane
        ? normalizePluginUiDestinationBindingV1({
            pluginId: REVIEW_PLUGIN_ID,
            destinationId: 'review-pane',
            rendererId: 'review-pane-web',
            container: 'rightPane',
            target: { kind: 'session' },
            instancePolicy: 'multiple',
        })
        : null;
    if (input.includePhoneRejectedRightPane && !rejectedPaneBinding) {
        throw new Error('test fixture must admit the right pane before runtime form-factor filtering');
    }
    const rejectedPanePlacement = rejectedPaneBinding
        ? {
            ...placement,
            id: `surfacePlacement:${REVIEW_PLUGIN_ID}:review-pane`,
            descriptorId: 'review-pane',
            binding: rejectedPaneBinding,
            target: rejectedPaneBinding.target,
            renderer: { kind: 'hostedWeb' as const, contributionId: 'review-pane-web' },
        }
        : null;
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 4,
        surfacePlacementsById: Object.freeze({
            [placement.id]: placement,
            ...(detailsPlacement ? { [detailsPlacement.id]: detailsPlacement } : {}),
            ...(rejectedPanePlacement ? { [rejectedPanePlacement.id]: rejectedPanePlacement } : {}),
        }),
    });
}

describe('SessionRightPanel right-sidebar registry tabs', () => {
    beforeEach(() => {
        terminalFeatureEnabled = true;
        scopeState = { right: { isOpen: true, activeTabId: 'browser', tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: null,
            phase: 'unavailable',
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
        };
        useScopedPluginUiProjectionMock.mockReset();
        useScopedPluginUiProjectionMock.mockImplementation(() => pluginProjectionState.value);
        sessionRightPanelDeviceType.value = 'tablet';
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        selectRightDestinationSpy.mockClear();
    });

    it('drops the Browser tab on desktop but keeps Services (D1)', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'services', tabState: {} } };
        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        // D1: the desktop right sidebar no longer shows a Browser tab; Services is the single
        // desktop services/launch surface.
        expect(screen.findByTestId('session-rightpanel-tab:browser')).toBeNull();
        expect(screen.findByTestId('session-rightpanel-surface-browser')).toBeNull();
        expect(screen.findByTestId('session-rightpanel-tab:services')).toBeTruthy();
    });

    it('renders the Services surface through the local services owner', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'services', tabState: {} } };
        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-rightpanel-surface-services')).toBeTruthy();
        expect(screen.findByType('DetectedLocalServicesPaneStub')).toBeTruthy();
    });

    it('threads registered target/projection facts into Services without a second Session lookup', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'services', tabState: {} } };
        const screen = await renderScreen(
            <SessionRightPanel
                sessionId="s1"
                scopeId="session:s1"
                paneSurfaceScope={{
                    targetKind: 'session',
                    sessionId: 's1',
                    machineId: 'machine-pane-driver',
                    serverId: 'server-pane-driver',
                    pluginUiProjection: null,
                    projectionPhase: 'unavailable',
                    interactionEnabled: false,
                    platform: 'web',
                }}
            />,
        );

        const servicesHost = screen.findByType('DetectedLocalServicesPaneStub' as never);
        expect(servicesHost.props.machineId).toBe('machine-pane-driver');
        expect(servicesHost.props.serverId).toBe('server-pane-driver');
        expect(servicesHost.props.pluginUiProjection).toBeNull();
        expect(servicesHost.props.projectionInteractionEnabled).toBe(false);
    });

    it('retains incumbent lookup for a direct right-panel route without a supplied scope', async () => {
        scopeState = { right: { isOpen: true, activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`, tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: createPluginProjection(),
            phase: 'current',
            interactionEnabled: true,
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
        };
        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId(`session-rightpanel-tab:plugin:${REVIEW_PLUGIN_ID}:review-panel`)).toBeTruthy();
        expect(screen.findByTestId(`session-rightpanel-surface-plugin:${REVIEW_PLUGIN_ID}:review-panel`)).toBeTruthy();
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.placement.descriptorId).toBe('review-panel');
        expect(host.props.machineId).toBe('machine-1');
        expect(host.props.serverId).toBe('server-1');
    });

    it('uses the Session target owner exactly once when the mounted panel joins its host binding', async () => {
        const projection = createPluginProjection();
        const placement = projection.surfacePlacementsById[`surfacePlacement:${REVIEW_PLUGIN_ID}:review-panel`]!;
        const shellRightSidebarOwner = vi.fn(async () => ({ ok: true as const }));
        const targetBinding = createPluginSurfaceDestinationNavigationBinding({
            placements: [placement],
            targetKind: 'session',
            runtimeAdmission: { platform: 'web', formFactor: 'tablet' },
        });
        targetBinding.registerOwner({
            container: 'rightSidebarTab',
            handler: shellRightSidebarOwner,
        });
        scopeState = { right: { isOpen: true, activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`, tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: projection,
            phase: 'current',
            interactionEnabled: true,
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
        };

        const screen = await renderScreen(
            <PluginSurfaceDestinationNavigationBindingProvider binding={targetBinding}>
                <SessionRightPanel sessionId="s1" scopeId="session:s1" />
            </PluginSurfaceDestinationNavigationBindingProvider>,
        );
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        const openSurface = host.props.binding.openSurface as (request: Readonly<{
            destination: Readonly<{ pluginId: string; localId: string }>;
        }>) => Promise<unknown>;

        await expect(openSurface({
            destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'review-panel' },
        })).resolves.toEqual({ ok: true });
        expect(shellRightSidebarOwner).toHaveBeenCalledTimes(1);
    });

    it('rejects a desktop/tablet Session pane before the phone screen delegates to an unavailable owner', async () => {
        sessionRightPanelDeviceType.value = 'phone';
        const projection = createPluginProjection({ includePhoneRejectedRightPane: true });
        scopeState = {
            right: {
                isOpen: true,
                activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
                tabState: {},
            },
        };
        const screen = await renderScreen(
            <SessionRightPanel
                sessionId="s1"
                scopeId="session:s1"
                presentation="screen"
                paneSurfaceScope={{
                    targetKind: 'session',
                    sessionId: 's1',
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    pluginUiProjection: projection,
                    projectionPhase: 'current',
                    interactionEnabled: true,
                    platform: 'ios',
                }}
            />,
        );
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        const openSurface = host.props.binding?.openSurface as undefined | ((request: Readonly<{
            destination: { pluginId: string; localId: string };
            instanceKey?: string;
        }>) => Promise<unknown> | unknown);

        expect(openSurface).toBeTypeOf('function');
        if (!openSurface) throw new Error('right-panel mount did not receive an openSurface handler');
        await expect(openSurface({
            destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'review-pane' },
            instanceKey: 'issue-42',
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_platform_unavailable',
        });
        expect(selectRightDestinationSpy).not.toHaveBeenCalled();
    });

    it('uses the registered driver scope rather than ambient Session target/projection facts', async () => {
        const driverProjection = createPluginProjection();
        const ambientProjection = Object.freeze({
            ...createPluginProjection(),
            generation: 99,
        });
        scopeState = { right: { isOpen: true, activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`, tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: ambientProjection,
            phase: 'current',
            interactionEnabled: true,
            machineId: 'machine-ambient',
            serverId: 'server-ambient',
            platform: 'web',
        };
        const screen = await renderScreen(
            <SessionRightPanel
                sessionId="s1"
                scopeId="session:s1"
                paneSurfaceScope={{
                    targetKind: 'session',
                    sessionId: 's1',
                    machineId: 'machine-pane-driver',
                    serverId: 'server-pane-driver',
                    pluginUiProjection: driverProjection,
                    projectionPhase: 'current',
                    interactionEnabled: true,
                    platform: 'web',
                }}
            />,
        );

        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.pluginUiProjection).toBe(driverProjection);
        expect(host.props.machineId).toBe('machine-pane-driver');
        expect(host.props.serverId).toBe('server-pane-driver');
    });

    it('fails closed when a supplied driver scope belongs to another Session', async () => {
        scopeState = { right: { isOpen: true, activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`, tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: createPluginProjection(),
            phase: 'current',
            interactionEnabled: true,
            machineId: 'machine-ambient',
            serverId: 'server-ambient',
            platform: 'web',
        };
        const screen = await renderScreen(
            <SessionRightPanel
                sessionId="s1"
                scopeId="session:s1"
                paneSurfaceScope={{
                    targetKind: 'session',
                    sessionId: 's2',
                    machineId: 'machine-wrong-session',
                    serverId: 'server-wrong-session',
                    pluginUiProjection: createPluginProjection(),
                    projectionPhase: 'current',
                    interactionEnabled: true,
                    platform: 'web',
                }}
            />,
        );

        expect(screen.findAllByType('PluginSurfacePlacementHostStub' as never)).toHaveLength(0);
        expect(useScopedPluginUiProjectionMock).toHaveBeenCalledWith({
            machineId: null,
            serverId: null,
            enabled: false,
        });
    });

    it('does not silently choose the sidebar when the full session projection has a conflicting exact binding', async () => {
        scopeState = { right: { isOpen: true, activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`, tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: createPluginProjection({ includeSameDestinationDetailsTab: true }),
            phase: 'current',
            interactionEnabled: true,
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
        };
        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        const openSurface = host.props.binding.openSurface as (request: Readonly<{
            destination: Readonly<{ pluginId: string; localId: string }>;
        }>) => Promise<unknown>;

        await expect(openSurface({
            destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'review-panel' },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_ambiguous',
        });
        expect(selectRightDestinationSpy).not.toHaveBeenCalled();
    });

    it('does not replace a restored plugin tab with a built-in before the projection is current', async () => {
        scopeState = { right: { isOpen: true, activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`, tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: null,
            phase: 'establishing',
            interactionEnabled: false,
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
        };
        await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        expect(setRightTabSpy).not.toHaveBeenCalled();
    });

    it('hands a retained offline projection to the plugin host instead of showing projection loading forever', async () => {
        scopeState = {
            right: {
                isOpen: true,
                activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
                selectedDestination: {
                    kind: 'plugin',
                    destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'review-panel' },
                },
                tabState: {},
            },
        };
        pluginProjectionState.value = {
            pluginUiProjection: createPluginProjection(),
            phase: 'retainedOffline',
            // Phase, rather than this legacy boolean, is authoritative at
            // the mounted host boundary.
            interactionEnabled: true,
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
        };
        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.projectionInteractionEnabled).toBe(false);
    });
});
