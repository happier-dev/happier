import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const onSelectMachineMock = vi.fn();
const onChangePathMock = vi.fn();
const openMachinePathBrowserModalMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    Platform: {
        OS: 'web',
        select: <T,>(options: { default?: T; web?: T }) => options.web ?? options.default ?? null,
    },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (fn: any) => fn({
            colors: {
                divider: '#ddd',
                input: { background: '#fff', text: '#111', placeholder: '#666' },
                accent: { blue: '#00f' },
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                divider: '#ddd',
                input: { background: '#fff', text: '#111', placeholder: '#666' },
                accent: { blue: '#00f' },
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.subtitle ?? null),
}));

vi.mock('@/components/ui/text/Text', () => ({
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: (input: unknown) => openMachinePathBrowserModalMock(input),
}));

describe('ContextBar', () => {
    beforeEach(() => {
        onSelectMachineMock.mockReset();
        onChangePathMock.mockReset();
        openMachinePathBrowserModalMock.mockReset();
    });

    it('renders machine and workspace controls in machine_and_workspace mode', async () => {
        const { ContextBar } = await import('./ContextBar');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ContextBar, {
                    mode: 'machine_and_workspace',
                    machine: {
                        selectedId: 'machine-1',
                        subtitle: 'Laptop',
                        items: [
                            { id: 'machine-1', title: 'Laptop' },
                            { id: 'machine-2', title: 'Desktop' },
                        ],
                        onSelect: onSelectMachineMock,
                    },
                    workspace: {
                        value: '/repo',
                        placeholder: 'Project directory',
                        onChange: onChangePathMock,
                    },
                }),
            );
        });

        const dropdowns = tree.root.findAllByType('DropdownMenu');
        const inputs = tree.root.findAllByType('TextInput');
        expect(dropdowns).toHaveLength(1);
        expect(inputs).toHaveLength(1);

        await act(async () => {
            dropdowns[0]?.props?.onSelect?.('machine-2');
        });
        expect(onSelectMachineMock).toHaveBeenCalledWith('machine-2');

        await act(async () => {
            inputs[0]?.props?.onChangeText?.('/repo/subdir');
        });
        expect(onChangePathMock).toHaveBeenCalledWith('/repo/subdir');
    });

    it('omits the workspace input in machine_only mode', async () => {
        const { ContextBar } = await import('./ContextBar');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ContextBar, {
                    mode: 'machine_only',
                    machine: {
                        selectedId: 'machine-1',
                        subtitle: 'Laptop',
                        items: [{ id: 'machine-1', title: 'Laptop' }],
                        onSelect: onSelectMachineMock,
                    },
                }),
            );
        });

        expect(tree.root.findAllByType('DropdownMenu')).toHaveLength(1);
        expect(tree.root.findAllByType('TextInput')).toHaveLength(0);
    });

    it('uses a custom machine title when provided', async () => {
        const { ContextBar } = await import('./ContextBar');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ContextBar, {
                    mode: 'machine_only',
                    machine: {
                        title: 'settingsProviders.targetMachineTitle',
                        selectedId: 'machine-1',
                        subtitle: 'Laptop',
                        items: [{ id: 'machine-1', title: 'Laptop' }],
                        onSelect: onSelectMachineMock,
                    },
                }),
            );
        });

        const dropdown = tree.root.findByType('DropdownMenu');
        expect(dropdown.props.itemTrigger.title).toBe('settingsProviders.targetMachineTitle');
    });

    it('shows a workspace browse button when browse config is provided', async () => {
        openMachinePathBrowserModalMock.mockResolvedValueOnce('/repo/from-browser');
        const { ContextBar } = await import('./ContextBar');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ContextBar, {
                    mode: 'workspace_only',
                    workspace: {
                        value: '/repo',
                        placeholder: 'Project directory',
                        onChange: onChangePathMock,
                        browse: {
                            machineId: 'machine-1',
                            serverId: 'server-1',
                        },
                    },
                }),
            );
        });

        const browseButton = tree.root.findByProps({ testID: 'path-browser-trigger' });
        await act(async () => {
            await browseButton.props.onPress();
        });

        expect(openMachinePathBrowserModalMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            initialPath: '/repo',
        }));
    });
});
