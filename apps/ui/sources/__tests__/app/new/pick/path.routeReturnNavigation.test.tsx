import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import {
    cloneNavigationState,
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    PICKER_THEME_COLORS,
    type PickerNavigationState,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const safeRouterBack = vi.fn();
const pickerMachineMetadata = {
    host: 'tester.local',
    platform: 'darwin',
    happyCliVersion: '0.0.0-test',
    happyHomeDir: '/Users/tester/.happy-dev',
    homeDir: '/home/test',
} as const;
const pickerMachine = createMachineFixture({
    id: 'machine-1',
    metadata: pickerMachineMetadata,
});
let capturedPathSelectorProps: {
    onSubmitSelectedPath: (path: string) => void;
    selectedPath?: string;
} | null = null;
let localSearchParams: Record<string, string> = {
    machineId: 'machine-1',
    selectedPath: '/repo/current',
};
let navigationState: PickerNavigationState = cloneNavigationState({
    index: 0,
    routes: [{ key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' }],
});
const paramListeners = new Set<() => void>();

function emitLocalSearchParamsChange() {
    for (const listener of paramListeners) {
        listener();
    }
}
installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'web' },
        }),
    unistyles: async () =>
        (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
            theme: {
                colors: {
                    ...PICKER_THEME_COLORS,
                    input: { background: '#fff', placeholder: '#aaa', text: '#000' },
                },
            },
        }),
    expoRouter: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const module = createExpoRouterMock({
            navigation: navigationMock,
            router: {
                push: routerMock.push,
                back: routerMock.back,
                replace: routerMock.replace,
                setParams: routerMock.setParams,
            },
        }).module;

        return {
            ...module,
            useNavigation: () => navigationMock,
            useLocalSearchParams: () =>
                React.useSyncExternalStore(
                    (listener) => {
                        paramListeners.add(listener);
                        return () => {
                            paramListeners.delete(listener);
                        };
                    },
                    () => localSearchParams,
                    () => localSearchParams,
                ),
        };
    },
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useAllMachines: () => [pickerMachine],
                useSessions: () => [],
                useSetting: (key: string) => {
                    if (key === 'recentMachinePaths') return [];
                    if (key === 'usePathPickerSearch') return false;
                    return null;
                },
                useSettingMutable: () => [[], vi.fn()],
            },
        }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
});

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', params }),
    },
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: (props: any) => {
        capturedPathSelectorProps = props;
        return React.createElement('PathSelector', props);
    },
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
    getRecentPathsForMachine: () => [],
}));

vi.mock('@/utils/navigation/safeRouterBack', () => ({
    safeRouterBack: (...args: any[]) => safeRouterBack(...args),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 920 },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

describe('PathPickerScreen', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        capturedPathSelectorProps = null;
        localSearchParams = {
            machineId: 'machine-1',
            selectedPath: '/repo/current',
        };
        paramListeners.clear();
        routerMock.setParams.mockReset();
        routerMock.replace.mockReset();
        routerMock.back.mockReset();
        safeRouterBack.mockReset();
        navigationMock.dispatch.mockReset();
        navigationState = {
            index: 0,
            routes: [{ key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' }],
        };
        navigationMock.getState = () => navigationState;
    });

    async function renderPathPicker() {
        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;
        const screen = await renderScreen(React.createElement(PathPickerScreen));
        return { PathPickerScreen, screen };
    }

    it('replaces to new session with path params when confirming without a previous route', async () => {
        await renderPathPicker();

        expect(capturedPathSelectorProps).toBeTruthy();

        capturedPathSelectorProps?.onSubmitSelectedPath('/repo/selected');

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-1',
                directory: '/repo/selected',
            },
        });
        expect(routerMock.setParams).not.toHaveBeenCalled();
        expect(safeRouterBack).not.toHaveBeenCalled();
    });

    it('replaces back to /new instead of mutating a non-new previous route under the modal stack', async () => {
        navigationState = {
            index: 1,
            routes: [
                {
                    key: 'session-route',
                    name: '(app)/session/[id]',
                    path: '/session/s1',
                    params: { id: 's1' },
                },
                {
                    key: 'path-picker',
                    name: '(app)/new/pick/path',
                    path: '/new/pick/path',
                },
            ],
        };

        await renderPathPicker();

        expect(capturedPathSelectorProps).toBeTruthy();

        capturedPathSelectorProps?.onSubmitSelectedPath('/repo/selected');

        expect(navigationMock.dispatch).not.toHaveBeenCalled();
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-1',
                directory: '/repo/selected',
            },
        });
        expect(safeRouterBack).not.toHaveBeenCalled();
    });

    it('returns path updates to the actual /new screen instead of an intermediate picker route', async () => {
        navigationState = {
            index: 3,
            routes: [
                {
                    key: 'session-route',
                    name: '(app)/session/[id]',
                    path: '/session/s1',
                    params: { id: 's1' },
                },
                {
                    key: 'new-route',
                    name: '(app)/new/index',
                    path: '/new',
                    params: { machineId: 'machine-1' },
                },
                {
                    key: 'profile-picker',
                    name: '(app)/new/pick/profile',
                    path: '/new/pick/profile',
                    params: { profileId: 'profile-1' },
                },
                {
                    key: 'path-picker',
                    name: '(app)/new/pick/path',
                    path: '/new/pick/path',
                },
            ],
        };

        await renderPathPicker();

        expect(capturedPathSelectorProps).toBeTruthy();

        capturedPathSelectorProps?.onSubmitSelectedPath('/repo/selected');

        expect(navigationMock.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            source: 'new-route',
            payload: expect.objectContaining({
                params: expect.objectContaining({
                    directory: '/repo/selected',
                }),
            }),
        }));
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(safeRouterBack).toHaveBeenCalled();
    });

    it('uses the direct-entry path query as a fallback selected path', async () => {
        localSearchParams = {
            machineId: 'machine-1',
            path: '/repo/direct-entry',
        };

        await renderPathPicker();

        expect(capturedPathSelectorProps?.selectedPath).toBe('/repo/direct-entry');
    });

    it('updates the selected path when route params change after mount', async () => {
        await renderPathPicker();

        expect(capturedPathSelectorProps?.selectedPath).toBe('/repo/current');

        localSearchParams = {
            machineId: 'machine-1',
            selectedPath: '/repo/updated',
        };

        act(() => {
            emitLocalSearchParamsChange();
        });

        expect(capturedPathSelectorProps?.selectedPath).toBe('/repo/updated');
    });
});
