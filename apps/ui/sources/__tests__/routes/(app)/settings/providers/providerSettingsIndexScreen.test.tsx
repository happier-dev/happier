import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: (value) => routerPushSpy(value),
            back: () => undefined,
            replace: () => undefined,
            setParams: vi.fn(),
        },
    }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                textSecondary: '#999',
            },
        },
    });
});

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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSetting: (key: string) => {
        if (key === 'backendEnabledByTargetKey') return {};
        return undefined;
    },
});
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

afterEach(() => {
    routerPushSpy.mockClear();
    standardCleanup();
});

describe('ProviderSettingsIndexScreen', () => {
    it('renders built-in providers without custom ACP and includes ACP backend sections', async () => {
        const Screen = (await import('@/app/(app)/settings/providers')).default;
        const screen = await renderSettingsView(React.createElement(Screen));

        expect(screen.findRowByTitle('agent.codex')).toBeTruthy();
        expect(screen.findRowByTitle('agent.kiro')).toBeTruthy();
        expect(screen.findRowByTitle('agent.customAcp')).toBeFalsy();

        const acpSections = screen.findAllByType('AcpCatalogSettingsSections' as any);
        expect(acpSections).toHaveLength(1);

        await act(async () => {
            screen.pressRowByTitle('agent.codex');
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/providers/codex');
    });
});
