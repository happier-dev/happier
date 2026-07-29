import React from 'react';
import { beforeEach, vi } from 'vitest';

import {
    createExpoRouterMock,
    createStackOptionsCapture as createRawStackOptionsCapture,
    type StackOptionsCapture,
    type StackScreenOptions,
    type StackScreenOptionsInput,
} from '@/dev/testkit/mocks/router';

type ReactActEnvironmentGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type HeaderButtonElement = React.ReactElement<{
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: string;
}> | null | undefined;

export type PickerStackScreenOptions = StackScreenOptions & Readonly<{
  presentation?: string;
  headerLeft?: () => HeaderButtonElement;
  headerRight?: () => HeaderButtonElement;
}>;

export type PickerStackOptionsCapture = Omit<StackOptionsCapture, 'getResolved'> & Readonly<{
  getResolved: () => PickerStackScreenOptions | null;
}>;

export type { StackScreenOptionsInput as PickerStackOptionsInput };

export type PickerNavigationRoute = Readonly<{
    key: string;
    name?: string;
    path?: string;
    params?: Record<string, unknown>;
}>;

export type PickerNavigationState = Readonly<{
    index: number;
    routes: PickerNavigationRoute[];
}>;

export function createStackOptionsCapture(): PickerStackOptionsCapture {
    const capture = createRawStackOptionsCapture();
    return {
        ...capture,
        getResolved: () => capture.getResolved() as PickerStackScreenOptions | null,
    };
}

export function enableReactActEnvironment() {
    (globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
}

type PickerModuleFactory = () => unknown | Promise<unknown>;
type PickerStorageModuleFactory = (importOriginal: <T>() => Promise<T>) => unknown | Promise<unknown>;

type PickerCommonModuleMocksOptions = Readonly<{
    expoRouter?: PickerModuleFactory;
    itemList?: PickerModuleFactory;
    modal?: PickerModuleFactory;
    reactNavigationNative?: PickerModuleFactory;
    reactNative?: PickerModuleFactory;
    vectorIcons?: PickerModuleFactory;
    storage?: PickerStorageModuleFactory;
    text?: PickerModuleFactory;
    unistyles?: PickerModuleFactory;
}>;

const pickerCommonModuleMocksState = vi.hoisted(() => ({
    options: {} as PickerCommonModuleMocksOptions,
}));

export function installPickerCommonModuleMocks(options: PickerCommonModuleMocksOptions = {}) {
    pickerCommonModuleMocksState.options = options;

    beforeEach(async () => {
        const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        clearDaemonMergedProjectionCacheForTests();
    });

    vi.mock('@/text', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('react-native', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.expoRouter) {
            return await activeOptions.expoRouter();
        }
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@react-navigation/native', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.reactNavigationNative) {
            return await activeOptions.reactNavigationNative();
        }

        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        return createReactNavigationNativeMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.vectorIcons) {
            return await activeOptions.vectorIcons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/components/ui/lists/ItemList', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.itemList) {
            return await activeOptions.itemList();
        }

        const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
        return createPassThroughModule(['ItemList']);
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {},
        });
    });
}

export const PICKER_NAV_STATE = { index: 1, routes: [{ key: 'a' }, { key: 'b' }] } as const;

export const PICKER_THEME_COLORS = {
  background: { canvas: '#ffffff' },
  border: { default: '#ddd' },
  chrome: { header: { foreground: '#000' } },
  input: { background: '#fff', placeholder: '#aaa', text: '#000' },
  status: { connected: '#0f0', disconnected: '#f00', error: '#f00' },
  surface: { base: '#fff', inset: '#ffffff' },
  textSecondary: '#666',
} as const;

export function createRouterMock() {
    const { spies } = createExpoRouterMock();
    return {
        push: spies.push,
        back: spies.back,
        replace: spies.replace,
        setParams: spies.setParams,
    };
}

export function createNavigationMock(): {
    dispatch: ReturnType<typeof vi.fn>;
    getState: () => PickerNavigationState;
    goBack: ReturnType<typeof vi.fn>;
    setParams: ReturnType<typeof vi.fn>;
} {
    return {
        dispatch: vi.fn(),
        getState: () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        }),
        goBack: vi.fn(),
        setParams: vi.fn(),
    };
}

export function cloneNavigationState(state: PickerNavigationState): PickerNavigationState {
    return {
        index: state.index,
        routes: state.routes.map((route) => ({
            key: route.key,
            ...(route.name ? { name: route.name } : {}),
            ...(route.path ? { path: route.path } : {}),
            ...(route.params ? { params: route.params } : {}),
        })),
    };
}

export function parseJsonRouteParam(value: unknown): unknown {
    if (typeof value !== 'string') {
        throw new Error(`Expected JSON route param string, got ${typeof value}`);
    }
    return JSON.parse(value);
}
