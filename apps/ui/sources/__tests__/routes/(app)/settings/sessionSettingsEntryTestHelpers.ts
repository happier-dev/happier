import * as React from 'react';
import { vi } from 'vitest';

type SettingsEntryModuleFactory = () => unknown | Promise<unknown>;
type MockImportOriginal = <T = unknown>() => Promise<T>;
type StorageModuleFactory = (importOriginal: MockImportOriginal) => unknown | Promise<unknown>;
type FeatureEnabledResolver = (featureId: string) => boolean;

type InstallSessionSettingsEntryModuleMocksOptions = Readonly<{
    reactNative?: SettingsEntryModuleFactory;
    unistyles?: SettingsEntryModuleFactory;
    routerModule?: SettingsEntryModuleFactory;
    textModule?: SettingsEntryModuleFactory;
    modalModule?: SettingsEntryModuleFactory;
    useDeviceType?: 'desktop' | 'tablet';
    storageModule?: StorageModuleFactory;
    featureEnabled?: FeatureEnabledResolver;
}>;

const sessionSettingsEntryState = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    settingsState: {
        sessionsRightPaneDefaultOpen: false,
        uiMultiPanePanelsEnabled: false,
    } as Record<string, unknown>,
    options: {
        reactNative: undefined as SettingsEntryModuleFactory | undefined,
        unistyles: undefined as SettingsEntryModuleFactory | undefined,
        routerModule: undefined as SettingsEntryModuleFactory | undefined,
        textModule: undefined as SettingsEntryModuleFactory | undefined,
        modalModule: undefined as SettingsEntryModuleFactory | undefined,
        storageModule: undefined as StorageModuleFactory | undefined,
        featureEnabled: undefined as FeatureEnabledResolver | undefined,
        useDeviceType: 'desktop' as 'desktop' | 'tablet',
    },
}));

export function resetSessionSettingsEntryState() {
    sessionSettingsEntryState.routerPushSpy.mockClear();
    sessionSettingsEntryState.settingsState = {
        sessionsRightPaneDefaultOpen: false,
        uiMultiPanePanelsEnabled: false,
    };
    sessionSettingsEntryState.options = {
        reactNative: undefined,
        unistyles: undefined,
        routerModule: undefined,
        textModule: undefined,
        modalModule: undefined,
        storageModule: undefined,
        featureEnabled: undefined,
        useDeviceType: 'desktop',
    };
}

export function installSessionSettingsEntryModuleMocks(
    options: InstallSessionSettingsEntryModuleMocksOptions = {},
) {
    sessionSettingsEntryState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        routerModule: options.routerModule,
        textModule: options.textModule,
        modalModule: options.modalModule,
        storageModule: options.storageModule,
        featureEnabled: options.featureEnabled,
        useDeviceType: options.useDeviceType ?? 'desktop',
    };

    vi.mock('react-native', async () => {
        if (sessionSettingsEntryState.options.reactNative) {
            return await sessionSettingsEntryState.options.reactNative();
        }
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@expo/vector-icons', () => ({
        Ionicons: 'Ionicons',
    }));

    vi.mock('react-native-unistyles', async () => {
        if (sessionSettingsEntryState.options.unistyles) {
            return await sessionSettingsEntryState.options.unistyles();
        }
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('expo-router', async () => {
        if (sessionSettingsEntryState.options.routerModule) {
            return await sessionSettingsEntryState.options.routerModule();
        }
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: sessionSettingsEntryState.routerPushSpy,
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    });

    vi.mock('@/components/ui/lists/ItemList', () => ({
        ItemList: (props: any) => React.createElement('ItemList', props, props.children),
    }));

    vi.mock('@/components/ui/lists/ItemGroup', () => ({
        ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
    }));

    vi.mock('@/components/ui/lists/Item', () => ({
        Item: (props: any) => React.createElement('Item', props),
    }));

    vi.mock('@/components/ui/forms/Switch', () => ({
        Switch: 'Switch',
    }));

    vi.mock('@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker', () => ({
        LlmTaskRunnerConfigV1BackendModelPicker: (props: any) =>
            React.createElement('LlmTaskRunnerConfigV1BackendModelPicker', props),
    }));

    vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
        DropdownMenu: (props: any) =>
            React.createElement(
                'DropdownMenu',
                props,
                props.itemTrigger
                    ? React.createElement('Item', {
                          title: props.itemTrigger.title,
                          onPress: () => props.onOpenChange?.(!props.open),
                          disabled: props.itemTrigger?.itemProps?.disabled,
                      })
                    : typeof props.trigger === 'function'
                      ? props.trigger({
                            open: props.open,
                            toggle: () => props.onOpenChange?.(!props.open),
                            openMenu: () => props.onOpenChange?.(true),
                            closeMenu: () => props.onOpenChange?.(false),
                            selectedItem: null,
                        })
                      : null,
            ),
    }));

    vi.mock('@/components/ui/text/Text', () => ({
        Text: 'Text',
        TextInput: 'TextInput',
    }));

    vi.mock('@/constants/Typography', () => ({
        Typography: {
            default: () => ({}),
        },
    }));

    vi.mock('@/text', async () => {
        if (sessionSettingsEntryState.options.textModule) {
            return await sessionSettingsEntryState.options.textModule();
        }
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        if (sessionSettingsEntryState.options.modalModule) {
            return await sessionSettingsEntryState.options.modalModule();
        }
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        if (sessionSettingsEntryState.options.storageModule) {
            return await sessionSettingsEntryState.options.storageModule(importOriginal as MockImportOriginal);
        }
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                // Boundary fixture: route settings tests only need keyed mutable storage semantics.
                useSettingMutable: ((key: string) => [
                    key in sessionSettingsEntryState.settingsState
                        ? sessionSettingsEntryState.settingsState[key]
                        : null,
                    (next: unknown) => {
                        sessionSettingsEntryState.settingsState[key] = next;
                    },
                ]) as unknown as typeof import('@/sync/domains/state/storage')['useSettingMutable'],
                // Boundary fixture: route settings tests only need keyed mutable storage semantics.
                useLocalSettingMutable: ((key: string) => [
                    key in sessionSettingsEntryState.settingsState
                        ? sessionSettingsEntryState.settingsState[key]
                        : null,
                    (next: unknown) => {
                        sessionSettingsEntryState.settingsState[key] = next;
                    },
                ]) as unknown as typeof import('@/sync/domains/state/storage')['useLocalSettingMutable'],
            },
        });
    });

    vi.mock('@/utils/platform/responsive', () => ({
        useDeviceType: () => sessionSettingsEntryState.options.useDeviceType,
    }));

    if (sessionSettingsEntryState.options.featureEnabled) {
        vi.mock('@/hooks/server/useFeatureEnabled', () => ({
            useFeatureEnabled: (featureId: string) =>
                sessionSettingsEntryState.options.featureEnabled?.(featureId) ?? false,
        }));
    }
}

export { sessionSettingsEntryState };
