import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { View } from 'react-native';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 12, left: 0, right: 0 }),
}));

let terminalFeatureEnabled = false;
let embeddedTerminalDockLocation: 'sidebar' | 'details' | 'bottom' = 'sidebar';

const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
const machineProjectionDescribeMock = vi.fn();

let scopeState: any = {
    right: { isOpen: true, activeTabId: 'git', tabState: {} },
};

installSessionDetailsPanelCommonModuleMocks({
    storage: async () => ({
        useLocalSetting: (key: string) => {
            if (key === 'embeddedTerminalDockLocation') return embeddedTerminalDockLocation;
            return null;
        },
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => key,
            translateLoose: (key) => key,
            getPreferredLanguage: () => 'en',
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
        tabular: () => ({}),
    },
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (fn: any) => fn(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'terminal.embeddedPty' ? terminalFeatureEnabled : false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
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

vi.mock('@/components/sessions/panes/terminal/SessionRightPanelTerminalView', () => ({
    SessionRightPanelTerminalView: () => React.createElement('TerminalView'),
}));

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: (props: Record<string, unknown>) => React.createElement('PluginSurfacePlacementHostStub', props),
}));

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({ machineId: 'machine-session', basePath: '/repo' }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-session',
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: readonly unknown[]) => machineProjectionDescribeMock(...args),
}));

function createRightSidebarProjection(params: Readonly<{
    pluginId: string;
    tabId: string;
    descriptorId: string;
    targetKind?: string;
}>): PluginUiProjectionModel {
    const placement = {
        id: `pluginUi:${params.pluginId}:surfacePlacement:${params.descriptorId}`,
        pluginId: params.pluginId,
        contributionKind: 'surfacePlacement' as const,
        descriptorId: params.descriptorId,
        placement: 'session.rightSidebarTab',
        target: { kind: params.targetKind ?? 'session' },
        renderer: { kind: 'host', rendererId: 'session.testPanel' },
        display: { developerFallback: params.descriptorId },
        availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
        order: 70,
        rightSidebar: {
            tabId: params.tabId,
            scope: 'session',
            order: 70,
            mobile: { enabled: true, surface: 'pluginTab' },
            disabledPolicy: 'hide',
        },
    };
    return Object.freeze({
        generation: 4,
        translationsByPluginId: Object.freeze({}),
        structuredMessagesByKind: Object.freeze({}),
        sessionHeaderActionsById: Object.freeze({}),
        hostedWebById: Object.freeze({}),
        reactNativeBundlesById: Object.freeze({}),
        embeddedWebBundlesById: Object.freeze({}),
        surfacePlacementsById: Object.freeze({ [placement.id]: placement }),
        surfacePlacementsByPlacement: Object.freeze({ 'session.rightSidebarTab': Object.freeze([placement]) }),
        uiArtifactsById: Object.freeze({}),
        digestsByPluginId: Object.freeze({}),
        unknownEntriesById: Object.freeze({}),
    });
}

function createDaemonProjection(params: Readonly<{
    pluginId: string;
    tabId: string;
    descriptorId: string;
    targetKind?: string;
}>) {
    const model = createRightSidebarProjection(params);
    return {
        v: 2,
        generation: model.generation,
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: model.surfacePlacementsById,
            },
        },
    };
}

describe('SessionRightPanel (terminal tab)', () => {
    beforeEach(() => {
        terminalFeatureEnabled = false;
        embeddedTerminalDockLocation = 'sidebar';
        scopeState = { right: { isOpen: true, activeTabId: 'git', tabState: {} } };
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        machineProjectionDescribeMock.mockReset();
        machineProjectionDescribeMock.mockResolvedValue({ supported: true, projection: createDaemonProjection({
            pluginId: 'scoped',
            tabId: 'scoped',
            descriptorId: 'scoped-session-tab',
        }) });
        vi.clearAllMocks();
    });

    async function renderPanel() {
        const mod = await import('./SessionRightPanel');
        const SessionRightPanel = mod.SessionRightPanel;
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />)).tree;
        return { tree: tree!, SessionRightPanel };
    }

    it('shows the terminal tab only when the feature is enabled', async () => {
        terminalFeatureEnabled = false;
        const initial = await renderPanel();
        expect(initial.tree.findAll((node) => node.props?.testID === 'session-rightpanel-tab:terminal')).toHaveLength(0);

        terminalFeatureEnabled = true;
        embeddedTerminalDockLocation = 'bottom';
        const dockedElsewhere = await renderPanel();
        expect(dockedElsewhere.tree.findAll((node) => node.props?.testID === 'session-rightpanel-tab:terminal')).toHaveLength(0);

        embeddedTerminalDockLocation = 'sidebar';
        const enabled = await renderPanel();
        expect(enabled.tree.findAll((node) => node.props?.testID === 'session-rightpanel-tab:terminal')).toHaveLength(1);
    });

    it('pads the panel root by the iOS safe-area inset at the top', async () => {
        const { tree } = await renderPanel();
        const root = tree.findByProps({ testID: 'session-right-panel-root' });
        const rootStyle = Array.isArray(root.props.style)
            ? Object.assign({}, ...root.props.style.filter(Boolean))
            : root.props.style;
        expect(rootStyle.paddingTop ?? 0).toBe(0);

        const header = root.findAll((node) => {
            if (node.type !== View) return false;
            const style = Array.isArray(node.props?.style)
                ? Object.assign({}, ...node.props.style.filter(Boolean))
                : node.props?.style;
            return style?.flexDirection === 'row' && typeof style?.borderBottomWidth === 'number';
        })[0];

        const headerStyle = Array.isArray(header?.props?.style)
            ? Object.assign({}, ...header.props.style.filter(Boolean))
            : header?.props?.style;

        // Base header padding (10) + safe-area inset (24)
        expect(headerStyle?.paddingTop).toBe(34);
    });

    it('renders session plugin tabs from the scoped session machine instead of the app-shell machine', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'plugin:scoped:scoped', tabState: {} } };
        const {
            AppShellPluginUiProjectionValueProvider,
        } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { SessionRightPanel } = await import('./SessionRightPanel');

        const screen = await renderScreen(
            <AppShellPluginUiProjectionValueProvider
                value={{
                    pluginUiProjection: createRightSidebarProjection({
                        pluginId: 'global',
                        tabId: 'global',
                        descriptorId: 'global-session-tab',
                    }),
                    machineId: 'machine-global',
                    serverId: 'server-global',
                    platform: 'web',
                }}
            >
                <SessionRightPanel sessionId="s1" scopeId="session:s1" />
            </AppShellPluginUiProjectionValueProvider>,
        );
        await flushHookEffects({ cycles: 8, turns: 3 });

        expect(machineProjectionDescribeMock).toHaveBeenCalledWith(
            'machine-session',
            expect.objectContaining({ serverId: 'server-session' }),
        );
        expect(screen.findByTestId('session-rightpanel-tab:plugin:global:global')).toBeNull();
        expect(screen.findByTestId('session-rightpanel-tab:plugin:scoped:scoped')).toBeTruthy();
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.machineId).toBe('machine-session');
        expect(host.props.serverId).toBe('server-session');
        expect(host.props.placement.descriptorId).toBe('scoped-session-tab');
    });
});
