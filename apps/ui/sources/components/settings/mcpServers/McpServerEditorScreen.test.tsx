import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const setMcpSettingsSpy = vi.fn();
let localSearchParamsValue: { serverId?: string } = { serverId: 'server-1' };
let liveMcpSettings: {
    v: 1;
    strictMode: boolean;
    servers: Array<{
        id: string;
        name: string;
        transport: 'stdio' | 'http' | 'sse';
        stdio?: { command: string; args: string[] };
        remote?: { url: string; headers: Record<string, unknown> };
        env: Record<string, unknown>;
        createdAt: number;
        updatedAt: number;
    }>;
    bindings: Array<{
        id: string;
        serverId: string;
        enabled: boolean;
        target: { t: 'machine'; machineId: string };
        createdAt: number;
        updatedAt: number;
    }>;
};
let liveSecrets: SavedSecret[] = [];
const liveSettingListeners = new Set<() => void>();

function notifyLiveSettingListeners() {
    for (const listener of liveSettingListeners) {
        listener();
    }
}

function resetLiveSettings() {
    liveMcpSettings = {
        v: 1,
        strictMode: false,
        servers: [{
            id: 'server-1',
            name: 'server',
            transport: 'stdio',
            stdio: { command: 'node', args: ['server.js'] },
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
    liveSecrets = [];
    localSearchParamsValue = { serverId: 'server-1' };
    liveSettingListeners.clear();
    setMcpSettingsSpy.mockReset();
}

function updateLiveSecrets(next: SavedSecret[]) {
    liveSecrets = next;
    notifyLiveSettingListeners();
}

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
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
                    groupped: { sectionTitle: '#999', background: '#111' },
                    input: { background: '#111', text: '#fff', placeholder: '#777' },
                    divider: '#333',
                    success: '#0f0',
                    textSecondary: '#999',
                    textDestructive: '#f00',
                    accent: { blue: '#00f', purple: '#a0f', indigo: '#44f', green: '#0f0' },
                    surface: '#222',
                    button: {
                        primary: { background: '#08f', tint: '#fff' },
                        secondary: { background: '#222', tint: '#fff' },
                    },
                },
            };
            return typeof factory === 'function' ? factory(theme) : factory;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#fff',
                groupped: { sectionTitle: '#999', background: '#111' },
                input: { background: '#111', text: '#fff', placeholder: '#777' },
                divider: '#333',
                success: '#0f0',
                textSecondary: '#999',
                textDestructive: '#f00',
                accent: { blue: '#00f', purple: '#a0f', indigo: '#44f', green: '#0f0' },
                surface: '#222',
                button: {
                    primary: { background: '#08f', tint: '#fff' },
                    secondary: { background: '#222', tint: '#fff' },
                },
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
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({
    SegmentedTabBar: (props: any) => React.createElement('SegmentedTabBar', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({
    PathInputBrowseButton: (props: any) => React.createElement('PathInputBrowseButton', props),
}));

vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: vi.fn(async () => null),
}));

vi.mock('@/components/ui/forms/InlineAddExpander', () => ({
    InlineAddExpander: (props: any) =>
        React.createElement('InlineAddExpander', props, props.isOpen ? props.children : null),
}));

vi.mock('@/components/settings/mcpServers/McpServerBindingEditor', () => ({
    McpServerBindingEditor: () => React.createElement('McpServerBindingEditor'),
}));

vi.mock('@/components/settings/mcpServers/McpServerTestPanel', () => ({
    McpServerTestPanel: () => React.createElement('McpServerTestPanel'),
}));

vi.mock('@/components/settings/mcpServers/McpValueRefMapEditor', () => ({
    McpValueRefMapEditor: () => React.createElement('McpValueRefMapEditor'),
}));

