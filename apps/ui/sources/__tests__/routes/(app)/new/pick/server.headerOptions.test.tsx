import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

const stackOptionsCapture = vi.hoisted(() => {
    let currentOptions: Record<string, unknown> | (() => Record<string, unknown>) | null = null;

    return {
        record(options: Record<string, unknown> | (() => Record<string, unknown>)) {
            currentOptions = options;
        },
        reset() {
            currentOptions = null;
        },
        getRaw() {
            return currentOptions;
        },
        getResolved() {
            if (!currentOptions) {
                return null;
            }
            return typeof currentOptions === 'function' ? currentOptions() : currentOptions;
        },
    };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const module = createExpoRouterMock({
        params: { selectedId: '' },
        navigation: {
            getState: () => ({ index: 1, routes: [{ key: 'prev' }, { key: 'current' }] }),
            dispatch: vi.fn(),
        },
        router: {
            push: vi.fn(),
            back: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        },
        stackOptionsCapture,
    }).module;

    return {
        ...module,
        useLocalSearchParams: () => ({ selectedId: '' }),
    };
});

vi.mock('@react-navigation/native', () => ({
    CommonActions: { setParams: (params: any) => ({ type: 'SET_PARAMS', payload: params }) },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: {
                    OS: 'web',
                    select: (options: Record<string, unknown>) => options.web ?? options.default,
                },
            }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                header: { tint: '#000' },
                textSecondary: '#666',
            },
        },
    });
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: () => null,
        },
    }));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ generation: 1, serverId: 'server-a' }),
    listServerProfiles: () => [
        { id: 'server-a', name: 'A', serverUrl: 'http://a', lastUsedAt: 2 },
        { id: 'server-b', name: 'B', serverUrl: 'http://b', lastUsedAt: 1 },
    ],
}));

import ServerPickerScreen from '@/app/(app)/new/pick/server';

describe('ServerPickerScreen header options', () => {
    it('does not provide a headerTitle function that returns a raw string (RN Web text node error)', async () => {
        stackOptionsCapture.reset();
        await renderScreen(React.createElement(ServerPickerScreen));

        const resolvedOptions = stackOptionsCapture.getResolved();
        expect(resolvedOptions).toBeTruthy();
        expect(resolvedOptions?.headerTitle === undefined || typeof resolvedOptions?.headerTitle === 'string').toBe(true);
        standardCleanup();
    });
});
