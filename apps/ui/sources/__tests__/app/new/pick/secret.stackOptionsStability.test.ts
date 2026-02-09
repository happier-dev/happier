import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import {
    createNavigationMock,
    createRouterMock,
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: () => React.useState<readonly unknown[]>([]),
}));

vi.mock('@/components/secrets/SecretsList', () => ({
    SecretsList: ({ onChangeSecrets }: { onChangeSecrets?: (next: readonly unknown[]) => void }) => {
        const didTriggerRef = React.useRef(false);
        React.useEffect(() => {
            if (didTriggerRef.current) return;
            didTriggerRef.current = true;
            onChangeSecrets?.([]);
        }, [onChangeSecrets]);
        return null;
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: PICKER_THEME_COLORS.header } } }),
}));

describe('SecretPickerScreen (Stack.Screen options stability)', () => {
    it('keeps Stack.Screen options referentially stable across parent re-renders', async () => {
        const routerApi = createRouterMock();
        const navigationApi = createNavigationMock();
        let searchParams = { selectedId: '' };
        const setOptions = vi.fn();

        vi.doMock('expo-router', () => ({
            Stack: {
                Screen: ({ options }: { options: PickerStackOptionsInput }) => {
                    React.useEffect(() => {
                        setOptions(options);
                    }, [options]);
                    return null;
                },
            },
            useRouter: () => routerApi,
            useNavigation: () => navigationApi,
            useLocalSearchParams: () => searchParams,
        }));

        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;
        let tree: renderer.ReactTestRenderer | undefined;

        await act(async () => {
            tree = renderer.create(React.createElement(SecretPickerScreen));
        });

        searchParams = { selectedId: 'secret-1' };
        await act(async () => {
            tree?.update(React.createElement(SecretPickerScreen));
        });

        expect(setOptions).toHaveBeenCalledTimes(1);
    });
});
