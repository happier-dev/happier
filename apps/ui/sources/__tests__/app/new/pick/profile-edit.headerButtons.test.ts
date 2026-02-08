import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import {
    createStackOptionsCapture,
    enableReactActEnvironment,
    PICKER_NAV_STATE,
    PICKER_THEME_COLORS,
    type PickerStackOptionsInput,
} from './testHarness';

enableReactActEnvironment();

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'ios' },
        KeyboardAvoidingView: (props: any) => React.createElement('KeyboardAvoidingView', props, props.children),
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        useWindowDimensions: () => ({ width: 390, height: 844 }),
    };
});

vi.mock('@expo/vector-icons', () => {
    const React = require('react');
    return {
        Ionicons: (props: any) => React.createElement('Ionicons', props, props.children),
    };
});

vi.mock('expo-constants', () => ({
    default: { statusBarHeight: 0 },
}));

vi.mock('@react-navigation/elements', () => ({
    useHeaderHeight: () => 0,
}));

const routerMock = {
    back: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
};

const navigationMock = {
    setOptions: vi.fn(),
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    getState: vi.fn(() => PICKER_NAV_STATE),
    dispatch: vi.fn(),
};
const stackOptionsCapture = createStackOptionsCapture();

vi.mock('expo-router', () => {
    return {
        Stack: {
            Screen: ({ options }: { options: PickerStackOptionsInput }) => {
                stackOptionsCapture.record(options);
                return React.createElement('StackScreen');
            },
        },
        useRouter: () => routerMock,
        useLocalSearchParams: () => ({
            profileData: JSON.stringify({
                id: 'p1',
                name: 'Test profile',
                isBuiltIn: false,
                compatibility: { claude: true, codex: true, gemini: true },
            }),
        }),
        useNavigation: () => navigationMock,
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { header: PICKER_THEME_COLORS.header, groupped: PICKER_THEME_COLORS.groupped } },
        rt: { insets: { bottom: 0 } },
    }),
    StyleSheet: {
        create: (fn: (theme: { colors: { groupped: typeof PICKER_THEME_COLORS.groupped } }, rt: { insets: { bottom: number } }) => unknown) =>
            fn({ colors: { groupped: PICKER_THEME_COLORS.groupped } }, { insets: { bottom: 0 } }),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/profiles/edit', () => ({
    ProfileEditForm: () => React.createElement('ProfileEditForm'),
}));

vi.mock('@/components/layout', () => ({
    layout: { maxWidth: 1024 },
}));

vi.mock('@/sync/storage', () => ({
    useSettingMutable: () => [[], vi.fn()],
}));

vi.mock('@/sync/profileUtils', () => ({
    DEFAULT_PROFILES: [],
    getBuiltInProfile: () => null,
    getBuiltInProfileNameKey: () => null,
    resolveProfileById: () => null,
}));

vi.mock('@/sync/profileMutations', () => ({
    convertBuiltInProfileToCustom: <T,>(profile: T) => profile,
    createEmptyCustomProfile: () => ({ id: 'new', name: '', isBuiltIn: false, compatibility: { claude: true, codex: true, gemini: true } }),
    duplicateProfileForEdit: <T,>(profile: T) => profile,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), show: vi.fn() },
}));

vi.mock('@/utils/ui/promptUnsavedChangesAlert', () => ({
    promptUnsavedChangesAlert: vi.fn(async () => 'keep'),
}));

describe('ProfileEditScreen (header buttons)', () => {
    it('renders a header close button even when the form is pristine', async () => {
        const ProfileEditScreen = (await import('@/app/(app)/new/pick/profile-edit')).default;
        stackOptionsCapture.reset();

        await act(async () => {
            renderer.create(React.createElement(ProfileEditScreen));
        });

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerLeft).toBe('function');
    });

    it('renders a disabled header save button when the form is pristine', async () => {
        const ProfileEditScreen = (await import('@/app/(app)/new/pick/profile-edit')).default;
        stackOptionsCapture.reset();

        await act(async () => {
            renderer.create(React.createElement(ProfileEditScreen));
        });

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerRight).toBe('function');

        const headerRight = options?.headerRight;
        const saveButton = headerRight?.();
        expect(saveButton?.props?.disabled).toBe(true);
    });
});
