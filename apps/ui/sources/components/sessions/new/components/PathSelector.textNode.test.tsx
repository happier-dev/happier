import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    Platform: { OS: 'web', select: (v: any) => v.web ?? v.default ?? null },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        rt: { themeName: 'light' },
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                input: { background: '#fff', text: '#000', placeholder: '#999' },
                button: { primary: { background: '#00f' } },
            },
        },
    }),
    StyleSheet: {
        create: (styles: any) => (typeof styles === 'function' ? styles({
            colors: {
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                input: { background: '#fff', text: '#000', placeholder: '#999' },
                button: { primary: { background: '#00f' } },
            },
        }) : styles),
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement(
        'Item',
        props,
        [
            props.leftElement == null ? null : React.createElement('Text', { key: 'left' }, props.leftElement),
            props.rightElement == null ? null : React.createElement(React.Fragment, { key: 'right' }, props.rightElement),
            props.subtitle == null ? null : React.createElement('Text', { key: 'subtitle' }, props.subtitle),
        ],
    ),
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    formatPathRelativeToHome: (_home: string, path: string) => path,
}));

vi.mock('@/utils/path/pathUtils', () => ({
    resolveAbsolutePath: (path: string) => path,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: React.forwardRef((props: any, _ref) => React.createElement('TextInput', props)),
}));

const openMachinePathBrowserModalMock = vi.fn();

vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: (input: unknown) => openMachinePathBrowserModalMock(input),
}));

describe('PathSelector', () => {
    it('shows the browse button and opens the shared path browser modal when machine browsing is enabled', async () => {
        openMachinePathBrowserModalMock.mockReset();
        openMachinePathBrowserModalMock.mockResolvedValueOnce('/Users/leeroy/from-browser');
        const { PathSelector } = await import('./PathSelector');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <PathSelector
                    machineHomeDir="/Users/leeroy"
                    selectedPath="/Users/leeroy/project"
                    onChangeSelectedPath={() => {}}
                    recentPaths={[]}
                    usePickerSearch={false}
                    favoriteDirectories={[]}
                    onChangeFavoriteDirectories={() => {}}
                    machineBrowse={{
                        enabled: true,
                        machineId: 'machine-1',
                        serverId: 'server-1',
                    }}
                />,
            );
        });

        const browseButton = tree.root.findByProps({ testID: 'path-browser-trigger' });
        await act(async () => {
            await browseButton.props.onPress();
        });

        expect(openMachinePathBrowserModalMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            initialPath: '/Users/leeroy/project',
        }));
    });

    it('does not render the browse button when machine browsing is not enabled', async () => {
        const { PathSelector } = await import('./PathSelector');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <PathSelector
                    machineHomeDir="/Users/leeroy"
                    selectedPath="/Users/leeroy/project"
                    onChangeSelectedPath={() => {}}
                    recentPaths={[]}
                    usePickerSearch={false}
                    favoriteDirectories={[]}
                    onChangeFavoriteDirectories={() => {}}
                />,
            );
        });

        expect(tree.root.findAllByProps({ testID: 'path-browser-trigger' })).toHaveLength(0);
    });

    it('submits the browsed machine path immediately when confirm behavior is enabled', async () => {
        openMachinePathBrowserModalMock.mockReset();
        openMachinePathBrowserModalMock.mockResolvedValueOnce('/Users/leeroy/from-browser');
        const onChangeSelectedPath = vi.fn();
        const onSubmitSelectedPath = vi.fn();
        const { PathSelector } = await import('./PathSelector');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <PathSelector
                    machineHomeDir="/Users/leeroy"
                    selectedPath="/Users/leeroy/project"
                    onChangeSelectedPath={onChangeSelectedPath}
                    onSubmitSelectedPath={onSubmitSelectedPath}
                    submitBehavior="confirm"
                    recentPaths={[]}
                    usePickerSearch={false}
                    favoriteDirectories={[]}
                    onChangeFavoriteDirectories={() => {}}
                    machineBrowse={{
                        enabled: true,
                        machineId: 'machine-1',
                    }}
                />,
            );
        });

        const browseButton = tree.root.findByProps({ testID: 'path-browser-trigger' });
        await act(async () => {
            await browseButton.props.onPress();
        });

        expect(onChangeSelectedPath).toHaveBeenCalledWith('/Users/leeroy/from-browser');
        expect(onSubmitSelectedPath).toHaveBeenCalledWith('/Users/leeroy/from-browser');
    });

    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { PathSelector } = await import('./PathSelector');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <PathSelector
                    machineHomeDir="/Users/leeroy"
                    selectedPath="/Users/leeroy/project"
                    onChangeSelectedPath={() => {}}
                    recentPaths={['/Users/leeroy/project']}
                    usePickerSearch={false}
                    favoriteDirectories={['/Users/leeroy/project']}
                    onChangeFavoriteDirectories={() => {}}
                />,
            );
        });

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string' || typeof node === 'number') {
                const value = String(node);
                if (parentType !== 'Text' && value.trim().length > 0) badNodes.push({ parent: parentType, value });
                return;
            }
            if (Array.isArray(node)) {
                for (const item of node) walk(item, parentType);
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : parentType;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(tree.toJSON(), null);
        expect(badNodes).toEqual([]);

        act(() => {
            tree.unmount();
        });
    });
});
