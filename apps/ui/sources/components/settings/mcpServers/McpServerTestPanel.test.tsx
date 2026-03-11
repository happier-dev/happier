import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpServerBindingV1, McpServerCatalogEntryV1 } from '@happier-dev/protocol';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openMachinePathBrowserModalMock = vi.hoisted(() => vi.fn<(params: unknown) => Promise<string | null>>(async () => '/repo/from-browser'));

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    Platform: {
        OS: 'web',
        select: <T,>(options: { default?: T; web?: T; ios?: T; android?: T }) => options.web ?? options.default ?? options.ios ?? options.android,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => typeof factory === 'function'
            ? factory({
                colors: {
                    textSecondary: '#666',
                    accent: { indigo: '#60f', purple: '#90f', blue: '#00f' },
                    success: '#0f0',
                    status: { error: '#f00' },
                    input: { background: '#fff', text: '#111', placeholder: '#888' },
                },
            })
            : factory,
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#666',
                accent: { indigo: '#60f', purple: '#90f', blue: '#00f' },
                success: '#0f0',
                status: { error: '#f00' },
                input: { background: '#fff', text: '#111', placeholder: '#888' },
            },
        },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
        if (!vars) return key;
        return `${key}:${JSON.stringify(vars)}`;
    },
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: React.PropsWithChildren) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({
    PathInputBrowseButton: (props: any) => React.createElement('PathInputBrowseButton', {
        testID: props.testID ?? 'path-browser-trigger',
        onPress: props.onPress,
        disabled: props.disabled,
    }),
}));

vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: (params: unknown) => openMachinePathBrowserModalMock(params),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
    },
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (action: (...args: readonly unknown[]) => Promise<unknown>) => [false, action],
}));

vi.mock('@/sync/ops/machineMcpServers', () => ({
    machineMcpServersTest: vi.fn(async () => ({ ok: true, toolCount: 1, durationMs: 1 })),
}));

describe('McpServerTestPanel', () => {
    beforeEach(() => {
        openMachinePathBrowserModalMock.mockClear();
    });

    it('opens the shared path browser from the test directory input and applies the selected directory', async () => {
        const { McpServerTestPanel } = await import('./McpServerTestPanel');

        const server: McpServerCatalogEntryV1 = {
            id: 'server-1',
            name: 'playwright',
            transport: 'stdio',
            stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
            env: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const bindings: McpServerBindingV1[] = [];

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <McpServerTestPanel
                    server={server}
                    bindings={bindings}
                    machines={[{ id: 'machine-1', serverId: 'server-1', metadata: { displayName: 'Machine 1', host: 'machine-1.local' } } as any]}
                />,
            );
        });

        const input = tree.root.findAll((node) => node.props?.testID === 'mcp.server.test.directory.input')[0];
        await act(async () => {
            input.props.onChangeText('/repo/current');
        });

        const browseButton = tree.root.findAll((node) => node.props?.testID === 'path-browser-trigger')[0];
        await act(async () => {
            await browseButton.props.onPress();
        });

        expect(openMachinePathBrowserModalMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            initialPath: '/repo/current',
            title: 'settings.mcpServersTestDirectoryTitle',
        });

        const updatedInput = tree.root.findAll((node) => node.props?.testID === 'mcp.server.test.directory.input')[0];
        expect(updatedInput.props.value).toBe('/repo/from-browser');
    });
});
