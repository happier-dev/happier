import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let controllerValue: any = null;

vi.mock('react-native', () => ({
    KeyboardAvoidingView: ({ children }: any) => React.createElement('KeyboardAvoidingView', null, children),
    Platform: {
        OS: 'ios',
    },
}));

vi.mock('expo-router', () => ({
    Stack: {
        Screen: (props: any) => React.createElement('StackScreen', props),
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: {} }),
    StyleSheet: { create: () => ({}) },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/settings/server/sections/SavedServersSection', () => ({
    SavedServersSection: (props: any) => React.createElement('SavedServersSection', props),
}));

vi.mock('@/components/settings/server/sections/AddTargetsSection', () => ({
    AddTargetsSection: (props: any) => React.createElement('AddTargetsSection', props),
}));

vi.mock('@/components/settings/server/sections/ServerGroupsSection', () => ({
    ServerGroupsSection: (props: any) => React.createElement('ServerGroupsSection', props),
}));

vi.mock('@/components/settings/server/hooks/useServerSettingsScreenController', () => ({
    useServerSettingsScreenController: () => controllerValue,
}));

function setController(overrides: Partial<any>) {
    controllerValue = {
        screenOptions: { headerShown: true, headerTitle: 'Server', headerBackTitle: 'Back' },
        servers: [],
        serverGroups: [],
        activeServerId: 'server-a',
        deviceDefaultServerId: 'server-a',
        activeTargetKey: null,
        authStatusByServerId: {},

        autoMode: false,
        inputUrl: '',
        inputName: '',
        error: null,
        isValidating: false,
        onChangeUrl: vi.fn(),
        onChangeName: vi.fn(),
        onResetServer: vi.fn(),
        onAddServer: vi.fn(),

        onSwitchServer: vi.fn(),
        onSwitchGroup: vi.fn(),
        onRenameServer: vi.fn(),
        onRemoveServer: vi.fn(),
        onRenameGroup: vi.fn(),
        onRemoveGroup: vi.fn(),
        onCreateServerGroup: vi.fn(async () => false),

        groupSelectionEnabled: false,
        setGroupSelectionEnabled: vi.fn(),
        groupSelectionPresentation: 'grouped',
        activeServerGroupId: null,
        selectedGroupServerIds: new Set<string>(),
        onToggleGroupPresentation: vi.fn(),
        onToggleGroupServer: vi.fn(),

        ...overrides,
    };
}

describe('ServerSettingsScreen (concurrent section visibility)', () => {
    it('hides concurrent multi-server settings when there are no server groups', async () => {
        setController({ serverGroups: [] });

        const { ServerSettingsScreen } = await import('./ServerSettingsScreen');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ServerSettingsScreen));
        });

        expect(tree.root.findAllByType('ServerGroupsSection' as any)).toHaveLength(0);
    });

    it('shows concurrent multi-server settings when there is at least one server group', async () => {
        setController({
            serverGroups: [{ id: 'grp-one', name: 'Group One', serverIds: ['server-a'], presentation: 'grouped' }],
        });

        const { ServerSettingsScreen } = await import('./ServerSettingsScreen');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ServerSettingsScreen));
        });

        expect(tree.root.findAllByType('ServerGroupsSection' as any)).toHaveLength(1);
    });
});

