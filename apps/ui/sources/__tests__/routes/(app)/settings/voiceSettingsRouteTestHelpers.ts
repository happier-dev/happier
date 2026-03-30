import * as React from 'react';
import { vi } from 'vitest';

type VoiceSettingsRouteModuleFactory = () => unknown | Promise<unknown>;
type MockImportOriginal = <T = unknown>() => Promise<T>;
type StorageModuleFactory = (importOriginal: MockImportOriginal) => unknown | Promise<unknown>;

type InstallVoiceSettingsRouteModuleMocksOptions = Readonly<{
    routerModule?: VoiceSettingsRouteModuleFactory;
    textModule?: VoiceSettingsRouteModuleFactory;
    modalModule?: VoiceSettingsRouteModuleFactory;
    storageModule?: StorageModuleFactory;
}>;

const voiceSettingsRouteModuleState = vi.hoisted(() => ({
    modalMockRef: { current: null as unknown },
    options: {
        routerModule: undefined as VoiceSettingsRouteModuleFactory | undefined,
        textModule: undefined as VoiceSettingsRouteModuleFactory | undefined,
        modalModule: undefined as VoiceSettingsRouteModuleFactory | undefined,
        storageModule: undefined as StorageModuleFactory | undefined,
    },
}));

export function getVoiceSettingsRouteModalMockRef() {
    return voiceSettingsRouteModuleState.modalMockRef as { current: any };
}

export function installVoiceSettingsRouteModuleMocks(
    options: InstallVoiceSettingsRouteModuleMocksOptions = {},
) {
    voiceSettingsRouteModuleState.options = {
        routerModule: options.routerModule,
        textModule: options.textModule,
        modalModule: options.modalModule,
        storageModule: options.storageModule,
    };

    vi.mock('expo-router', async () => {
        if (voiceSettingsRouteModuleState.options.routerModule) {
            return await voiceSettingsRouteModuleState.options.routerModule();
        }
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: vi.fn() },
        }).module;
    });

    vi.mock('@expo/vector-icons', () => ({
        Ionicons: 'Ionicons',
    }));

    vi.mock('@/text', async () => {
        if (voiceSettingsRouteModuleState.options.textModule) {
            return await voiceSettingsRouteModuleState.options.textModule();
        }
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        if (voiceSettingsRouteModuleState.options.modalModule) {
            return await voiceSettingsRouteModuleState.options.modalModule();
        }
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        voiceSettingsRouteModuleState.modalMockRef.current = modalMock;
        return modalMock.module;
    });

    vi.mock('@/components/ui/lists/ItemList', () => ({
        ItemList: React.forwardRef((props: any, ref: any) =>
            React.createElement('ItemList', { ...props, ref }, props.children)),
    }));

    vi.mock('@/components/ui/lists/ItemGroup', () => ({
        ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
    }));

    vi.mock('@/components/ui/lists/Item', () => ({
        Item: (props: any) => React.createElement('Item', props),
    }));

    vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
        DropdownMenu: (props: any) =>
            React.createElement(
                'DropdownMenu',
                props,
                (() => {
                    const toggle = () => props.onOpenChange?.(!props.open);
                    const openMenu = () => props.onOpenChange?.(true);
                    const closeMenu = () => props.onOpenChange?.(false);
                    if (props.itemTrigger) {
                        return React.createElement('Item', {
                            title: props.itemTrigger.title,
                            subtitle: props.itemTrigger.subtitle,
                            icon: props.itemTrigger.icon,
                            detail: undefined,
                            onPress: toggle,
                            showChevron: false,
                            selected: false,
                        });
                    }
                    return (typeof props.trigger === 'function'
                        ? props.trigger({ open: false, toggle, openMenu, closeMenu, selectedItem: null })
                        : props.trigger) ?? null;
                })(),
            ),
    }));

    vi.mock('@/components/ui/forms/Switch', () => ({
        Switch: (props: any) => React.createElement('Switch', props),
    }));

    vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSetting: () => null,
    useSettings: () => ({}),
});
});
}
