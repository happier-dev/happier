import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let terminalFeatureEnabled = true;
let scopeState: any = {
    right: { isOpen: true, activeTabId: 'browser', tabState: {} },
};

const pluginProjectionState = vi.hoisted<{
    value: {
        pluginUiProjection: unknown;
        machineId: string | null;
        serverId: string | null;
        platform: 'web';
    };
}>(() => ({
    value: {
        pluginUiProjection: null,
        machineId: 'machine-1',
        serverId: 'server-1',
        platform: 'web',
    },
}));

const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();

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
    useDeviceType: () => 'desktop',
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState,
        openRight: openRightSpy,
        setRightTab: setRightTabSpy,
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
    useScopedPluginUiProjection: () => pluginProjectionState.value,
}));

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: (props: Record<string, unknown>) => React.createElement('PluginSurfacePlacementHostStub', props),
    PluginSurfacePlacementStack: (props: Record<string, unknown>) => React.createElement('PluginSurfacePlacementStackStub', props),
}));

function createPluginProjection() {
    const placement = {
        id: 'pluginUi:review:surfacePlacement:review-panel',
        pluginId: 'review',
        contributionKind: 'surfacePlacement',
        descriptorId: 'review-panel',
        placement: 'session.rightSidebarTab',
        target: { kind: 'session' },
        renderer: { kind: 'host', rendererId: 'review.panel' },
        display: { developerFallback: 'Review' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        order: 70,
        rightSidebar: {
            tabId: 'review',
            scope: 'session',
            order: 70,
            mobile: { enabled: true, surface: 'pluginTab' },
            disabledPolicy: 'disable',
        },
    };
    return Object.freeze({
        generation: 4,
        translationsByPluginId: Object.freeze({}),
        structuredMessagesByKind: Object.freeze({}),
        sessionHeaderActionsById: Object.freeze({}),
        hostedWebById: Object.freeze({}),
        reactNativeBundlesById: Object.freeze({}),
        surfacePlacementsById: Object.freeze({ [placement.id]: placement }),
        surfacePlacementsByPlacement: Object.freeze({ 'session.rightSidebarTab': Object.freeze([placement]) }),
        uiArtifactsById: Object.freeze({}),
        digestsByPluginId: Object.freeze({}),
        unknownEntriesById: Object.freeze({}),
    });
}

describe('SessionRightPanel right-sidebar registry tabs', () => {
    beforeEach(() => {
        terminalFeatureEnabled = true;
        scopeState = { right: { isOpen: true, activeTabId: 'browser', tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: null,
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
        };
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
    });

    it('drops the Browser tab on desktop but keeps Services (D1)', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'services', tabState: {} } };
        const { SessionRightPanel } = await import('./SessionRightPanel');

        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        // D1: the desktop right sidebar no longer shows a Browser tab; Services is the single
        // desktop services/launch surface.
        expect(screen.findByTestId('session-rightpanel-tab:browser')).toBeNull();
        expect(screen.findByTestId('session-rightpanel-surface-browser')).toBeNull();
        expect(screen.findByTestId('session-rightpanel-tab:services')).toBeTruthy();
    });

    it('renders the Services surface through the local services owner', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'services', tabState: {} } };
        const { SessionRightPanel } = await import('./SessionRightPanel');

        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-rightpanel-surface-services')).toBeTruthy();
        expect(screen.findByType('DetectedLocalServicesPaneStub')).toBeTruthy();
    });

    it('renders plugin right-sidebar tabs through PluginSurfacePlacementHost', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'plugin:review:review', tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: createPluginProjection(),
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
        };
        const { SessionRightPanel } = await import('./SessionRightPanel');

        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-rightpanel-tab:plugin:review:review')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-surface-plugin:review:review')).toBeTruthy();
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.placement.descriptorId).toBe('review-panel');
        expect(host.props.machineId).toBe('machine-1');
        expect(host.props.serverId).toBe('server-1');
    });
});
