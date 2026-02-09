import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { createRouterMock, enableReactActEnvironment, PICKER_NAV_STATE, PICKER_THEME_COLORS, type PickerStackOptionsInput } from './testHarness';

enableReactActEnvironment();

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    View: 'View',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), show: vi.fn() },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => (key === 'useProfiles' ? false : false),
    useSettingMutable: () => [[], vi.fn()],
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: () => null,
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: () => null,
}));

vi.mock('@/utils/secrets/secretSatisfaction', () => ({
    getSecretSatisfaction: () => ({ isSatisfied: true, items: [] }),
}));

vi.mock('@/sync/domains/profiles/profileSecrets', () => ({
    getRequiredSecretEnvVarNames: () => [],
}));

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({ isLoading: false, isPreviewEnvSupported: false, meta: {} }),
}));

vi.mock('@/sync/ops', () => ({
    machinePreviewEnv: vi.fn(async () => ({ supported: false })),
}));

vi.mock('@/sync/domains/settings/settings', () => ({
    getProfileEnvironmentVariables: () => ({}),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: () => 'temp',
    getTempData: () => null,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: PICKER_THEME_COLORS.header } } }),
    StyleSheet: { create: () => ({}) },
}));

describe('ProfilePickerScreen (Stack.Screen options stability)', () => {
    it('does not trigger an infinite setOptions update loop', async () => {
        const routerApi = createRouterMock();
        const listeners = new Set<() => void>();
        let setOptionsCalls = 0;
        const observedOptions: unknown[] = [];
        let searchParams = { selectedId: '', machineId: 'm1' };

        const navigationApi = {
            getState: () => PICKER_NAV_STATE,
            dispatch: vi.fn(),
            setOptions: (_options: unknown) => {
                setOptionsCalls += 1;
                observedOptions.push(_options);
                if (setOptionsCalls > 8) {
                    throw new Error(`setOptions loop detected after ${setOptionsCalls} calls`);
                }
                listeners.forEach((notify) => notify());
            },
        };

        vi.doMock('expo-router', () => ({
            Stack: {
                Screen: ({ options }: { options: PickerStackOptionsInput }) => {
                    React.useEffect(() => {
                        navigationApi.setOptions(typeof options === 'function' ? options() : options);
                    }, [options]);
                    return null;
                },
            },
            useRouter: () => routerApi,
            useNavigation: () => {
                const [, force] = React.useReducer((x) => x + 1, 0);
                React.useLayoutEffect(() => {
                    listeners.add(force);
                    return () => void listeners.delete(force);
                }, [force]);
                return navigationApi;
            },
            useLocalSearchParams: () => searchParams,
        }));

        const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;
        let tree: renderer.ReactTestRenderer | undefined;

        await act(async () => {
            tree = renderer.create(React.createElement(ProfilePickerScreen));
        });

        searchParams = { selectedId: 'profile-1', machineId: 'm1' };
        await act(async () => {
            tree?.update(React.createElement(ProfilePickerScreen));
        });

        expect(setOptionsCalls).toBeGreaterThan(0);
        expect(setOptionsCalls).toBeLessThanOrEqual(2);
        expect(observedOptions.every((entry) => entry === observedOptions[0])).toBe(true);
    });
});
