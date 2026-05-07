import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol';
import { renderSettingsView, createUseSettingMock } from '@/dev/testkit';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { installAcpCatalogSettingsCommonModuleMocks } from '@/components/settings/acpCatalog/acpCatalogSettingsTestHelpers';

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

installAcpCatalogSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: {
                get: () => ({ width: 1440, height: 900 }),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPushSpy },
        }).module;
    },
    storage: async () => {
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
    },
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
                pathname: '/settings/acp-backend',
                params: { backendId: 'backend-1' },
            }),
        );
        expect(routerPushSpy).toHaveBeenNthCalledWith(2, '/settings/acp-backend');
    });
});
