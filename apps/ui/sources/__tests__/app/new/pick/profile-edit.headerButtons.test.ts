import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    createNavigationMock,
    createRouterMock,
    createStackOptionsCapture,
    enableReactActEnvironment,
    PICKER_NAV_STATE,
    PICKER_THEME_COLORS,
} from './testHarness';

enableReactActEnvironment();

type KeyboardAvoidingViewProps = Readonly<{
    children?: React.ReactNode;
} & Record<string, unknown>>;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            KeyboardAvoidingView: (props: KeyboardAvoidingViewProps) =>
                React.createElement('KeyboardAvoidingView', props, props.children),
            Platform: { OS: 'ios' },
            useWindowDimensions: () => ({ width: 390, height: 844 }),
        }
    );
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('expo-constants', () => ({
    default: { statusBarHeight: 0 },
}));

vi.mock('@react-navigation/elements', () => ({
    useHeaderHeight: () => 0,
}));

const routerMock = createRouterMock();
const navigationMock = createNavigationMock() as ReturnType<typeof createNavigationMock> & {
    setOptions: ReturnType<typeof vi.fn>;
    addListener: ReturnType<typeof vi.fn>;
};
navigationMock.setOptions = vi.fn();
navigationMock.addListener = vi.fn(() => ({ remove: vi.fn() }));
const stackOptionsCapture = createStackOptionsCapture();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        navigation: navigationMock,
        params: {
            profileData: JSON.stringify({
                id: 'p1',
                name: 'Test profile',
                isBuiltIn: false,
                compatibility: { claude: true, codex: true, gemini: true },
            }),
        },
        router: {
            push: routerMock.push,
            back: routerMock.back,
            replace: routerMock.replace,
            setParams: routerMock.setParams,
        },
        stackOptionsCapture,
    }).module;
});

vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
        theme: { colors: { header: PICKER_THEME_COLORS.header, groupped: PICKER_THEME_COLORS.groupped } },
        runtime: { insets: { bottom: 0 } },
    }));

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

vi.mock('@/components/profiles/edit', () => ({
    ProfileEditForm: () => React.createElement('ProfileEditForm'),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024 },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
        importOriginal,
        overrides: {
            useSettingMutable: () => [[], vi.fn()],
        },
    }));

vi.mock('@/sync/domains/profiles/profileUtils', () => ({
    DEFAULT_PROFILES: [],
    getBuiltInProfile: () => null,
    getBuiltInProfileNameKey: () => null,
    resolveProfileById: () => null,
}));

vi.mock('@/sync/domains/profiles/profileMutations', () => ({
    convertBuiltInProfileToCustom: <T,>(profile: T) => profile,
    createEmptyCustomProfile: () => ({ id: 'new', name: '', isBuiltIn: false, compatibility: { claude: true, codex: true, gemini: true } }),
    duplicateProfileForEdit: <T,>(profile: T) => profile,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: vi.fn(),
            show: vi.fn(),
        },
    }).module;
});

vi.mock('@/utils/ui/promptUnsavedChangesAlert', () => ({
    promptUnsavedChangesAlert: vi.fn(async () => 'keep'),
}));

describe('ProfileEditScreen (header buttons)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        stackOptionsCapture.reset();
        navigationMock.getState = vi.fn(() => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        }));
    });

    it('renders a header close button even when the form is pristine', async () => {
        const ProfileEditScreen = (await import('@/app/(app)/new/pick/profile-edit')).default;
        await renderScreen(React.createElement(ProfileEditScreen));

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerLeft).toBe('function');
    });

    it('renders a disabled header save button when the form is pristine', async () => {
        const ProfileEditScreen = (await import('@/app/(app)/new/pick/profile-edit')).default;
        await renderScreen(React.createElement(ProfileEditScreen));

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerRight).toBe('function');

        const headerRight = options?.headerRight;
        const saveButton = headerRight?.();
        expect(saveButton?.props?.disabled).toBe(true);
    });
});
