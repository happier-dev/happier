import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    AppState: {
        currentState: 'active',
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
    Platform: {
        OS: 'web',
        select: (options?: Readonly<{ default?: unknown }>) => (options && 'default' in options ? options.default : undefined),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({
        connectedServicesV2: [
            {
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
            },
        ],
    }),
    useSettings: () => ({
        connectedServicesDefaultProfileByServiceId: {},
        connectedServicesProfileLabelByKey: {},
    }),
    useLocalSetting: () => 1,
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

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(async () => {}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
    CONNECTED_SERVICES_REGISTRY: [{ serviceId: 'openai-codex', displayName: 'Codex', connectCommand: 'happier connect codex' }],
    getConnectedServiceRegistryEntry: (_serviceId: string) => ({ displayName: 'Codex', connectCommand: 'happier connect codex' }),
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => ({}),
}));

describe('ConnectedServicesSettingsView', () => {
    it('does not expose connected services when the feature is disabled', async () => {
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ConnectedServicesSettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        expect(items.length).toBe(1);
    });
});
