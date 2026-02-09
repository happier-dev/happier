import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import {
    createNavigationMock,
    createRouterMock,
    createStackOptionsCapture,
    enableReactActEnvironment,
    PICKER_NAV_STATE,
    PICKER_THEME_COLORS,
    type PickerStackOptionsInput,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
navigationMock.getState = () => PICKER_NAV_STATE;
const stackOptionsCapture = createStackOptionsCapture();

vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    View: 'View',
}));

vi.mock('expo-router', () => ({
    Stack: {
        Screen: ({ options }: { options: PickerStackOptionsInput }) => {
            stackOptionsCapture.record(options);
            return null;
        },
    },
    useRouter: () => routerMock,
    useNavigation: () => navigationMock,
    useLocalSearchParams: () => ({ selectedId: '', machineId: 'm1' }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: PICKER_THEME_COLORS } }),
    StyleSheet: { create: () => ({}) },
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
    useMachineEnvPresence: () => ({ refresh: vi.fn(), machineEnvReadyByName: {} }),
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

describe('ProfilePickerScreen (iOS presentation)', () => {
    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        vi.resetModules();
        const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;
        stackOptionsCapture.reset();

        await act(async () => {
            renderer.create(React.createElement(ProfilePickerScreen));
        });

        const resolvedOptions = stackOptionsCapture.getResolved();
        expect(resolvedOptions?.presentation).toBe('containedModal');
        expect(typeof resolvedOptions?.headerLeft).toBe('function');

        const backButton = resolvedOptions?.headerLeft?.();
        expect(typeof backButton?.props?.onPress).toBe('function');
        backButton?.props?.onPress?.();
        expect(navigationMock.goBack).toHaveBeenCalledTimes(1);
    });
});