vi.mock('@/sync/ops/machineMcpServers', async () => {
    const actual = await vi.importActual<any>('@/sync/ops/machineMcpServers');
    return {
        ...actual,
        machineMcpServersPreview: vi.fn(async () => ({ ok: true, builtIn: [], managed: [], detected: [] })),
    };
});

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: vi.fn(async () => true),
    },
}));

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => localSearchParamsValue,
    useNavigation: () => ({ canGoBack: () => false }),
    useRouter: () => ({
        back: routerBackSpy,
        replace: routerReplaceSpy,
    }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => [{ id: 'machine-1', metadata: { displayName: 'Machine 1' } }],
    useSettingMutable: (key: string) => {
        const ReactModule = require('react') as typeof React;
        const [, forceUpdate] = ReactModule.useReducer((value: number) => value + 1, 0);

        ReactModule.useEffect(() => {
            const listener = () => forceUpdate();
            liveSettingListeners.add(listener);
            return () => {
                liveSettingListeners.delete(listener);
            };
        }, []);

        if (key === 'mcpServersSettingsV1') {
            return [liveMcpSettings, (next: typeof liveMcpSettings) => {
                setMcpSettingsSpy(next);
                liveMcpSettings = next;
                notifyLiveSettingListeners();
            }];
        }
        if (key === 'secrets') {
            return [liveSecrets, (next: SavedSecret[]) => {
                liveSecrets = next;
                notifyLiveSettingListeners();
            }];
        }
        return [null, vi.fn()];
    },
}));

function findTextInput(tree: ReactTestRenderer, predicate: (props: Record<string, unknown>) => boolean) {
    return tree.root.find((node) => String(node.type) === 'TextInput' && predicate(node.props as Record<string, unknown>));
}

function findItemByTitle(tree: ReactTestRenderer, title: string) {
    return tree.root.findAll((node) => node.props?.title === title)[0] ?? null;
}

beforeEach(() => {
    resetLiveSettings();
    routerBackSpy.mockReset();
    routerReplaceSpy.mockReset();
});

