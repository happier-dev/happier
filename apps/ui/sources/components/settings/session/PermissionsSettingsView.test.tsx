import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setDefaultPermissionByAgent = vi.fn();
const setPermissionModeApplyTiming = vi.fn();
const setPermissionPromptSurface = vi.fn();
const setDefaultPersistenceMode = vi.fn();
const setDefaultPersistenceModeByTargetKey = vi.fn();

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#666',
                success: '#0f0',
            },
        },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct',
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['codex', 'opencode'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: (agentId: string) => agentId,
    getAgentCore: (agentId: string) => ({
        displayNameKey: `agent.${agentId}`,
        permissions: { modeGroup: 'codexLike' },
        ui: { agentPickerIconName: 'sparkles-outline' },
    }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeOptionsForAgentType: () => [],
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (name: string) => {
        if (name === 'sessionDefaultPermissionModeByTargetKey') return [{}, setDefaultPermissionByAgent];
        if (name === 'sessionPermissionModeApplyTiming') return ['immediate', setPermissionModeApplyTiming];
        if (name === 'permissionPromptSurface') return ['composer', setPermissionPromptSurface];
        if (name === 'newSessionDefaultPersistenceModeV1') return ['persisted', setDefaultPersistenceMode];
        if (name === 'newSessionDefaultPersistenceModeByTargetKeyV1') return [{}, setDefaultPersistenceModeByTargetKey];
        return [null, vi.fn()];
    },
    useSettings: () => ({ opencodeBackendMode: 'server' }),
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
    it('renders session storage defaults and updates both global and per-agent settings', async () => {
        const { PermissionsSettingsView } = await import('./PermissionsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(PermissionsSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const titles = items.map((item) => item.props.title);
        expect(titles).toContain('settingsSession.defaultStorage.globalTitle');
        expect(titles).toContain('agent.codex');

        const globalDirect = items.find((item) => item.props.title === 'DropdownItem:settingsSession.defaultStorage.globalTitle:sessionsList.storageDirectTab');
        expect(globalDirect).toBeTruthy();
        await act(async () => {
            globalDirect!.props.onPress();
        });
        expect(setDefaultPersistenceMode).toHaveBeenCalledWith('direct');

        const codexDirect = items.find((item) => item.props.title === 'DropdownItem:agent.codex:sessionsList.storageDirectTab');
        expect(codexDirect).toBeTruthy();
        await act(async () => {
            codexDirect!.props.onPress();
        });
        expect(setDefaultPersistenceModeByTargetKey).toHaveBeenCalledWith({
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'direct',
        });

        const codexUseGlobal = items.find((item) => item.props.title === 'DropdownItem:agent.codex:settingsSession.defaultStorage.useGlobalDefault');
        expect(codexUseGlobal).toBeTruthy();
        await act(async () => {
            codexUseGlobal!.props.onPress();
        });
        expect(setDefaultPersistenceModeByTargetKey).toHaveBeenCalledWith({});
    });
});
