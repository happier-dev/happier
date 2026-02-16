import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
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
                text: '#111111',
                textSecondary: '#666666',
                divider: '#e5e5e5',
                surface: '#ffffff',
                surfaceHigh: '#fafafa',
            },
        },
    }),
    StyleSheet: {
        create: (styles: any) => styles,
        absoluteFillObject: {},
    },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
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

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        mono: () => ({}),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: () => [null, vi.fn()],
}));

vi.mock('@/sync/domains/settings/executionRunsGuidance', () => ({
    buildExecutionRunsGuidanceBlock: () => ({ text: '' }),
    coerceExecutionRunsGuidanceEntries: () => [],
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('./guidance/showSubAgentGuidanceRuleEditorModal', () => ({
    showSubAgentGuidanceRuleEditorModal: vi.fn(async () => null),
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid-test',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: () => ({ displayNameKey: 'agent.name' }),
    isAgentId: () => false,
}));

describe('SubAgentSettingsView', () => {
    it('renders an execution-runs-disabled state when execution runs are not enabled', async () => {
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SubAgentSettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const enableItem = items.find((item: any) => item?.props?.title === 'Enable Execution Runs');
        expect(enableItem).toBeTruthy();
    });
});
