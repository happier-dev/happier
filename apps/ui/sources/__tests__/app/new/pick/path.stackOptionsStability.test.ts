import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    PICKER_NAV_STATE,
    type PickerStackOptionsInput,
} from './testHarness';

enableReactActEnvironment();

const setOptionsSpy = vi.hoisted(() => vi.fn());
const pickerMachineMetadata = {
    host: 'tester.local',
    platform: 'darwin',
    happyCliVersion: '0.0.0-test',
    happyHomeDir: '/Users/tester/.happy-dev',
    homeDir: '/home',
} as const;
const stableMachines = [
    createMachineFixture({
        id: 'm1',
        metadata: pickerMachineMetadata,
    }),
];
const stableSessions: Session[] = [];
const stableRecentMachinePaths: string[] = [];
const stableFavoriteDirectories: string[] = [];
let localSearchParams: { machineId: string; selectedPath: string } = { machineId: 'm1', selectedPath: '' };
const routerApi = createRouterMock();
const navigationApi = createNavigationMock();

type ItemGroupProps = React.PropsWithChildren<Record<string, never>>;
type PathSelectorProps = {
    onChangeSearchQuery?: (value: string) => void;
    onChangeSelectedPath?: (value: string) => void;
};

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: ItemGroupProps) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 720 },
}));

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: (props: PathSelectorProps) => {
        const didTriggerRef = React.useRef(false);
        React.useEffect(() => {
            if (didTriggerRef.current) return;
            didTriggerRef.current = true;
            // Trigger a state update that should NOT require updating Stack.Screen options.
            props.onChangeSelectedPath?.('/tmp/typing');
            props.onChangeSearchQuery?.('abc');
        }, [props]);
        return null;
    },
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
    getRecentPathsForMachine: () => [],
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
    },
}));
installPickerCommonModuleMocks({
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios', select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? null },
        }),
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useAllMachines: () => stableMachines,
                useSessions: () => stableSessions,
                useSetting: (key: string) => {
                    if (key === 'usePathPickerSearch') return false;
                    if (key === 'recentMachinePaths') return stableRecentMachinePaths;
                    return null;
                },
                useSettingMutable: () => [stableFavoriteDirectories, vi.fn()],
            },
        }),
    expoRouter: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const baseModule = createExpoRouterMock({
            navigation: navigationApi,
            router: {
                push: routerApi.push,
                back: routerApi.back,
                replace: routerApi.replace,
                setParams: routerApi.setParams,
            },
        }).module;

        return {
            ...baseModule,
            Stack: {
                Screen: ({ options }: { options: PickerStackOptionsInput }) => {
                    React.useEffect(() => {
                        setOptionsSpy(options);
                    }, [options]);
                    return null;
                },
            },
            useNavigation: () => navigationApi,
            useLocalSearchParams: () => localSearchParams,
        };
    },
});

describe('PathPickerScreen (Stack.Screen options stability)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        localSearchParams = { machineId: 'm1', selectedPath: '' };
        navigationApi.getState = () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        });
        navigationApi.dispatch.mockClear();
        navigationApi.goBack.mockClear();
        navigationApi.setParams.mockClear();
        routerApi.push.mockClear();
        routerApi.back.mockClear();
        routerApi.replace.mockClear();
        routerApi.setParams.mockClear();
        setOptionsSpy.mockClear();
    });

    it('keeps Stack.Screen options referentially stable across parent re-renders', async () => {
        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;
        const screen = await renderScreen(React.createElement(PathPickerScreen));

        localSearchParams = { machineId: 'm1', selectedPath: '/tmp/next' };
        await screen.update(React.createElement(PathPickerScreen));

        expect(setOptionsSpy).toHaveBeenCalledTimes(1);
    });
});
