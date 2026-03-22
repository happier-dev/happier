import * as React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openMachinePathBrowserModalMock = vi.hoisted(() => vi.fn<(params: unknown) => Promise<string | null>>(async () => '/repo/from-browser'));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            View: 'View',
                                            Pressable: 'Pressable',
                                            Platform: {
                                                OS: 'web',
                                                select: <T,>(values: { default?: T; web?: T; ios?: T; android?: T }) => values.web ?? values.default ?? values.ios ?? values.android,
                                            },
                                        }
    );
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
      colors: {
        textSecondary: '#666',
        input: { background: '#fff', text: '#111', placeholder: '#888' },
        divider: '#ddd',
        accent: { blue: '#00f', indigo: '#60f', green: '#0f0' },
      },
    },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
  TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({ children }: React.PropsWithChildren) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
  openMachinePathBrowserModal: (params: unknown) => openMachinePathBrowserModalMock(params),
}));

vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({
  PathInputBrowseButton: (props: any) => React.createElement('PathInputBrowseButton', {
    testID: props.testID ?? 'path-browser-trigger',
    onPress: props.onPress,
    disabled: props.disabled,
  }),
}));

describe('MCP directory browse tabs', () => {
  beforeEach(() => {
    openMachinePathBrowserModalMock.mockClear();
  });

  it('opens the shared path browser from the detected directory input', async () => {
    const onChangeDirectory = vi.fn();
    const { McpDetectedServersTab } = await import('./McpDetectedServersTab');

    let tree!: ReactTestRenderer;
        tree = (await renderScreen(<McpDetectedServersTab
                    machines={[{ id: 'machine-1', serverId: 'server-1', metadata: { displayName: 'Machine 1' } } as any]}
                    machineItems={[]}
                    selectedMachineId="machine-1"
                    onSelectMachine={() => {}}
                    machineMenuOpen={false}
          onMachineMenuOpenChange={() => {}}
          directory="/repo"
          onChangeDirectory={onChangeDirectory}
          loading={false}
          detected={[]}
          warnings={[]}
          onRefresh={() => {}}
          onImport={() => {}}
        />)).tree;

    const browseButton = tree.findByType('PathInputBrowseButton');
    await act(async () => {
      await pressTestInstanceAsync(browseButton);
    });

    expect(openMachinePathBrowserModalMock).toHaveBeenCalledWith({
      machineId: 'machine-1',
      serverId: 'server-1',
      initialPath: '/repo',
      title: 'settings.mcpServersDetectedDirectoryTitle',
    });
    expect(onChangeDirectory).toHaveBeenCalledWith('/repo/from-browser');
  });

  it('opens the shared path browser from the preview directory input', async () => {
    const onChangeDirectory = vi.fn();
    const { McpPreviewServersTab } = await import('./McpPreviewServersTab');

    let tree!: ReactTestRenderer;
        tree = (await renderScreen(<McpPreviewServersTab
                    machines={[{ id: 'machine-1', serverId: 'server-1', metadata: { displayName: 'Machine 1' } } as any]}
                    machineItems={[]}
                    agentItems={[]}
                    selectedAgentTools={{ delivery: 'manual' } as any}
          selectedMachineId="machine-1"
          onSelectMachine={() => {}}
          machineMenuOpen={false}
          onMachineMenuOpenChange={() => {}}
          selectedAgentId="codex"
          onSelectAgentId={() => {}}
          agentMenuOpen={false}
          onAgentMenuOpenChange={() => {}}
          directory="/repo"
          onChangeDirectory={onChangeDirectory}
          loading={false}
          preview={null}
          onRefresh={() => {}}
        />)).tree;

    const browseButton = tree.findByType('PathInputBrowseButton');
    await act(async () => {
      await pressTestInstanceAsync(browseButton);
    });

    expect(openMachinePathBrowserModalMock).toHaveBeenCalledWith({
      machineId: 'machine-1',
      serverId: 'server-1',
      initialPath: '/repo',
      title: 'settings.mcpServersPreviewDirectoryTitle',
    });
    expect(onChangeDirectory).toHaveBeenCalledWith('/repo/from-browser');
  });
});
