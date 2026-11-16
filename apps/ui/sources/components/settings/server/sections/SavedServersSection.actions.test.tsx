import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from '@/components/settings/server/hooks/serverSettingsHooksTestHelpers';

installServerSettingsHooksCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'web' } });
    },
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ theme: { colors: { text: { secondary: '#666' } } } });
});
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props, props.rightElement as React.ReactNode),
}));
vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: Record<string, unknown>) => React.createElement('ItemRowActions', props),
}));

describe('SavedServersSection actions', () => {
    it('switches this tab from the row and makes the Home the device default from its menu', async () => {
        const onSwitch = vi.fn();
        const { SavedServersSection } = await import('./SavedServersSection');
        const screen = await renderScreen(React.createElement(SavedServersSection, {
            servers: [{
                id: 'server-b',
                name: 'Home B',
                serverUrl: 'https://b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
            }],
            activeServerId: 'server-a',
            deviceDefaultServerId: 'server-a',
            authStatusByServerId: { 'server-b': 'signedIn' },
            onSwitch,
            onRename: vi.fn(),
            onRemove: vi.fn(),
        }));

        await screen.pressByTestIdAsync('saved-server-switch-server-b');
        const actions = findTestInstanceByTypeWithProps(screen, 'ItemRowActions' as never, { title: 'Home B' })?.props.actions;
        expect(actions.map((action: { id: string }) => action.id)).toEqual(['switch-device', 'rename', 'remove']);
        actions.find((action: { id: string }) => action.id === 'switch-device').onPress();

        // The row's Switch uses the routine scope (this tab in a browser); the menu moves the device default.
        expect(onSwitch).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'server-b' }));
        expect(onSwitch).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'server-b' }), 'device');
    });

    it('announces active and device-default Homes as distinct row facts', async () => {
        const { SavedServersSection } = await import('./SavedServersSection');
        const screen = await renderScreen(React.createElement(SavedServersSection, {
            servers: [
                { id: 'server-a', name: 'Home A', serverUrl: 'https://a.example.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0 },
                { id: 'server-b', name: 'Home B', serverUrl: 'https://b.example.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0 },
            ],
            activeServerId: 'server-a',
            deviceDefaultServerId: 'server-b',
            authStatusByServerId: { 'server-a': 'signedIn', 'server-b': 'signedIn' },
            onSwitch: vi.fn(),
            onRename: vi.fn(),
            onRemove: vi.fn(),
        }));

        const focused = findTestInstanceByTypeWithProps(screen, 'Item' as never, { testID: 'saved-server-row-server-a' })!.props;
        const other = findTestInstanceByTypeWithProps(screen, 'Item' as never, { testID: 'saved-server-row-server-b' })!.props;
        // The Home in use carries the Current pill; its status line does not repeat it.
        expect(String(focused.subtitle)).not.toContain('server.homes.currentPill');
        expect(String(focused.accessibilityLabel)).toContain('server.homes.currentPill');
        expect(String(other.subtitle)).toMatch(/ · homesHub\.opensFirst$/);
        expect(String(other.accessibilityLabel)).toContain('homesHub.opensFirst');
        expect(String(other.accessibilityLabel)).not.toContain('server.homes.currentPill');
    });

    it('says "default" on the current Home only to assistive tech; its line carries its state', async () => {
        const { SavedServersSection } = await import('./SavedServersSection');
        const screen = await renderScreen(React.createElement(SavedServersSection, {
            servers: [{ id: 'server-a', name: 'Home A', serverUrl: 'https://a.example.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0 }],
            activeServerId: 'server-a',
            deviceDefaultServerId: 'server-a',
            authStatusByServerId: { 'server-a': 'signedIn' },
            onSwitch: vi.fn(),
            onRename: vi.fn(),
            onRemove: vi.fn(),
        }));

        const row = findTestInstanceByTypeWithProps(screen, 'Item' as never, { testID: 'saved-server-row-server-a' })!.props;
        expect(String(row.subtitle)).not.toContain('homesHub.opensFirst');
        expect(String(row.accessibilityLabel)).toContain('server.homes.currentPill · homesHub.opensFirst');
    });

    it('offers Home Administration on the rows of Homes that admit this account, and only there', async () => {
        const onOpenAdministration = vi.fn();
        const { SavedServersSection } = await import('./SavedServersSection');
        const screen = await renderScreen(React.createElement(SavedServersSection, {
            servers: [
                { id: 'server-a', name: 'Home A', serverUrl: 'https://a.example.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0 },
                { id: 'server-b', name: 'Home B', serverUrl: 'https://b.example.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0 },
            ],
            activeServerId: 'server-a',
            authStatusByServerId: { 'server-a': 'signedIn', 'server-b': 'signedIn' },
            administrableServerIds: new Set(['server-b']),
            onOpenAdministration,
            onSwitch: vi.fn(),
            onRename: vi.fn(),
            onRemove: vi.fn(),
        }));

        expect(screen.findByTestId('saved-server-administration-server-a')).toBeFalsy();
        await screen.pressByTestIdAsync('saved-server-administration-server-b');
        expect(onOpenAdministration).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-b' }));
    });

    it('offers an edit-members action on a group row without switching the client to it', async () => {
        const onEditGroupMembers = vi.fn();
        const onSwitchGroup = vi.fn();
        const { SavedServersSection } = await import('./SavedServersSection');
        const screen = await renderScreen(React.createElement(SavedServersSection, {
            servers: [],
            serverGroups: [{ id: 'group-1', name: 'Work', serverIds: ['server-a'], presentation: 'grouped' }],
            activeServerId: 'server-a',
            activeGroupId: null,
            authStatusByServerId: {},
            onSwitch: vi.fn(),
            onSwitchGroup,
            onEditGroupMembers,
            onRename: vi.fn(),
            onRemove: vi.fn(),
        }));

        const actions = findTestInstanceByTypeWithProps(screen, 'ItemRowActions' as never, { title: 'Work' })?.props.actions;
        const editAction = actions.find((action: { id: string }) => action.id === 'edit-members');
        expect(editAction).toBeTruthy();
        editAction.onPress();
        expect(onEditGroupMembers).toHaveBeenCalledWith(expect.objectContaining({ id: 'group-1' }));
        expect(onSwitchGroup).not.toHaveBeenCalled();
    });
});
