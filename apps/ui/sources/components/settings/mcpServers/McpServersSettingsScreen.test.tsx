import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DetectedMcpServerV1, McpServersSettingsV1 } from '@happier-dev/protocol';

import { listDetectedMcpProviderIds, listMcpPreviewAgentIds } from './mcpServerScreenHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const {
    routerPushSpy,
    machineMcpServersDetectSpy,
    machineMcpServersPreviewSpy,
    setMcpSettingsSpy,
    modalConfirmSpy,
} = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    machineMcpServersDetectSpy: vi.fn(async () => ({ ok: true, servers: [] as DetectedMcpServerV1[] })),
    machineMcpServersPreviewSpy: vi.fn(async () => ({ ok: true, builtIn: [], managed: [], detected: [] })),
    setMcpSettingsSpy: vi.fn(),
    modalConfirmSpy: vi.fn(async () => true),
}));

const DropdownMenuMock = (props: any) => React.createElement('DropdownMenu', props);
const settingsState: { value: McpServersSettingsV1 } = {
    value: { v: 1, strictMode: false, servers: [], bindings: [] },
};

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    AppState: {
        currentState: 'active',
        addEventListener: () => ({ remove: () => {} }),
    },
    Platform: {
        OS: 'web',
        select: <T,>(options: { default?: T; web?: T }) => options.web ?? options.default ?? null,
    },
    Dimensions: { get: () => ({ width: 1440, height: 900 }) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => {
            const theme = {
                colors: {
                    text: '#fff',
                    textSecondary: '#999',
                    textDestructive: '#f00',
                    success: '#0f0',
                    divider: '#333',
                    input: { background: '#111', text: '#fff', placeholder: '#777' },
                    groupped: { background: '#111', sectionTitle: '#999' },
                    surface: '#222',
                    button: {
                        primary: { background: '#08f', tint: '#fff' },
                        secondary: { background: '#222', tint: '#fff' },
                    },
                    accent: { purple: '#a0f', blue: '#00f', indigo: '#44f', green: '#0f0' },
                },
            };
            return typeof factory === 'function' ? factory(theme) : factory;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#fff',
                textSecondary: '#999',
                textDestructive: '#f00',
                success: '#0f0',
                divider: '#333',
                input: { background: '#111', text: '#fff', placeholder: '#777' },
                groupped: { background: '#111', sectionTitle: '#999' },
                surface: '#222',
                button: {
                    primary: { background: '#08f', tint: '#fff' },
                    secondary: { background: '#222', tint: '#fff' },
                },
                accent: { purple: '#a0f', blue: '#00f', indigo: '#44f', green: '#0f0' },
            },
        },
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.subtitle ?? null, props.subtitleAccessory ?? null, props.rightElement ?? null),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/components/settings/mcpServers/McpServerRowSummary', () => ({
    McpServerRowSummary: (props: any) => React.createElement('McpServerRowSummary', props),
}));

vi.mock('@/components/settings/mcpServers/McpServerBadgePills', () => ({
    McpServerBadgePills: (props: any) => React.createElement('McpServerBadgePills', props),
}));

vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({
    SegmentedTabBar: (props: any) => React.createElement('SegmentedTabBar', props),
}));

vi.mock('@/components/settings/mcpServers/McpSegmentedHeader', () => ({
    McpSegmentedHeader: (props: any) => React.createElement('McpSegmentedHeader', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/modal', () => ({
    Modal: { show: vi.fn(), alert: vi.fn(), confirm: modalConfirmSpy },
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: DropdownMenuMock,
}));

vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({
    PathInputBrowseButton: (props: any) => React.createElement('PathInputBrowseButton', props),
}));

vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: vi.fn(async () => null),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (action: any) => [false, action],
}));

