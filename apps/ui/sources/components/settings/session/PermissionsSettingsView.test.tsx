import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSessionSettingsCommonModuleMocks } from './sessionSettingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setDefaultPermissionByAgent = vi.fn();
const setPermissionModeApplyTiming = vi.fn();
const setPermissionPromptSurface = vi.fn();
const setDefaultPersistenceMode = vi.fn();
const setDefaultPersistenceModeByTargetKey = vi.fn();
const setRememberLastProjectSessionSelections = vi.fn();

installSessionSettingsCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#666',
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
                useSettingMutable: (name: string) => {
                    if (name === 'sessionDefaultPermissionModeByTargetKey') return [{}, setDefaultPermissionByAgent];
                    if (name === 'sessionPermissionModeApplyTiming') return ['immediate', setPermissionModeApplyTiming];
                    if (name === 'permissionPromptSurface') return ['composer', setPermissionPromptSurface];
                    if (name === 'newSessionDefaultPersistenceModeV1') return ['persisted', setDefaultPersistenceMode];
                    if (name === 'newSessionDefaultPersistenceModeByTargetKeyV1') return [{}, setDefaultPersistenceModeByTargetKey];
                    if (name === 'rememberLastProjectSessionSelections') return [true, setRememberLastProjectSessionSelections];
                    return [null, vi.fn()];
                },
                useSettings: () => ({ schemaVersion: 1, opencodeBackendMode: 'server' } as any),
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct',
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['codex', 'opencode'],
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        DEFAULT_AGENT_ID: 'codex',
        resolveAgentIdFromFlavor: (agentId: string) => agentId,
        getAgentCore: (agentId: string) => ({
            displayNameKey: `agent.${agentId}`,
            permissions: { modeGroup: 'codexLike' },
            sessionStorage: { direct: true, persisted: true },
            ui: { agentPickerIconName: 'sparkles-outline' },
        }),
        getAgentBehavior: () => ({
            newSession: {
                supportsTranscriptStorageMode: () => true,
            },
        }),
    };
});

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeOptionsForAgentType: () => [],
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

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        React.Fragment,
        null,
        props.itemTrigger ? React.createElement('Item', props.itemTrigger) : null,
        ...(props.items ?? []).map((item: any) => React.createElement('Item', {
            key: `${props.itemTrigger?.title ?? 'unknown'}:${item.id}`,
            title: `DropdownItem:${props.itemTrigger?.title ?? 'unknown'}:${item.title}`,
            subtitle: item.subtitle,
            onPress: () => props.onSelect?.(item.id),
        })),
    ),
}));

describe('PermissionsSettingsView', () => {
    it('renders the remembered project session selection toggle', async () => {
        const { PermissionsSettingsView } = await import('./PermissionsSettingsView');
        const screen = await renderSettingsView(React.createElement(PermissionsSettingsView));

        const row = screen.findRowByTitle('settingsSession.sessionCreation.rememberLastProjectSelectionsTitle');
        expect(row).toBeTruthy();
        screen.pressRowByTitle('settingsSession.sessionCreation.rememberLastProjectSelectionsTitle');
        expect(setRememberLastProjectSessionSelections).toHaveBeenCalledWith(false);
    });

    it('renders session storage defaults and updates both global and per-agent settings', async () => {
        const { PermissionsSettingsView } = await import('./PermissionsSettingsView');
        const screen = await renderSettingsView(React.createElement(PermissionsSettingsView));
        const titles = screen.findAllByType('Item' as any).map((item) => item.props.title);
        expect(titles).toContain('settingsSession.defaultStorage.globalTitle');
        expect(titles).toContain('agent.codex');

        expect(screen.findRowByTitle('DropdownItem:settingsSession.defaultStorage.globalTitle:sessionsList.storageDirectTab')).toBeTruthy();
        screen.pressRowByTitle('DropdownItem:settingsSession.defaultStorage.globalTitle:sessionsList.storageDirectTab');
        expect(setDefaultPersistenceMode).toHaveBeenCalledWith('direct');

        expect(screen.findRowByTitle('DropdownItem:agent.codex:sessionsList.storageDirectTab')).toBeTruthy();
        screen.pressRowByTitle('DropdownItem:agent.codex:sessionsList.storageDirectTab');
        expect(setDefaultPersistenceModeByTargetKey).toHaveBeenCalledWith({
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'direct',
        });

        expect(screen.findRowByTitle('DropdownItem:agent.codex:settingsSession.defaultStorage.useGlobalDefault')).toBeTruthy();
        screen.pressRowByTitle('DropdownItem:agent.codex:settingsSession.defaultStorage.useGlobalDefault');
        expect(setDefaultPersistenceModeByTargetKey).toHaveBeenCalledWith({});
    });
});
