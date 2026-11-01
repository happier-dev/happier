import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

const tauriDesktopState = vi.hoisted(() => ({ value: true }));

// Substitute browser portal placement while keeping the Account menu and entries real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
const routerPush = vi.hoisted(() => ({ spy: null as null | ((route: unknown) => void) }));
const navigationState = vi.hoisted(() => ({
    focused: true,
    headerRight: null as null | (() => React.ReactNode),
}));
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
    storage: 'real',
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            navigation: {
                setOptions: (options: { headerRight?: () => React.ReactNode }) => {
                    if ('headerRight' in options) navigationState.headerRight = options.headerRight ?? null;
                },
            },
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
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useIsFocused: () => navigationState.focused,
    };
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));







vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: (props: Record<string, unknown>) => React.createElement('MachineCliGlyphs', props),
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

const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { Avatar } = await import('@/components/ui/avatar/Avatar');
await import('./SettingsView');
const { NavigationContext } = await import('@react-navigation/native');
// The canonical navigator boundary supplies a method bag instead of the native SDK's full route state.
const NavigationFixtureContext = NavigationContext as unknown as React.Context<Readonly<Record<string, unknown>>>;
function NavigationFixture({ children }: React.PropsWithChildren) {
    const focused = navigationState.focused;
    const fixtureNavigation = React.useMemo(() => ({ focused }), [focused]);
    return <NavigationFixtureContext.Provider value={fixtureNavigation}>{children}</NavigationFixtureContext.Provider>;
}

const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
beforeEach(() => {
    storage.setState({ settings: { ...settingsDefaults, useProfiles: false },
        profile: { ...profileDefaults, id: 'prof_1' }, machines: {},
        machineListByServerId: {}, machineListStatusByServerId: {} });
});

describe('SettingsView profile header', () => {
    beforeEach(() => {
        navigationState.focused = true;
        navigationState.headerRight = null;
        storage.setState({ profile: { ...profileDefaults, id: 'prof_1', name: 'Lee' } });
    });

    it.each([
        { username: 'lee', expectedName: 'lee' },
        { name: 'Lee', expectedName: 'Lee' },
        {
            linkedProviders: [{ id: 'github', login: 'lee-code', displayName: 'Lee Code', avatarUrl: 'https://example.test/lee.png', profileUrl: null, showOnProfile: true }],
            name: 'Lee Code',
            expectedName: 'Lee Code',
        },
    ])('shows the canonical Account name or username: $expectedName', async ({ expectedName, ...profile }) => {
        storage.setState({ profile: { ...profileDefaults, id: 'prof_1', ...profile } });
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);

        expect(screen.findAllByType(Avatar)).toHaveLength(1);
        expect(screen.getTextContent()).toContain(expectedName);
    });

    it('leads to the Account, and leaves the machine count to the Machines section', async () => {
        const machines = [createMachineFixture({ id: 'm1' }), createMachineFixture({ id: 'm2' })];
        storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])) });
        const push = vi.fn();
        routerPush.spy = push;
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);

        expect(screen.findByTestId('settings-overview-machines')).toBeNull();
        screen.pressByTestId('settings-overview-account');
        expect(push).toHaveBeenCalledWith('/settings/account');
        storage.setState({ machines: {} });
    });

    it('names an Account without a name "Your account", with its avatar, on a phone too', async () => {
        storage.setState({ profile: { ...profileDefaults, id: 'prof_1' } });
        const [{ SettingsView }, { NavigationTitleChromeProvider }] = await Promise.all([
            import('./SettingsView'),
            import('@/components/ui/layout/PageHeader'),
        ]);
        const phone = await renderSettingsView(
            <NavigationTitleChromeProvider showsTitle><InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider></NavigationTitleChromeProvider>,
        );

        expect(phone.findAllByType(Avatar)).toHaveLength(1);
        expect(phone.getTextContent()).toContain('accountDisplay.yours');
        expect(navigationState.headerRight).toEqual(expect.any(Function));
        const header = await renderSettingsView(<>{navigationState.headerRight?.()}</>);
        await header.pressByTestIdAsync('page-header-actions.trigger');
        await vi.waitFor(() => expect(header.findByTestId('settings-overview-account')).toBeTruthy());
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
        const screen = await renderSettingsView(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>, { wrapper: NavigationFixture });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('settingsOverview.accountServiceSignedIn'));

        // Signed out from the Account page while the Settings home stayed mounted beneath it.
        accountServiceState.storedCredential = null;
        await act(async () => { for (const listener of accountServiceState.mutationListeners) listener(); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('accountPopover.notLinkedTo'));

        // Signed in elsewhere (no write this device observed): coming back to the page re-reads.
        accountServiceState.storedCredential = { token: 't2' };
        navigationState.focused = false;
        await screen.update(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);
        navigationState.focused = true;
        await screen.update(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>);
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
