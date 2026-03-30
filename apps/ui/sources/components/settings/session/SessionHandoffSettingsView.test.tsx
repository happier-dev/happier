import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import {
    installSessionSettingsCommonModuleMocks,
} from './sessionSettingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingsState: Record<string, any> = {};

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installSessionSettingsCommonModuleMocks({
    unistyles: async () => {
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
    },
    storage: async (importOriginal) => {
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
    },
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

describe('SessionHandoffSettingsView', () => {
    beforeEach(() => {
        settingsState.sessionHandoffDefaultsV1 = {
            v: 1,
            workspaceTransferEnabled: true,
            workspaceTransferStrategy: 'transfer_snapshot',
            conflictPolicy: 'create_sibling_copy',
            includeIgnoredMode: 'include_selected',
            ignoredIncludeGlobs: [],
            directTargetMode: 'keep_direct',
        };
    });

    it('updates handoff defaults for workspace transfer strategy, conflict policy, ignored files, and direct target mode', async () => {
        const mod = await import('./SessionHandoffSettingsView');
        const SessionHandoffSettingsView = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionHandoffSettingsView));

        await act(async () => {
            screen.pressRowByTitle('settingsSession.handoff.workspaceTransfer.title');
        });

        const strategyMenu = screen.findAll((node) => (
            node.props?.itemTrigger?.title === 'settingsSession.handoff.workspaceTransfer.strategy.title'
        ))[0] ?? null;
        const conflictMenu = screen.findAll((node) => (
            node.props?.itemTrigger?.title === 'settingsSession.handoff.conflictPolicy.title'
        ))[0] ?? null;
        const ignoredMenu = screen.findAll((node) => (
            node.props?.itemTrigger?.title === 'settingsSession.handoff.includeIgnoredMode.title'
        ))[0] ?? null;
        const directModeMenu = screen.findAll((node) => (
            node.props?.itemTrigger?.title === 'settingsSession.handoff.directTargetMode.title'
        ))[0] ?? null;

        expect(strategyMenu).toBeTruthy();
        expect(conflictMenu).toBeTruthy();
        expect(ignoredMenu).toBeTruthy();
        expect(directModeMenu).toBeTruthy();

        await act(async () => {
            strategyMenu?.props.onSelect('sync_changes');
            conflictMenu?.props.onSelect('replace_existing');
            ignoredMenu?.props.onSelect('include_selected');
            directModeMenu?.props.onSelect('convert_to_persisted');
        });

        const updatedScreen = await renderSettingsView(React.createElement(SessionHandoffSettingsView));
        const globInput = updatedScreen.findAll((node) => typeof node.props?.onChangeText === 'function')[0] ?? null;
        expect(globInput).toBeTruthy();
        await act(async () => {
            globInput?.props.onChangeText('dist/**, .env.local');
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
