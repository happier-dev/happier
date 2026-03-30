import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: () => <>{'.'}</>,
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            Platform: {
                OS: 'web',
                select: (v: any) => v.web ?? v.default ?? null,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    text: '#000',
                    textSecondary: '#666',
                    divider: '#ddd',
                    input: { background: '#fff', text: '#000', placeholder: '#999' },
                    button: { primary: { background: '#00f' } },
                },
            },
            rt: { themeName: 'light' },
        });
    },
});

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

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: React.forwardRef((props: any, _ref) => React.createElement('TextInput', props)),
}));

const openMachinePathBrowserModalMock = vi.fn();

vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: (input: unknown) => openMachinePathBrowserModalMock(input),
}));

describe('PathSelector', () => {
    it('does not suggest a hardcoded /projects path (case-sensitive filesystems)', async () => {
        const { PathSelector } = await import('./PathSelector');

        const tree = (await renderScreen(
            <PathSelector
                machineHomeDir="/home/luis"
                selectedPath=""
                onChangeSelectedPath={() => {}}
                recentPaths={[]}
                usePickerSearch={false}
                favoriteDirectories={[]}
                onChangeFavoriteDirectories={() => {}}
            />,
        )).tree;

        expect(findTestInstanceByTypeWithProps(tree, 'Item', { title: '/home/luis/projects' })).toBeUndefined();
    });

    it('submits the selected row immediately when confirm behavior is enabled', async () => {
        const onSubmitSelectedPath = vi.fn();
        const { PathSelector } = await import('./PathSelector');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<PathSelector
                    machineHomeDir="/Users/leeroy"
                    selectedPath="/Users/leeroy/project"
                    onChangeSelectedPath={() => {}}
                    onSubmitSelectedPath={onSubmitSelectedPath}
                    submitBehavior="confirm"
                    recentPaths={['/Users/leeroy/Development/happier/dev']}
                    usePickerSearch={false}
                    favoriteDirectories={[]}
                    onChangeFavoriteDirectories={() => {}}
                />)).tree;

        const selectedRow = findTestInstanceByTypeWithProps(tree, 'Item', { title: '/Users/leeroy/Development/happier/dev' });
        expect(selectedRow).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(selectedRow);
        });

        expect(onSubmitSelectedPath).toHaveBeenCalledWith('/Users/leeroy/Development/happier/dev');
    });

    it('shows the browse button and opens the shared path browser modal when machine browsing is enabled', async () => {
        openMachinePathBrowserModalMock.mockReset();
        openMachinePathBrowserModalMock.mockResolvedValueOnce('/Users/leeroy/from-browser');
        const { PathSelector } = await import('./PathSelector');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<PathSelector
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
                />)).tree;

        await act(async () => {
            await tree.pressByTestIdAsync('path-browser-trigger');
        });

        expect(openMachinePathBrowserModalMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            initialPath: '/Users/leeroy/project',
        }));
    });

    it('uses the current typed draft as the browse modal starting path', async () => {
        openMachinePathBrowserModalMock.mockReset();
        openMachinePathBrowserModalMock.mockResolvedValueOnce('/Users/leeroy/from-browser');
        const { PathSelector } = await import('./PathSelector');

        const screen = await renderScreen(<PathSelector
                    machineHomeDir="/Users/leeroy"
                    selectedPath="/Users/leeroy/project"
                    onChangeSelectedPath={vi.fn()}
                    recentPaths={[]}
                    usePickerSearch={false}
                    favoriteDirectories={[]}
                    onChangeFavoriteDirectories={() => {}}
                    machineBrowse={{
                        enabled: true,
                        machineId: 'machine-1',
                    }}
                />);

        const input = findTestInstanceByTypeWithProps(screen.tree, 'TextInput', { testID: 'path-selector-input' });
        if (!input) {
            throw new Error('Expected path selector input to render');
        }

        act(() => {
            input.props.onChangeText('/Users/leeroy/Documents/Development/happier/dev');
        });

        await act(async () => {
            await screen.pressByTestIdAsync('path-browser-trigger');
        });

        expect(openMachinePathBrowserModalMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            initialPath: '/Users/leeroy/Documents/Development/happier/dev',
        }));
    });

    it('falls back to the machine home directory when the draft path is empty', async () => {
        openMachinePathBrowserModalMock.mockReset();
        openMachinePathBrowserModalMock.mockResolvedValueOnce('/Users/leeroy/from-browser');
        const { PathSelector } = await import('./PathSelector');

        const screen = await renderScreen(<PathSelector
                    machineHomeDir="/Users/leeroy"
                    selectedPath=""
                    onChangeSelectedPath={vi.fn()}
                    recentPaths={[]}
                    usePickerSearch={false}
                    favoriteDirectories={[]}
                    onChangeFavoriteDirectories={() => {}}
                    machineBrowse={{
                        enabled: true,
                        machineId: 'machine-1',
                    }}
                />);

        await act(async () => {
            await screen.pressByTestIdAsync('path-browser-trigger');
        });

        expect(openMachinePathBrowserModalMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            initialPath: '/Users/leeroy',
        }));
    });

    it('keeps typed path edits local until submit so the parent screen does not rerender on every keystroke', async () => {
        const onChangeSelectedPath = vi.fn();
        const onSubmitSelectedPath = vi.fn();
        const { PathSelector } = await import('./PathSelector');

        const screen = await renderScreen(<PathSelector
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
                />);

        const input = findTestInstanceByTypeWithProps(screen.tree, 'TextInput', { testID: 'path-selector-input' });
        if (!input) {
            throw new Error('Expected path selector input to render');
        }

        act(() => {
            input.props.onChangeText('/Users/leeroy/Documents/Development/happier/dev');
        });

        expect(onChangeSelectedPath).not.toHaveBeenCalled();
        expect(findTestInstanceByTypeWithProps(screen.tree, 'TextInput', { testID: 'path-selector-input' })?.props.value)
            .toBe('/Users/leeroy/Documents/Development/happier/dev');

        act(() => {
            input.props.onSubmitEditing?.();
        });

        expect(onChangeSelectedPath).toHaveBeenCalledWith('/Users/leeroy/Documents/Development/happier/dev');
        expect(onSubmitSelectedPath).toHaveBeenCalledWith('/Users/leeroy/Documents/Development/happier/dev');
    });

    it('does not render the browse button when machine browsing is not enabled', async () => {
        const { PathSelector } = await import('./PathSelector');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<PathSelector
                    machineHomeDir="/Users/leeroy"
                    selectedPath="/Users/leeroy/project"
                    onChangeSelectedPath={() => {}}
                    recentPaths={[]}
                    usePickerSearch={false}
                    favoriteDirectories={[]}
                    onChangeFavoriteDirectories={() => {}}
                />)).tree;

        expect(tree.findAllByTestId('path-browser-trigger')).toHaveLength(0);
    });

    it('submits the browsed machine path immediately when confirm behavior is enabled', async () => {
        openMachinePathBrowserModalMock.mockReset();
        openMachinePathBrowserModalMock.mockResolvedValueOnce('/Users/leeroy/from-browser');
        const onChangeSelectedPath = vi.fn();
        const onSubmitSelectedPath = vi.fn();
        const { PathSelector } = await import('./PathSelector');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<PathSelector
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
                />)).tree;

        await act(async () => {
            await tree.pressByTestIdAsync('path-browser-trigger');
        });

        expect(onChangeSelectedPath).toHaveBeenCalledWith('/Users/leeroy/from-browser');
        expect(onSubmitSelectedPath).toHaveBeenCalledWith('/Users/leeroy/from-browser');
    });

    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { PathSelector } = await import('./PathSelector');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<PathSelector
                    machineHomeDir="/Users/leeroy"
                    selectedPath="/Users/leeroy/project"
                    onChangeSelectedPath={() => {}}
                    recentPaths={['/Users/leeroy/project']}
                    usePickerSearch={false}
                    favoriteDirectories={['/Users/leeroy/project']}
                    onChangeFavoriteDirectories={() => {}}
                />)).tree;

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
