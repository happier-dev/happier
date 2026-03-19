import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#999',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children, ...props }: any) => React.createElement('ItemList', props, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: any) => React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/settings/acpCatalog/AcpCatalogSettingsSections', () => ({
    AcpCatalogSettingsSections: () => React.createElement('AcpCatalogSettingsSections'),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'customAcp', 'kiro'],
    getAgentCore: (agentId: string) => ({
        displayNameKey: `agent.${agentId}`,
        availability: { experimental: agentId === 'kiro' },
        ui: { agentPickerIconName: 'code-slash-outline' },
    }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'backendEnabledByTargetKey') return {};
        return undefined;
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

afterEach(() => {
    routerPushSpy.mockClear();
});

describe('ProviderSettingsIndexScreen', () => {
    it('renders built-in providers without custom ACP and includes ACP backend sections', async () => {
        const Screen = (await import('@/app/(app)/settings/providers')).default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });

        const items = tree.root.findAllByType('Item' as any);
        const titles = items.map((item: any) => item.props.title);
        expect(titles).toEqual(expect.arrayContaining(['agent.codex', 'agent.kiro']));
        expect(titles).not.toContain('agent.customAcp');

        const acpSections = tree.root.findAllByType('AcpCatalogSettingsSections' as any);
        expect(acpSections).toHaveLength(1);

        const codexItem = items.find((item: any) => item.props.title === 'agent.codex');
        expect(codexItem).toBeTruthy();

        await act(async () => {
            codexItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/providers/codex');
    });
});
