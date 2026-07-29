import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installServerPickerRouteCommonModuleMocks } from './serverPickerRouteTestHelpers';

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
const newSessionPresentationModeState = vi.hoisted(() => ({
    value: 'auto' as 'auto' | 'screen' | 'modal',
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installServerPickerRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options.web ?? options.default,
            },
        });
    },
    router: async () => {
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
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (name: string) => {
                if (name === 'newSessionPresentationModeV1') return newSessionPresentationModeState.value;
                return null;
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    header: { tint: '#000' },
                    textSecondary: '#666',
                },
            },
        });
    },
});

vi.mock('@react-navigation/native', () => ({
    CommonActions: { setParams: (params: any) => ({ type: 'SET_PARAMS', payload: params }) },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
    ItemListStatic: (props: any) => React.createElement('ItemListStatic', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ generation: 1, serverId: 'server-a' }),
    listServerProfiles: () => [
        { id: 'server-a', name: 'A', serverUrl: 'http://a', lastUsedAt: 2 },
        { id: 'server-b', name: 'B', serverUrl: 'http://b', lastUsedAt: 1 },
    ],
}));

describe('ServerPickerScreen header options', () => {
    beforeEach(() => {
        newSessionPresentationModeState.value = 'auto';
        stackOptionsCapture.reset();
    });

    it('does not provide a headerTitle function that returns a raw string (RN Web text node error)', async () => {
        const { default: ServerPickerScreen } = await import('@/app/(app)/new/pick/server');
        await renderScreen(React.createElement(ServerPickerScreen));

        const resolvedOptions = stackOptionsCapture.getResolved();
        expect(resolvedOptions).toBeTruthy();
        expect(resolvedOptions?.headerTitle === undefined || typeof resolvedOptions?.headerTitle === 'string').toBe(true);
        standardCleanup();
    });

    it('presents as a modal on web by default and as a regular screen when requested', async () => {
        const { default: ServerPickerScreen } = await import('@/app/(app)/new/pick/server');

        await renderScreen(React.createElement(ServerPickerScreen));
        expect(stackOptionsCapture.getResolved()?.presentation).toBe('modal');
        standardCleanup();

        stackOptionsCapture.reset();
        newSessionPresentationModeState.value = 'screen';

        await renderScreen(React.createElement(ServerPickerScreen));
        expect(stackOptionsCapture.getResolved()?.presentation).toBeUndefined();
        standardCleanup();
    });
});
