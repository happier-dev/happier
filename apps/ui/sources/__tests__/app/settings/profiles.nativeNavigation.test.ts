import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

type NativeChildrenProps = React.PropsWithChildren<Record<string, unknown>>;
type ProfileCompatibility = {
    claude: boolean;
    codex: boolean;
    gemini: boolean;
};
type ProfileRow = {
    id: string;
    name: string;
    isBuiltIn: boolean;
    compatibility: ProfileCompatibility;
};
type CapturedProfilesListProps = {
    onAddProfilePress?: () => void;
    onDuplicateProfile?: (profile: ProfileRow) => void;
    onEditProfile?: (profile: ProfileRow) => void;
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
        },
    });
});

const routerMock = vi.hoisted(() => ({
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
    navigationSetOptions: vi.fn(),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        navigation: { setOptions: routerMock.navigationSetOptions },
    });
    routerMock.push = expoRouterMock.spies.push;
    routerMock.back = expoRouterMock.spies.back;
    routerMock.replace = expoRouterMock.spies.replace;
    routerMock.setParams = expoRouterMock.spies.setParams;
    return expoRouterMock.module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: () => false,
        useSettingMutable: () => [[], vi.fn()],
    });
});

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

vi.mock('@/components/profiles/edit', () => ({
    ProfileEditForm: () => React.createElement('ProfileEditForm'),
}));

let capturedProfilesListProps: CapturedProfilesListProps | null = null;
vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: (props: CapturedProfilesListProps) => {
        capturedProfilesListProps = props;
        return React.createElement('ProfilesList');
    },
}));

vi.mock('@/sync/domains/profiles/profileUtils', () => ({
    DEFAULT_PROFILES: [],
    getBuiltInProfileNameKey: () => null,
    resolveProfileById: () => null,
}));

vi.mock('@/sync/domains/profiles/profileMutations', () => ({
    convertBuiltInProfileToCustom: <T,>(profile: T) => profile,
    createEmptyCustomProfile: () => ({ id: 'new', name: '', isBuiltIn: false, compatibility: { claude: true, codex: true, gemini: true } }),
    duplicateProfileForEdit: <T,>(profile: T) => profile,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: NativeChildrenProps) => React.createElement('ItemList', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: NativeChildrenProps) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: NativeChildrenProps) => React.createElement('Item', props, props.children),
}));
vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: NativeChildrenProps) => React.createElement('Switch', props, props.children),
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: () => React.createElement('SecretRequirementModal'),
}));

vi.mock('@/utils/secrets/secretSatisfaction', () => ({
    getSecretSatisfaction: () => ({ isSatisfied: true, items: [] }),
}));

vi.mock('@/sync/domains/profiles/profileSecrets', () => ({
    getRequiredSecretEnvVarNames: () => [],
}));

describe('ProfileManager (native)', () => {
    async function renderProfileManager() {
        const ProfileManager = (await import('@/app/(app)/settings/profiles')).default;
        capturedProfilesListProps = null;
        await renderScreen(React.createElement(ProfileManager));
    }

    it('navigates to the profile edit screen when adding a profile', async () => {
        routerMock.push.mockClear();
        await renderProfileManager();

        expect(typeof capturedProfilesListProps?.onAddProfilePress).toBe('function');
        await act(async () => {
            capturedProfilesListProps?.onAddProfilePress?.();
        });

        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/profile-edit',
            params: {},
        });
    });

    it('navigates to the profile edit screen instead of using the inline modal editor', async () => {
        routerMock.push.mockClear();
        await renderProfileManager();

        expect(typeof capturedProfilesListProps?.onEditProfile).toBe('function');
        await act(async () => {
            capturedProfilesListProps?.onEditProfile?.({
                id: 'p1',
                name: 'Test profile',
                isBuiltIn: false,
                compatibility: { claude: true, codex: true, gemini: true },
            });
        });

        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/profile-edit',
            params: { profileId: 'p1' },
        });
    });

    it('navigates with clone id when duplicating a profile', async () => {
        routerMock.push.mockClear();
        await renderProfileManager();

        expect(typeof capturedProfilesListProps?.onDuplicateProfile).toBe('function');
        await act(async () => {
            capturedProfilesListProps?.onDuplicateProfile?.({
                id: 'p1',
                name: 'Test profile',
                isBuiltIn: false,
                compatibility: { claude: true, codex: true, gemini: true },
            });
        });

        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/profile-edit',
            params: { cloneFromProfileId: 'p1' },
        });
    });
});
