import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import {
    createNavigationMock,
    createRouterMock,
    createStackOptionsCapture,
    enableReactActEnvironment,
    PICKER_THEME_COLORS,
    type PickerStackOptionsInput,
} from './testHarness';

enableReactActEnvironment();

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: PICKER_THEME_COLORS.header } } }),
}));

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();

vi.mock('expo-router', () => ({
    Stack: {
        Screen: ({ options }: { options: PickerStackOptionsInput }) => {
            stackOptionsCapture.record(options);
            return null;
        },
    },
    useRouter: () => routerMock,
    useNavigation: () => navigationMock,
    useLocalSearchParams: () => ({ selectedId: '' }),
}));

vi.mock('@/sync/storage', () => ({
    useSettingMutable: () => [[], vi.fn()],
}));

vi.mock('@/components/secrets/SecretsList', () => ({
    SecretsList: () => null,
}));

describe('SecretPickerScreen (iOS presentation)', () => {
    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;
        stackOptionsCapture.reset();

        await act(async () => {
            renderer.create(React.createElement(SecretPickerScreen));
        });

        const options = stackOptionsCapture.getResolved();
        expect(options?.presentation).toBe('containedModal');
        expect(typeof options?.headerLeft).toBe('function');

        const backButton = options?.headerLeft?.();
        expect(typeof backButton?.props?.onPress).toBe('function');
        backButton?.props?.onPress?.();
        expect(navigationMock.goBack).toHaveBeenCalledTimes(1);
    });
});
