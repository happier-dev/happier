import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    Platform: {
        OS: 'web',
        select: <T,>(options: { default?: T; web?: T }) => options.web ?? options.default ?? null,
    },
    Dimensions: { get: () => ({ width: 1440, height: 900 }) },
    AppState: {
        currentState: 'active',
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => {
            const theme = {
                colors: {
                    textSecondary: '#999',
                    success: '#0f0',
                    accent: {
                        indigo: '#00f',
                        orange: '#f80',
                    },
                },
            };
            return typeof factory === 'function' ? factory(theme) : factory;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#999',
                success: '#0f0',
                accent: {
                    indigo: '#00f',
                    orange: '#f80',
                },
            },
        },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: vi.fn(async () => false),
        prompt: vi.fn(async () => null),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'acpCatalogSettingsV1') {
            return {
                v: 2,
                backends: [
                    {
                        id: 'backend-1',
                        name: 'backend-1',
                        title: 'Backend One',
                        description: '',
                        command: 'custom-cli',
                        args: [],
                        env: {},
                        transportProfile: 'generic',
                        defaultMode: 'plan',
                        defaultModel: 'sonnet',
                        auth: { support: 'unsupported' },
                        capabilities: {
                            supportsLoadSession: false,
                            supportsModes: 'unknown',
                            supportsModels: 'unknown',
                            supportsConfigOptions: 'unknown',
                            promptImageSupport: 'unknown',
                        },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            };
        }
        return undefined;
    },
    useSettingMutable: (key: string) => {
        if (key === 'acpCatalogSettingsV1') {
            return [
                {
                    v: 2,
                    backends: [
                        {
                            id: 'backend-1',
                            name: 'backend-1',
                            title: 'Backend One',
                            description: '',
                            command: 'custom-cli',
                            args: [],
                            env: {},
                            transportProfile: 'generic',
                            defaultMode: 'plan',
                            defaultModel: 'sonnet',
                            auth: { support: 'unsupported' },
                            capabilities: {
                                supportsLoadSession: false,
                                supportsModes: 'unknown',
                                supportsModels: 'unknown',
                                supportsConfigOptions: 'unknown',
                                promptImageSupport: 'unknown',
                            },
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                },
                vi.fn(),
            ];
        }
        return [null, vi.fn()];
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

describe('CustomAcpProviderSettingsSections', () => {
    beforeEach(() => {
        routerPushSpy.mockReset();
    });

    it('renders ACP backend management directly in the provider settings screen', async () => {
        const { CustomAcpProviderSettingsSections } = await import('./CustomAcpProviderSettingsSections');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(CustomAcpProviderSettingsSections));
        });

        const items = tree!.root.findAllByType('Item' as any);
        expect(items.some((item) => item.props.testID === 'settings.acpCatalog.builtIn.kiro')).toBe(true);
        expect(items.some((item) => item.props.testID === 'settings.acpCatalog.builtIn.customAcp')).toBe(false);
        expect(items.some((item) => item.props.testID === 'settings.acpCatalog.backend.backend-1')).toBe(true);
        expect(items.some((item) => item.props.testID === 'settings.acpCatalog.addBackend')).toBe(true);
        expect(items.some((item) => item.props.title === 'settings.acpCatalogPresets')).toBe(false);

        const backendRow = items.find((item) => item.props.testID === 'settings.acpCatalog.backend.backend-1');
        const addBackend = items.find((item) => item.props.title === 'settings.acpCatalogAddBackend');
        expect(backendRow).toBeTruthy();
        expect(addBackend).toBeTruthy();

        await act(async () => {
            backendRow!.props.onPress();
            addBackend!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                pathname: '/(app)/settings/acp-backend',
                params: { backendId: 'backend-1' },
            }),
        );
        expect(routerPushSpy).toHaveBeenNthCalledWith(2, '/(app)/settings/acp-backend');
    });
});
