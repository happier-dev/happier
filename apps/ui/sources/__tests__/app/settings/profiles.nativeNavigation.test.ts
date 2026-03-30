import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { createCapturingComponent, createPassThroughComponent } from '@/dev/testkit/mocks/components';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { installProfilesCommonModuleMocks } from '@/components/profiles/profilesTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

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

const profileEditPath = '/new/pick/profile-edit' as const;
const testProfileCompatibility: ProfileCompatibility = {
    claude: true,
    codex: true,
    gemini: true,
};
const testProfileRow: ProfileRow = {
    id: 'p1',
    name: 'Test profile',
    isBuiltIn: false,
    compatibility: testProfileCompatibility,
};

installProfilesCommonModuleMocks({
    reactNative: () => createReactNativeWebMock({
        Platform: {
            OS: 'ios',
        },
    }),
    storage: () => createStorageModuleStub({
        useSetting: () => false,
        useSettingMutable: () => [[], vi.fn()],
    }),
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

vi.mock('@/utils/ui/promptUnsavedChangesAlert', () => ({
    promptUnsavedChangesAlert: vi.fn(async () => 'keep'),
}));

vi.mock('@/components/profiles/edit', () => ({
    ProfileEditForm: createPassThroughComponent('ProfileEditForm'),
}));

let capturedProfilesListProps: CapturedProfilesListProps | null = null;
vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: createCapturingComponent('ProfilesList', (props) => {
        capturedProfilesListProps = props as CapturedProfilesListProps;
    }),
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
    ItemList: createPassThroughComponent('ItemList'),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassThroughComponent('ItemGroup'),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassThroughComponent('Item'),
}));
vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: createPassThroughComponent('Switch'),
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: createPassThroughComponent('SecretRequirementModal'),
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
            pathname: profileEditPath,
            params: {},
        });
    });

    it('navigates to the profile edit screen instead of using the inline modal editor', async () => {
        routerMock.push.mockClear();
        await renderProfileManager();

        expect(typeof capturedProfilesListProps?.onEditProfile).toBe('function');
        await act(async () => {
            capturedProfilesListProps?.onEditProfile?.(testProfileRow);
        });

        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: profileEditPath,
            params: { profileId: testProfileRow.id },
        });
    });

    it('navigates with clone id when duplicating a profile', async () => {
        routerMock.push.mockClear();
        await renderProfileManager();

        expect(typeof capturedProfilesListProps?.onDuplicateProfile).toBe('function');
        await act(async () => {
            capturedProfilesListProps?.onDuplicateProfile?.(testProfileRow);
        });

        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: profileEditPath,
            params: { cloneFromProfileId: testProfileRow.id },
        });
    });
});
