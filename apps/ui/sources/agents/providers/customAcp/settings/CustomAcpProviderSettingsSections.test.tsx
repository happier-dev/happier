import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol';
import { renderSettingsView, createUseSettingMock } from '@/dev/testkit';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';

const routerPushSpy = vi.fn();

type AcpCatalogBackendDefinition = AcpCatalogSettingsV1['backends'][number];

function createAcpBackendFixture(): AcpCatalogBackendDefinition {
    return {
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
    };
}

function createAcpCatalogSettingsFixture(): AcpCatalogSettingsV1 {
    return {
        v: 2,
        backends: [createAcpBackendFixture()],
    };
}

const acpCatalogSettingsFixture = createAcpCatalogSettingsFixture();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Pressable: 'Pressable',
                    Platform: {
                        OS: 'web',
                        select: <T,>(options: { default?: T; web?: T }) => options.web ?? options.default ?? null,
                    },
                    Dimensions: {
                        get: () => ({ width: 1440, height: 900 }),
                    },
                    AppState: {
                        currentState: 'active',
                        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
                    },
                }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: createPassThroughModule(['Ionicons']).Ionicons,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { push: routerPushSpy },
    });
    return expoRouterMock.module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
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
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: vi.fn(),
            confirm: vi.fn(async () => false),
            prompt: vi.fn(async () => null),
        },
    }).module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSetting: createUseSettingMock({
            values: {
                acpCatalogSettingsV1: acpCatalogSettingsFixture,
            },
        }),
    useSettingMutable: (key: string) => {
            if (key === 'acpCatalogSettingsV1') {
                return [acpCatalogSettingsFixture, vi.fn()];
            }
            return [null, vi.fn()];
        },
});
});

vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));

vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));

describe('CustomAcpProviderSettingsSections', () => {
    beforeEach(() => {
        routerPushSpy.mockReset();
    });

    it('renders ACP backend management directly in the provider settings screen', async () => {
        const { CustomAcpProviderSettingsSections } = await import('./CustomAcpProviderSettingsSections');
        const screen = await renderSettingsView(React.createElement(CustomAcpProviderSettingsSections));

        expect(screen.findRow('settings.acpCatalog.builtIn.kiro')).toBeTruthy();
        expect(screen.findRow('settings.acpCatalog.builtIn.customAcp')).toBeNull();
        expect(screen.findRow('settings.acpCatalog.backend.backend-1')).toBeTruthy();
        expect(screen.findRow('settings.acpCatalog.addBackend')).toBeTruthy();
        expect(screen.findGroup('settings.acpCatalogPresets')).toBeNull();

        const backendRow = screen.findRow('settings.acpCatalog.backend.backend-1');
        const addBackend = screen.findRowByTitle('settings.acpCatalogAddBackend');
        expect(backendRow).toBeTruthy();
        expect(addBackend).toBeTruthy();

        screen.pressRow('settings.acpCatalog.backend.backend-1');
        screen.pressRowByTitle('settings.acpCatalogAddBackend');

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
