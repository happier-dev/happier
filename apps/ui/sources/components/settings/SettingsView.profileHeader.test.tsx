import * as React from 'react';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderSettingsView } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';
import { profileDefaults, type Profile } from '@/sync/domains/profiles/profile';

const tauriDesktopState = vi.hoisted(() => ({ value: true }));
const profileState = vi.hoisted(() => ({ value: null as Profile | null }));
const machinesState = vi.hoisted(() => ({ value: [] as unknown[] }));
const routerPush = vi.hoisted(() => ({ spy: null as null | ((route: unknown) => void) }));
// The chosen account service and this device's stored sign-in for it (secure storage).
const accountServiceState = vi.hoisted(() => ({
    mutationListeners: new Set<() => void>(),
    endpoint: { url: 'https://accounts.acme.test', serverIdentityId: 'srv-acme', displayName: 'Acme Accounts' } as Record<string, unknown>,
    storedCredential: null as unknown,
}));

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'useProfiles') return false;
                if (key === 'sessionUseTmux') return false;
                return null;
            },
            useEntitlement: () => false,
            useProfile: () => profileState.value,
            useAllMachines: () => machinesState.value,
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: (route: unknown) => routerPush.spy?.(route),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
});

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => tauriDesktopState.value,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ discoverable: false, blockedBy: null }),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: vi.fn(async () => {}),
        presentPaywall: vi.fn(async () => ({ success: true })),
        refreshProfile: vi.fn(async () => {}),
    },
}));

vi.mock('@/track', () => ({
    trackPaywallButtonClicked: vi.fn(),
    trackWhatsNewClicked: vi.fn(),
}));

vi.mock('@/hooks/ui/useMultiClick', () => ({
    useMultiClick: (cb: () => void) => cb,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/utils/system/requestReview', () => ({
    canRequestReview: vi.fn(async () => false),
    requestReview: vi.fn(async () => {}),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

// Navigation focus: the test decides when the Settings home regains focus.
const focusState = vi.hoisted(() => ({ callbacks: new Set<() => void>() }));
vi.mock('@react-navigation/native', async () => {
    const React = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useFocusEffect: (callback: () => void | (() => void)) => {
            React.useEffect(() => {
                const run = () => { callback(); };
                focusState.callbacks.add(run);
                run();
                return () => { focusState.callbacks.delete(run); };
            }, [callback]);
        },
    };
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('Item', props, props.children),
}));


vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: Record<string, unknown>) => React.createElement('Avatar', props),
}));


vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: (props: Record<string, unknown>) => React.createElement('MachineCliGlyphs', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown>) => React.createElement('Text', props),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@/components/settings/supportUsBehavior', () => ({
    resolveSupportUsAction: () => 'github',
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    resolveSelectedAccountServiceEndpoint: () => accountServiceState.endpoint,
    subscribeAccountServiceEndpoint: () => () => {},
}));

// The account service this Home points at, as the A1 popover reads it (policy + discovery are network).
const homeServiceState = vi.hoisted(() => ({
    status: 'ready' as 'ready' | 'not_offered',
    policyReady: true,
    healthKind: 'healthy' as string,
}));
// The reachability owner's verdict on this Home (socket + endpoint health), as the popover reads it.
vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useActiveHomeConnectionHealth: () => ({ kind: homeServiceState.healthKind }),
}));
vi.mock('@/components/account/auth/useHomeAccountServiceEntry', () => ({
    useHomeAccountServiceEntry: () => ({
        entry: {
            status: homeServiceState.status,
            effectiveSignInService: { kind: 'service' },
            endpoint: { url: 'https://accounts.acme.test', serverIdentityId: 'srv-acme', displayName: 'Acme Accounts' },
            discovery: { endpointUrl: 'https://accounts.acme.test', serverIdentityId: 'srv-acme' },
            transport: {},
            retry: () => {},
        },
        namedService: 'Acme Accounts',
        policyReady: homeServiceState.policyReady,
        policyFailed: false,
    }),
}));

vi.mock('@/auth/accountDirectory/accountDirectoryCredentialStorage', () => ({
    accountDirectoryCredentialStorage: {
        get: async () => accountServiceState.storedCredential,
    },
    subscribeAccountDirectoryCredentialMutations: (listener: () => void) => {
        accountServiceState.mutationListeners.add(listener);
        return () => { accountServiceState.mutationListeners.delete(listener); };
    },
}));

