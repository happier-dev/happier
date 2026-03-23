import * as React from 'react';
import { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installConnectedServicesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            Platform: {
                OS: 'web',
                select: (options?: Readonly<{ default?: unknown }>) => (options && 'default' in options ? options.default : undefined),
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
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

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
    CONNECTED_SERVICES_REGISTRY: [{ serviceId: 'openai-codex', connectCommand: 'happier connect codex', supportsOauth: true }],
    getConnectedServiceRegistryEntry: (_serviceId: string) => ({ serviceId: 'openai-codex', connectCommand: 'happier connect codex', supportsOauth: true }),
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => ({}),
}));

describe('ConnectedServicesSettingsView', () => {
    it('does not expose connected services when the feature is disabled', async () => {
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ConnectedServicesSettingsView))).tree;

        const items = tree.findAllByType('Item' as any);
        expect(items.length).toBe(0);
    });
});
