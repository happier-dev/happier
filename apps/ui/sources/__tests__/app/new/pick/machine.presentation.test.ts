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

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();

vi.mock('react-native', () => {
    const React = require('react');
    type NativeChildrenProps = React.PropsWithChildren<Record<string, unknown>>;
    return {
        Platform: { OS: 'ios' },
        ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props),
        Pressable: (props: NativeChildrenProps) => React.createElement('Pressable', props, props.children),
        Text: (props: NativeChildrenProps) => React.createElement('Text', props, props.children),
        View: (props: NativeChildrenProps) => React.createElement('View', props, props.children),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: PICKER_THEME_COLORS.textSecondary,
                header: PICKER_THEME_COLORS.header,
                surface: PICKER_THEME_COLORS.surface,
            },
        },
    }),
    StyleSheet: { create: () => ({ container: {}, emptyContainer: {}, emptyText: {} }) },
}));

vi.mock('expo-router', () => ({
    Stack: {
        Screen: ({ options }: { options: PickerStackOptionsInput }) => {
            stackOptionsCapture.record(options);
            return React.createElement('StackScreen');
        },
    },
    useRouter: () => routerMock,
    useNavigation: () => navigationMock,
    useLocalSearchParams: () => ({ selectedId: 'm1' }),
}));

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => [],
    useSessions: () => [],
    useSetting: () => false,
    useSettingMutable: () => [[], vi.fn()],
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/utils/sessions/recentMachines', () => ({
    getRecentMachinesFromSessions: () => [],
}));

vi.mock('@/sync/sync', () => ({
    sync: { refreshMachinesThrottled: vi.fn() },
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    prefetchMachineCapabilities: vi.fn(),
}));

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    invalidateMachineEnvPresence: vi.fn(),
}));

describe('MachinePickerScreen (iOS presentation)', () => {
    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        const MachinePickerScreen = (await import('@/app/(app)/new/pick/machine')).default;
        stackOptionsCapture.reset();

        await act(async () => {
            renderer.create(React.createElement(MachinePickerScreen));
        });

        const options = stackOptionsCapture.getResolved();
        expect(options?.presentation).toBe('containedModal');
        expect(typeof options?.headerLeft).toBe('function');

        const backButton = options?.headerLeft?.();
        expect(typeof backButton?.props?.onPress).toBe('function');
        backButton?.props?.onPress?.();
        expect(routerMock.back).toHaveBeenCalledTimes(1);
    });
});