describe('McpServerEditorScreen', () => {
    it('falls back to the MCP settings screen after delete when there is no back stack entry', async () => {
        const { McpServerEditorScreen } = await import('./McpServerEditorScreen');
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(McpServerEditorScreen));
        });

        const deleteAction = tree.root.findAll((node) => node.props?.testID === 'mcp.server.editor.secondaryAction')[0];
        expect(deleteAction).toBeTruthy();

        await act(async () => {
            deleteAction!.props.onPress?.();
            await Promise.resolve();
        });

        expect(setMcpSettingsSpy).toHaveBeenCalledWith({
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/mcp');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('preserves a new server draft when unrelated secrets settings change', async () => {
        localSearchParamsValue = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const { McpServerEditorScreen } = await import('./McpServerEditorScreen');
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(McpServerEditorScreen));
        });

        const nameInput = findTextInput(tree, (props) => props.testID === 'mcp.server.editor.name');
        await act(async () => {
            nameInput.props.onChangeText?.('qa_remote_http_20260306');
        });

        const transportTabs = tree.root.findAllByType('SegmentedTabBar')[1];
        expect(transportTabs).toBeTruthy();
        await act(async () => {
            transportTabs.props.onSelectTab?.('http');
        });

        const urlInput = findTextInput(tree, (props) => props.placeholder === 'https://example.com/mcp');
        await act(async () => {
            urlInput.props.onChangeText?.('http://127.0.0.1:63254/mcp');
        });

        await act(async () => {
            updateLiveSecrets([{
                id: 'secret-live',
                name: 'qa_remote_http_auth_livefix_20260306',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'qa-remote-auth-1772754949' },
                createdAt: 1,
                updatedAt: 1,
            }]);
        });

        const updatedNameInput = findTextInput(tree, (props) => props.testID === 'mcp.server.editor.name');
        const updatedUrlInput = findTextInput(tree, (props) => props.placeholder === 'https://example.com/mcp');
        expect(updatedNameInput.props.value).toBe('qa_remote_http_20260306');
        expect(updatedUrlInput.props.value).toBe('http://127.0.0.1:63254/mcp');
        expect(tree.root.findAllByType('SegmentedTabBar')[1]?.props.activeTabId).toBe('http');
    });

    it('shows configure/import-json/quick-install add-flow tabs for new servers', async () => {
        localSearchParamsValue = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const { McpServerEditorScreen } = await import('./McpServerEditorScreen');
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(McpServerEditorScreen));
        });

        const segmentedTabBar = tree.root.findAllByType('SegmentedTabBar')[0];
        expect(segmentedTabBar).toBeTruthy();
        expect(segmentedTabBar.props.tabs.map((tab: { id: string }) => tab.id)).toEqual([
            'configure',
            'importJson',
            'quickInstall',
        ]);

        expect(tree.root.findAllByType('ItemGroup').length).toBeGreaterThanOrEqual(2);

        await act(async () => {
            segmentedTabBar.props.onSelectTab?.('importJson');
        });
        const importJsonInput = tree.root.findAll((node) => node.props?.testID === 'mcp.server.importJson.input')[0];
        expect(importJsonInput).toBeTruthy();

        await act(async () => {
            segmentedTabBar.props.onSelectTab?.('quickInstall');
        });
        const quickInstallPreset = tree.root.findAll((node) => node.props?.testID === 'mcp.server.quickInstall.preset.github')[0];
        expect(quickInstallPreset).toBeTruthy();
    });

    it('disables JSON import when a saved-secret mapping is missing a value', async () => {
        localSearchParamsValue = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const { McpServerEditorScreen } = await import('./McpServerEditorScreen');
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(McpServerEditorScreen));
        });

        const addFlowTabs = tree.root.findAllByType('SegmentedTabBar')[0];
        await act(async () => {
            addFlowTabs.props.onSelectTab?.('importJson');
        });

        const importJsonInput = tree.root.findAll((node) => node.props?.testID === 'mcp.server.importJson.input')[0];
        await act(async () => {
            importJsonInput.props.onChangeText?.(`{
                "mcp": {
                    "inputs": {
                        "github_token": {
                            "type": "promptString",
                            "password": true
                        }
                    },
                    "servers": {
                        "github": {
                            "command": "npx",
                            "args": ["-y", "@modelcontextprotocol/server-github"],
                            "env": {
                                "GITHUB_TOKEN": "\${input:github_token}"
                            }
                        }
                    }
                }
            }`);
        });

        const importButton = tree.root.findAll((node) => node.props?.testID === 'mcp.server.importJson.import')[0];
        expect(importButton?.props.disabled).toBe(true);
    });

    it('allows selecting multiple quick-install presets while preserving required-auth validation', async () => {
        localSearchParamsValue = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const { McpServerEditorScreen } = await import('./McpServerEditorScreen');
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(McpServerEditorScreen));
        });

        const addFlowTabs = tree.root.findAllByType('SegmentedTabBar')[0];
        await act(async () => {
            addFlowTabs.props.onSelectTab?.('quickInstall');
        });

        const githubPreset = tree.root.findAll((node) => node.props?.testID === 'mcp.server.quickInstall.preset.github')[0];
        await act(async () => {
            githubPreset.props.onPress?.();
        });

        const sequentialThinkingPreset = tree.root.findAll((node) => node.props?.testID === 'mcp.server.quickInstall.preset.sequential-thinking')[0];
        await act(async () => {
            sequentialThinkingPreset.props.onPress?.();
        });

        const installButton = tree.root.findAll((node) => node.props?.testID === 'mcp.server.quickInstall.install')[0];
        const githubRow = tree.root.findAll((node) => node.props?.testID === 'mcp.server.quickInstall.preset.github')[0];
        const sequentialThinkingRow = tree.root.findAll((node) => node.props?.testID === 'mcp.server.quickInstall.preset.sequential-thinking')[0];

        expect(githubRow?.props.selected).toBe(true);
        expect(sequentialThinkingRow?.props.selected).toBe(true);
        expect(installButton?.props.disabled).toBe(true);
    });

    it('opens add binding as a draft expander instead of creating a binding immediately', async () => {
        localSearchParamsValue = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const { McpServerEditorScreen } = await import('./McpServerEditorScreen');
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(McpServerEditorScreen));
        });

        expect(tree.root.findAllByType('McpServerBindingEditor')).toHaveLength(0);

        const addBindingExpander = tree.root.findAllByType('InlineAddExpander')[0];
        expect(addBindingExpander).toBeTruthy();
        expect(addBindingExpander.props.title).toBe('settings.mcpServersAddApplyRule');
        expect(addBindingExpander.props.isOpen).toBe(false);

        await act(async () => {
            addBindingExpander.props.onOpenChange?.(true);
        });

        const addBindingExpanderAfterOpen = tree.root.findAllByType('InlineAddExpander')[0];
        expect(tree.root.findAllByType('McpServerBindingEditor')).toHaveLength(0);
        expect(addBindingExpanderAfterOpen?.props.isOpen).toBe(true);
    });
});
