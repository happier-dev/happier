import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installAcpCatalogSettingsCommonModuleMocks } from './acpCatalogSettingsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    routerBackSpy: vi.fn(),
    routerSetParamsSpy: vi.fn(),
    setAcpSettingsSpy: vi.fn(),
    settingsState: {
        value: {
            v: 2,
            backends: [],
        } as AcpCatalogSettingsV1,
    },
}));

installAcpCatalogSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: { get: () => ({ width: 1440, height: 900 }) },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true }).module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/settings/acp-catalog',
            segments: ['(app)', 'settings', 'acp-catalog'],
            router: {
                push: shared.routerPushSpy,
                replace: shared.routerReplaceSpy,
                back: shared.routerBackSpy,
                setParams: shared.routerSetParamsSpy,
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: (key: string) => {
                    if (key === 'acpCatalogSettingsV1') {
                        return [shared.settingsState.value, shared.setAcpSettingsSpy];
                    }
                    if (key === 'secrets') return [[], vi.fn()];
                    return [null, vi.fn()];
                },
            },
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) =>
        React.createElement('ItemGroup', {
            ...props,
            testID: props.testID ?? `settings.acpCatalog.itemGroup.${props.title ?? 'untitled'}`,
        }, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.subtitle ?? null, props.rightElement ?? null),
}));

describe('AcpCatalogSettingsScreen', () => {
    beforeEach(async () => {
        shared.routerPushSpy.mockReset();
        shared.routerReplaceSpy.mockReset();
        shared.routerBackSpy.mockReset();
        shared.routerSetParamsSpy.mockReset();
        shared.setAcpSettingsSpy.mockReset();
        shared.settingsState.value = {
            v: 2,
            backends: [
                {
                    id: 'custom-kiro',
                    name: 'custom-kiro',
                    title: 'Custom Kiro',
                    description: 'ACP backend',
                    command: 'kiro-cli',
                    args: ['acp', '--agent', 'spec'],
                    env: {},
                    transportProfile: 'kiro',
                    defaultMode: 'plan',
                    defaultModel: 'sonnet',
                    capabilities: {
                        supportsLoadSession: true,
                        supportsModes: 'yes',
                        supportsModels: 'yes',
                        supportsConfigOptions: 'unknown',
                        promptImageSupport: 'yes',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockReset();
        vi.mocked(Modal.show).mockReset();
        vi.mocked(Modal.prompt).mockReset();
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
    });

    it('renders built-in and configured backends and routes backend actions to the backend editor', async () => {
        const { AcpCatalogSettingsScreen } = await import('./AcpCatalogSettingsScreen');
        const screen = await renderSettingsView(React.createElement(AcpCatalogSettingsScreen));

        const builtInKiroRow = screen.findRow('settings.acpCatalog.builtIn.kiro');
        const builtInCustomAcpRow = screen.findRow('settings.acpCatalog.builtIn.customAcp');
        const backendRow = screen.findRow('settings.acpCatalog.backend.custom-kiro');
        const addBackendRow = screen.findRow('settings.acpCatalog.addBackend');
        const addPresetRow = screen.findRow('settings.acpCatalog.addPreset');
        const emptyBackendsRow = screen.findRow('settings.acpCatalog.backends.empty');

        expect(builtInKiroRow).toBeTruthy();
        expect(builtInCustomAcpRow).toBeNull();
        expect(backendRow).toBeTruthy();
        expect(backendRow?.props.title).toBe('Custom Kiro');
        expect(addBackendRow).toBeTruthy();
        expect(addPresetRow).toBeNull();
        expect(emptyBackendsRow).toBeNull();
        expect(screen.findAllByTestId('settings.acpCatalog.itemGroup.untitled')).toHaveLength(1);

        screen.pressRow('settings.acpCatalog.addBackend');
        screen.pressRow('settings.acpCatalog.backend.custom-kiro');

        expect(shared.routerPushSpy).toHaveBeenNthCalledWith(1, '/settings/acp-backend');
        expect(shared.routerPushSpy).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                pathname: '/settings/acp-backend',
                params: { backendId: 'custom-kiro' },
            }),
        );
    });

    it('shows only the add backend row inside the titled custom backends group when no configured backends exist', async () => {
        shared.settingsState.value = {
            v: 2,
            backends: [],
        };

        const { AcpCatalogSettingsScreen } = await import('./AcpCatalogSettingsScreen');
        const screen = await renderSettingsView(React.createElement(AcpCatalogSettingsScreen));

        const addBackendRow = screen.findRow('settings.acpCatalog.addBackend');
        const emptyBackendsRow = screen.findRow('settings.acpCatalog.backends.empty');
        const backendRows = screen.listRows('settings.acpCatalog.backend.');
        const customBackendsGroup = screen.findByTestId('settings.acpCatalog.itemGroup.settings.acpCatalogBackends');

        expect(addBackendRow).toBeTruthy();
        expect(emptyBackendsRow).toBeNull();
        expect(backendRows).toHaveLength(0);
        expect(customBackendsGroup).toBeTruthy();
        expect(screen.findAllByTestId('settings.acpCatalog.itemGroup.untitled')).toHaveLength(0);
    });
});