describe('SettingsView profile header', () => {
    // Load the module graph once, outside any single test's time budget.
    beforeAll(async () => {
        await import('./SettingsView');
    }, 180_000);

    beforeEach(() => {
        profileState.value = { ...profileDefaults, id: 'prof_1', firstName: 'Lee' };
    });

    it('renders when the profile has a display name', async () => {
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);

        expect(screen.findAllByType('Avatar')).toHaveLength(1);
        expect(screen.findAllByType('Text').some((node) => node.props.children === 'Lee')).toBe(true);
    });

    it.each([
        { username: 'lee', expectedName: 'lee' },
        { lastName: 'Lee', expectedName: 'Lee' },
        {
            linkedProviders: [{ id: 'github', login: 'lee-code', displayName: 'Lee Code', avatarUrl: 'https://example.test/lee.png', profileUrl: null, showOnProfile: true }],
            expectedName: 'Lee Code',
        },
    ])('shows the resolved profile identity without a first name: $expectedName', async ({ expectedName, ...profile }) => {
        profileState.value = { ...profileDefaults, id: 'prof_1', ...profile };
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);

        expect(screen.findAllByType('Avatar')).toHaveLength(1);
        expect(screen.findAllByType('Text').some((node) => node.props.children === expectedName)).toBe(true);
    });

    it('leads to the Account, and leaves the machine count to the Machines section', async () => {
        machinesState.value = [{ id: 'm1' }, { id: 'm2' }];
        const push = vi.fn();
        routerPush.spy = push;
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);

        expect(screen.findByTestId('settings-overview-machines')).toBeNull();
        screen.pressByTestId('settings-overview-account');
        expect(push).toHaveBeenCalledWith('/settings/account');
        machinesState.value = [];
    });

    it('composes the lighter hub on a wide window: each machine as its own row, not summary rows', async () => {
        machinesState.value = [{ id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox', displayName: 'devbox' } }];
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);

        expect(screen.findByTestId('hub-machines.m1')).toBeTruthy();
        expect(screen.findByTestId('hub-summary.machines')).toBeNull();
        machinesState.value = [];
    });

    it('names an Account without a name "Your account", with its avatar, on a phone too', async () => {
        profileState.value = { ...profileDefaults, id: 'prof_1' };
        const [{ SettingsView }, { NavigationTitleChromeProvider }] = await Promise.all([
            import('./SettingsView'),
            import('@/components/ui/layout/PageHeader'),
        ]);
        const phone = await renderSettingsView(
            <NavigationTitleChromeProvider showsTitle><InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider></NavigationTitleChromeProvider>,
        );

        expect(phone.findAllByType('Avatar')).toHaveLength(1);
        expect(phone.findAllByType('Text').some((node) => node.props.children === 'accountDisplay.yours')).toBe(true);
        expect(phone.findByTestId('settings-overview-account')).toBeTruthy();
    });

    it('says where the person stands with the Home\'s account service, as the account popover does', async () => {
        accountServiceState.storedCredential = { token: 't' };
        const { SettingsView } = await import('./SettingsView');
        const signedIn = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);
        // The stored sign-in is read asynchronously from secure storage.
        await vi.waitFor(() => expect(signedIn.getTextContent()).toContain('settingsOverview.accountServiceSignedIn'));

        accountServiceState.storedCredential = null;
        const signedOut = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(signedOut.getTextContent()).toContain('accountPopover.notLinkedTo'));
        expect(signedOut.getTextContent()).not.toContain('settingsOverview.accountServiceSignedIn');
    });

    it('follows a sign-out while mounted, and re-reads the sign-in on focus', async () => {
        accountServiceState.storedCredential = { token: 't' };
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('settingsOverview.accountServiceSignedIn'));

        // Signed out from the Account page while the Settings home stayed mounted beneath it.
        accountServiceState.storedCredential = null;
        await act(async () => { for (const listener of accountServiceState.mutationListeners) listener(); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('accountPopover.notLinkedTo'));

        // Signed in elsewhere (no write this device observed): coming back to the page re-reads.
        accountServiceState.storedCredential = { token: 't2' };
        await act(async () => { for (const callback of focusState.callbacks) callback(); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('settingsOverview.accountServiceSignedIn'));
    });
    it('says sign-in status is unavailable, as the popover does, while the Home does not answer', async () => {
        homeServiceState.status = 'not_offered';
        homeServiceState.policyReady = false;
        homeServiceState.healthKind = 'server_unreachable';
        try {
            const { SettingsView } = await import('./SettingsView');
            const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('accountPopover.signInStatusUnavailable'));
        } finally {
            homeServiceState.status = 'ready';
            homeServiceState.policyReady = true;
            homeServiceState.healthKind = 'healthy';
        }
    });
});
