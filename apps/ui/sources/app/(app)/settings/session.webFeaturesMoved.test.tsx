import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    TextInput: 'TextInput',
    Platform: {
        OS: 'web',
        select: (options: any) => (options && 'default' in options ? options.default : undefined),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { placeholder: '#999', background: '#fff' },
                text: '#111',
                textSecondary: '#666',
                divider: '#e5e5e5',
            },
        },
    }),
    StyleSheet: { create: (v: any) => v, absoluteFillObject: {} },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
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

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) =>
        React.createElement(
            'DropdownMenu',
            props,
            typeof props.trigger === 'function' ? props.trigger({ open: false, toggle: () => {} }) : null,
        ),
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => {
        if (key === 'agentInputEnterToSend') return [false, vi.fn()] as const;
        if (key === 'agentInputHistoryScope') return ['perSession', vi.fn()] as const;
        if (key === 'sessionMessageSendMode') return ['agent_queue', vi.fn()] as const;
        if (key === 'sessionBusySteerSendPolicy') return ['steer_immediately', vi.fn()] as const;
        if (key === 'terminalConnectLegacySecretExportEnabled') return [false, vi.fn()] as const;
        if (key === 'sessionReplayEnabled') return [false, vi.fn()] as const;
        if (key === 'sessionReplayStrategy') return ['recent_messages', vi.fn()] as const;
        if (key === 'sessionReplayRecentMessagesCount') return [16, vi.fn()] as const;
        if (key === 'sessionUseTmux') return [false, vi.fn()] as const;
        if (key === 'sessionTmuxSessionName') return [null, vi.fn()] as const;
        if (key === 'sessionTmuxIsolated') return [false, vi.fn()] as const;
        if (key === 'sessionTmuxTmpDir') return [null, vi.fn()] as const;
        return [null, vi.fn()] as const;
    },
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => [],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: () => ({ displayNameKey: 'agent.name' }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeLabelForAgentType: () => 'default',
    getPermissionModeOptionsForAgentType: () => [],
}));

vi.mock('./sessionI18n', () => ({
    getPermissionApplyTimingSubtitleKey: () => 'x',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

describe('Session settings (web features moved)', () => {
    it('shows Enter-to-send and Message history inside Session settings (web)', async () => {
        const mod = await import('./session');
        const SessionSettingsScreen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionSettingsScreen));
        });

        const items = tree.root.findAllByType('Item' as any);
        const titles = items.map((i: any) => i.props.title);
        const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
        const dropdownTriggerTitles = dropdowns
            .map((d: any) => d.props?.itemTrigger?.title)
            .filter((t: any) => typeof t === 'string');

        expect(titles).toContain('settingsFeatures.enterToSend');
        expect([...titles, ...dropdownTriggerTitles]).toContain('settingsFeatures.historyScope');

        const historyDropdown = dropdowns.find((d: any) => {
            const ids = (d.props.items ?? []).map((it: any) => it.id);
            return ids.includes('global') && ids.includes('perSession');
        });
        expect(historyDropdown).toBeTruthy();
    });
});
