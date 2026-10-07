import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { renderInCollectionLayout, standardCleanup } from '@/dev/testkit';
import { createCapturingComponent, createPassThroughComponent } from '@/dev/testkit/mocks/components';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installProfilesCommonModuleMocks } from '@/components/profiles/profilesTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary();
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

type ProfileRow = { id: string; name: string };
type CapturedProfilesListProps = {
    includeDefaultEnvironmentRow?: boolean;
    onPressDefaultEnvironment?: () => void;
    onAddProfilePress?: () => void;
    onPressProfile?: (profile: ProfileRow) => void;
    onDuplicateProfile?: (profile: ProfileRow) => void;
    onEditProfile?: (profile: ProfileRow) => void;
};

const testProfileRow: ProfileRow = { id: 'p1', name: 'Test profile' };
const savedProfile = {
    v: 2 as const,
    id: 'p1',
    name: 'Test profile',
    extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {},
    defaultPersistenceModeByTargetKey: {},
    compatibilityByTargetKey: {},
    createdAt: 1,
    updatedAt: 1,
};
const settingsState = vi.hoisted(() => ({
    values: {} as Record<string, unknown>,
}));

installProfilesCommonModuleMocks({
    reactNative: () => createReactNativeWebMock({
        Platform: {
            OS: 'ios',
        },
    }),
    storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
});

const routerMock = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock();
    routerMock.push = expoRouterMock.spies.push;
    routerMock.replace = expoRouterMock.spies.replace;
    return expoRouterMock.module;
});

let capturedProfilesListProps: CapturedProfilesListProps | null = null;
vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: createCapturingComponent('ProfilesList', (props) => {
        capturedProfilesListProps = props as CapturedProfilesListProps;
    }),
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => ({
        selectedTarget: null,
        resolveExecutionTarget: () => null,
    }),
}));
vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: createPassThroughComponent('MachineAdministrationTargetSelector'),
}));
vi.mock('@/components/secrets/useSavedSecretsMutable', () => ({
    useSavedSecretsMutable: () => [[], vi.fn()],
}));
vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: createPassThroughComponent('SecretRequirementModal'),
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

function resetSettings(overrides: Record<string, unknown> = {}) {
    settingsState.values = {
        useProfiles: true,
        profiles: [savedProfile],
        favoriteProfiles: [],
        profileEnabledById: {},
        providerSettingsV1: null,
        currentSecretBindingsByProfileId: {},
        lastUsedProfile: null,
        ...overrides,
    };
}

async function renderIndex(mode: 'split' | 'stacked' | null) {
    account = await createSecretSettingsTestHarness({ settings: settingsParse(settingsState.values), sharedEnabled: false });
    const { ProfileSettingsIndex } = await import('@/components/settings/profiles/ProfileSettingsIndex');
    capturedProfilesListProps = null;
    routerMock.push.mockClear();
    return renderInCollectionLayout(
        React.createElement(InjectedAuthProvider, {
            credentials: account.credentials,
            children: React.createElement(ProfileSettingsIndex),
        }),
        mode,
    );
}

afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
});

describe('Settings › Profiles collection list', () => {
    it('adds a profile as a draft in the collection', async () => {
        resetSettings();
        await renderIndex('stacked');

        await act(async () => {
            capturedProfilesListProps?.onAddProfilePress?.();
        });

        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith('/settings/profiles/new');
    });

    it('opens a profile, and a copy of one, in the collection instead of an inline or new-session editor', async () => {
        resetSettings();
        await renderIndex('stacked');

        await act(async () => {
            capturedProfilesListProps?.onEditProfile?.(testProfileRow);
        });
        await act(async () => {
            capturedProfilesListProps?.onPressProfile?.(testProfileRow);
        });
        await act(async () => {
            capturedProfilesListProps?.onDuplicateProfile?.(testProfileRow);
        });

        expect(routerMock.push.mock.calls).toEqual([
            ['/settings/profiles/p1'],
            ['/settings/profiles/p1'],
            ['/settings/profiles/new?cloneFrom=p1'],
        ]);
    });

    it('keeps Default Environment visible as the first-class no-profile choice, with its own detail', async () => {
        resetSettings();
        await renderIndex('stacked');

        expect(capturedProfilesListProps?.includeDefaultEnvironmentRow).toBe(true);
        await act(async () => {
            capturedProfilesListProps?.onPressDefaultEnvironment?.();
        });
        expect(routerMock.push).toHaveBeenCalledWith('/settings/profiles/default-environment');
    });

    it('lands on a profile beside the rail instead of an empty detail', async () => {
        resetSettings();
        const screen = await renderIndex('split');

        const redirects = screen.findAll((node) => String(node.type) === 'Redirect');
        expect(redirects).toHaveLength(1);
        expect(redirects[0]?.props.href).toBe('/settings/profiles/p1');
        expect(capturedProfilesListProps).toBeNull();
    });

    it('lands on the no-profile choice, not a blank draft, when there is no profile to show', async () => {
        resetSettings({ profiles: [] });
        const screen = await renderIndex('split');

        const redirects = screen.findAll((node) => String(node.type) === 'Redirect');
        expect(redirects.map((node) => node.props.href)).toEqual(['/settings/profiles/default-environment']);
    });

    it('shows only the switch that turns profiles on while they are off', async () => {
        resetSettings({ useProfiles: false });
        const screen = await renderIndex('split');

        expect(screen.findAll((node) => String(node.type) === 'Redirect')).toHaveLength(0);
        expect(capturedProfilesListProps).toBeNull();
        expect(screen.findByTestId('settings.profiles.useProfiles')).not.toBeNull();
    });
});