vi.mock('@/sync/ops/machineMcpServers', async () => {
    const actual = await vi.importActual<any>('@/sync/ops/machineMcpServers');
    return {
        ...actual,
        machineMcpServersDetect: machineMcpServersDetectSpy,
        machineMcpServersPreview: machineMcpServersPreviewSpy,
    };
});

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => [{ id: 'machine-1', metadata: { displayName: 'Machine 1', host: 'machine-1.local' } }],
    useMachineListByServerId: () => ({}),
    useMachineListStatusByServerId: () => ({}),
    useSetting: (key: string) => {
        if (key === 'serverSelectionGroups') return [];
        return null;
    },
    useSettingMutable: (key: string) => {
        if (key === 'mcpServersSettingsV1') {
            return [settingsState.value, setMcpSettingsSpy];
        }
        if (key === 'secrets') return [[], vi.fn()];
        if (key === 'favoriteDirectories') return [[], vi.fn()];
        return [null, vi.fn()];
    },
}));

describe('McpServersSettingsScreen', () => {
    beforeEach(() => {
        routerPushSpy.mockReset();
        machineMcpServersDetectSpy.mockReset();
        machineMcpServersPreviewSpy.mockReset();
        setMcpSettingsSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalConfirmSpy.mockResolvedValue(true);
        machineMcpServersDetectSpy.mockResolvedValue({ ok: true, servers: [] as DetectedMcpServerV1[] });
        machineMcpServersPreviewSpy.mockResolvedValue({ ok: true, builtIn: [], managed: [], detected: [] });
        settingsState.value = {
            v: 1,
            strictMode: false,
            servers: [{
                id: 'server-1',
                name: 'playwright',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
                env: {},
                createdAt: 1,
                updatedAt: 1,
            }],
            bindings: [{
                id: 'binding-1',
                serverId: 'server-1',
                enabled: true,
                target: { t: 'machine', machineId: 'machine-1' },
                createdAt: 1,
                updatedAt: 1,
            }],
        };
    });

    function findByTestId(tree: ReactTestRenderer, testID: string) {
        return tree.root.findAll((node) => node.props?.testID === testID)[0] ?? null;
    }

    it('renders the canonical MCP settings hero, tabs, and quick install rows', async () => {
        const { McpServersSettingsScreen } = await import('./McpServersSettingsScreen');
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(McpServersSettingsScreen));
        });

        const header = tree.root.findAllByType('McpSegmentedHeader')[0];
        expect(header).toBeTruthy();
        expect(header.props.title).toBe('settings.mcpServers');
        const tabIds = header.props.tabs.map((tab: { id: string }) => tab.id);
        expect(tabIds).toEqual([
            'configured',
            'detected',
            'preview',
        ]);

        const configuredRow = findByTestId(tree, 'mcp.server.card.server-1');
        expect(configuredRow).toBeTruthy();
        expect(configuredRow!.props.title).toBe('playwright');
        expect(configuredRow!.props.subtitle).toBe('npx -y @playwright/mcp@latest');
        expect(configuredRow!.props.subtitleAccessory).toBeTruthy();
        expect(configuredRow!.props.detail).toBeUndefined();
        expect(configuredRow!.props.rightElement).toBeTruthy();
        expect(findByTestId(tree, 'settings.mcpServers.addServer')).toBeTruthy();
        expect(findByTestId(tree, 'settings.mcpServers.quickInstall.playwright')).toBeTruthy();

        const quickInstallPlaywright = findByTestId(tree, 'settings.mcpServers.quickInstall.playwright');
        expect(quickInstallPlaywright).toBeTruthy();
        const allItems = tree.root.findAllByType('Item');
        const configuredIndex = allItems.findIndex((item) => item.props?.testID === 'mcp.server.card.server-1');
        const addServerIndex = allItems.findIndex((item) => item.props?.testID === 'settings.mcpServers.addServer');
        const quickInstallIndex = allItems.findIndex((item) => item.props?.testID === 'settings.mcpServers.quickInstall.playwright');
        expect(addServerIndex).toBeGreaterThan(configuredIndex);
        expect(addServerIndex).toBeLessThan(quickInstallIndex);

        const badgePillsNode = tree.root.findAllByType('McpServerBadgePills')[0];
        expect(badgePillsNode).toBeTruthy();
        expect(badgePillsNode.props.size).toBe('compact');
        expect(badgePillsNode.props.badges).toEqual([
            { key: 'server-1:scope:0', label: 'Machine 1' },
        ]);

        const rowActions = tree.root.findAllByType('ItemRowActions')[0];
        expect(rowActions).toBeTruthy();
        expect(rowActions.props.actions.map((action: { id: string }) => action.id)).toEqual(['edit', 'delete']);

        await act(async () => {
            quickInstallPlaywright!.props.onPress?.();
        });
        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/mcp-server',
            params: { addMode: 'quick-install', presetId: 'playwright' },
        });

        await act(async () => {
            header.props.onSelectTab?.('detected');
            await Promise.resolve();
        });
        expect(findByTestId(tree, 'settings.mcpServers.detect.refresh')).toBeTruthy();
        expect(machineMcpServersDetectSpy).toHaveBeenCalledWith('machine-1', {
            providers: listDetectedMcpProviderIds(),
            directory: undefined,
        });

        await act(async () => {
            header.props.onSelectTab?.('preview');
            await Promise.resolve();
        });
        expect(findByTestId(tree, 'settings.mcpServers.preview.refresh')).toBeTruthy();

        const agentDropdown = tree.root.findAllByType(DropdownMenuMock).find((node) =>
            node.props?.itemTrigger?.title === 'settings.mcpServersPreviewAgentTitle'
        );
        expect(agentDropdown).toBeTruthy();
        expect(agentDropdown!.props.items.map((item: { id: string }) => item.id)).toEqual(
            expect.arrayContaining(listMcpPreviewAgentIds()),
        );

        await act(async () => {
            header.props.onSelectTab?.('configured');
        });
        const addRow = findByTestId(tree, 'settings.mcpServers.addServer');
        expect(addRow).toBeTruthy();
        await act(async () => {
            addRow!.props.onPress?.();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/mcp-server');

        const deleteAction = tree.root.findAllByType('ItemRowActions')[0]?.props.actions[1];
        expect(deleteAction).toBeTruthy();
        await act(async () => {
            await deleteAction.onPress();
        });
        expect(modalConfirmSpy).toHaveBeenCalled();
        expect(setMcpSettingsSpy).toHaveBeenCalledWith({
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        });
    });

    it('refreshes detected servers when the user requests a detect pass with the current context', async () => {
        machineMcpServersDetectSpy.mockResolvedValue({
            ok: true,
            servers: [{
                provider: 'codex',
                name: 'playwright',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
                envKeys: [],
                enabled: true,
                source: { kind: 'user', path: '~/.codex/config.toml' },
            }],
        });

        const { McpServersSettingsScreen } = await import('./McpServersSettingsScreen');
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(McpServersSettingsScreen));
        });

        const header = tree.root.findAllByType('McpSegmentedHeader')[0];
        await act(async () => {
            header.props.onSelectTab?.('detected');
            await Promise.resolve();
        });

        const detectedRow = findByTestId(tree, 'mcp.detected.card.0');
        expect(detectedRow).toBeTruthy();

        const directoryInput = findByTestId(tree, 'settings.mcpServers.detect.directoryInput');
        await act(async () => {
            directoryInput!.props.onChangeText?.('/repo/project');
            await Promise.resolve();
        });

        const detectedRowAfterRefresh = findByTestId(tree, 'mcp.detected.card.0');
        expect(detectedRowAfterRefresh).toBeTruthy();

        expect(machineMcpServersDetectSpy).toHaveBeenLastCalledWith('machine-1', {
            providers: listDetectedMcpProviderIds(),
            directory: '/repo/project',
        });
    });
});
