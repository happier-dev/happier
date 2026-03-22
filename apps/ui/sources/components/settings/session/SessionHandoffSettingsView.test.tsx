import * as React from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingsState: Record<string, any> = {};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                accent: {
                    blue: '#00f',
                    green: '#0f0',
                    orange: '#f80',
                    indigo: '#80f',
                },
                textSecondary: '#999',
                success: '#0f0',
            },
        },
    });
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null, props.children ?? null),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSettingMutable: (key: string) => [
                settingsState[key],
                (next: any) => {
                    settingsState[key] = next;
                },
            ],
        },
    });
});

describe('SessionHandoffSettingsView', () => {
    beforeEach(() => {
        settingsState.sessionHandoffDefaultsV1 = {
            v: 1,
            workspaceTransferEnabled: true,
            workspaceTransferStrategy: 'transfer_snapshot',
            conflictPolicy: 'create_sibling_copy',
            includeIgnoredMode: 'exclude',
            ignoredIncludeGlobs: [],
            directTargetMode: 'keep_direct',
        };
    });

    it('updates handoff defaults for workspace transfer strategy, conflict policy, ignored files, and direct target mode', async () => {
        const mod = await import('./SessionHandoffSettingsView');
        const SessionHandoffSettingsView = mod.default;
        const screen = await renderScreen(React.createElement(SessionHandoffSettingsView));
        let tree: ReactTestRenderer = screen.tree;

        const switchNode = tree.root.findByType('Switch' as any);
        await act(async () => {
            switchNode.props.onValueChange(false);
        });

        const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
        const strategyMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.workspaceTransfer.strategy.title');
        const conflictMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.conflictPolicy.title');
        const ignoredMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.includeIgnoredMode.title');
        const directModeMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.directTargetMode.title');

        expect(strategyMenu).toBeTruthy();
        expect(conflictMenu).toBeTruthy();
        expect(ignoredMenu).toBeTruthy();
        expect(directModeMenu).toBeTruthy();

        await act(async () => {
            strategyMenu!.props.onSelect('sync_changes');
            conflictMenu!.props.onSelect('replace_existing');
            ignoredMenu!.props.onSelect('include_selected');
            directModeMenu!.props.onSelect('convert_to_persisted');
        });

        await act(async () => {
            tree = (await renderScreen(React.createElement(SessionHandoffSettingsView))).tree;
        });

        const globInput = tree.root.findByType('TextInput' as any);
        await act(async () => {
            globInput.props.onChangeText('dist/**, .env.local');
        });

        expect(settingsState.sessionHandoffDefaultsV1).toEqual({
            v: 1,
            workspaceTransferEnabled: false,
            workspaceTransferStrategy: 'sync_changes',
            conflictPolicy: 'replace_existing',
            includeIgnoredMode: 'include_selected',
            ignoredIncludeGlobs: ['dist/**', '.env.local'],
            directTargetMode: 'convert_to_persisted',
        });
    });
});
