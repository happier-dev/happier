import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { View } from 'react-native';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';


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
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => {
                if (key === 'embeddedTerminalDockLocation') return embeddedTerminalDockLocation;
                return null;
            },
            useMachineCliDetectionTarget: () => ({ daemonStateVersion: 1, isOnline: true }),
        });
    },
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
    FontWeights: { regular: '400', semiBold: '500', bold: '600' },
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
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machineContributionRegistryProjectionDescribe: (...args: readonly unknown[]) => machineProjectionDescribeMock(...args),
    // This pane test does not exercise settings I/O; preserve the daemon
    // boundary while satisfying the current scoped-settings runtime import.
    machinePluginSettingsGet: vi.fn(),
    machinePluginSettingsSet: vi.fn(),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

const SCOPED_PLUGIN_ID = 'acme.scoped';
const GLOBAL_PLUGIN_ID = 'acme.global';

function createRightSidebarProjection(params: Readonly<{
    pluginId: string;
    descriptorId: string;
}>): PluginUiProjectionModel {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: params.pluginId,
        destinationId: params.descriptorId,
        rendererId: `${params.descriptorId}-web`,
        container: 'rightSidebarTab',
        target: { kind: 'session' },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 session right-sidebar binding');
    }
    const placement = {
        id: `surfacePlacement:${params.pluginId}:${params.descriptorId}`,
        pluginId: params.pluginId,
        contributionKind: 'surfacePlacement' as const,
        descriptorId: params.descriptorId,
        binding,
        target: binding.target,
        renderer: { kind: 'hostedWeb', contributionId: `${params.descriptorId}-web` },
        display: { developerFallback: params.descriptorId },
        availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
        headerActions: [],
    } satisfies PluginUiSurfacePlacementProjection;
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 4,
        surfacePlacementsById: Object.freeze({ [placement.id]: placement }),
    });
}

function createDaemonProjection(params: Readonly<{
    pluginId: string;
    descriptorId: string;
}>) {
    const model = createRightSidebarProjection(params);
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: model.generation,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: model.surfacePlacementsById,
            },
        },
        diagnostics: [],
    });
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
            pluginId: SCOPED_PLUGIN_ID,
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
        scopeState = { right: { isOpen: true, activeTabId: `plugin:${SCOPED_PLUGIN_ID}:scoped-session-tab`, tabState: {} } };
        const {
            AppShellPluginUiProjectionValueProvider,
        } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { SessionRightPanel } = await import('./SessionRightPanel');

        const screen = await renderScreen(
            <AppShellPluginUiProjectionValueProvider
                value={{
                    pluginUiProjection: createRightSidebarProjection({
                        pluginId: GLOBAL_PLUGIN_ID,
                        descriptorId: 'global-session-tab',
                    }),
                    pluginBrowserProjection: null,
                    phase: 'current',
                    interactionEnabled: true,
                    machineId: 'machine-global',
                    serverId: 'server-global',
                    platform: 'web',
                    clientExecutableActivation: { status: 'ready' },
                    reloadClientExecutables: () => {},
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
        expect(screen.findByTestId(`session-rightpanel-tab:plugin:${GLOBAL_PLUGIN_ID}:global-session-tab`)).toBeNull();
        expect(screen.findByTestId(`session-rightpanel-tab:plugin:${SCOPED_PLUGIN_ID}:scoped-session-tab`)).toBeTruthy();
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.machineId).toBe('machine-session');
        expect(host.props.serverId).toBe('server-session');
        expect(host.props.placement.descriptorId).toBe('scoped-session-tab');
    });
});
