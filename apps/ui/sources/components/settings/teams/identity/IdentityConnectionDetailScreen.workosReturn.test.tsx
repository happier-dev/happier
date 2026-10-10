import * as React from 'react';
import type { TeamIdentityConnectionV1 } from '@happier-dev/protocol/teams';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

/**
 * WorkOS Admin Portal return (teams-lane-03/06 §7.4(6), teams-lane-03/03 §8.2(3)).
 *
 * The real screen and its real exact-Team projection owner (`useIdentityAdministration`)
 * run here. Only genuine boundaries are replaced: the Home Action transport, the
 * OS app-state/external-browser hooks, navigation focus, and the Team route shell.
 */
const executeMock = vi.hoisted(() => vi.fn());
const appStateChangeMock = vi.hoisted(() => ({ current: null as null | ((state: string) => void) }));
// Screen focus is the React Navigation boundary the destination focus owner
// reads; a route regaining focus is focus going false then true again.
const screenFocusMock = vi.hoisted(() => ({
    focused: true,
    listeners: new Set<() => void>(),
    set(focused: boolean) {
        this.focused = focused;
        for (const listener of this.listeners) listener();
    },
}));
const openExternalUrlMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        // A rendered screen: the destination owner asks this screen whether it is focused.
        NavigationContext: ReactModule.createContext<Readonly<Record<string, unknown>> | undefined>({}),
        useIsFocused: () => ReactModule.useSyncExternalStore(
            (listener) => {
                screenFocusMock.listeners.add(listener);
                return () => screenFocusMock.listeners.delete(listener);
            },
            () => screenFocusMock.focused,
        ),
    };
});
vi.mock('react-native', async (importOriginal) => {
    const original = await importOriginal<typeof import('react-native')>();
    return {
        ...original,
        AppState: {
            ...original.AppState,
            addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
                appStateChangeMock.current = listener;
                return { remove: vi.fn() };
            }),
        },
    };
});
// Rows render their right-hand control, as the real row does; page fields are text inputs.
vi.mock('@/components/ui/lists/Item', async () => {
    const React = await import('react');
    return { Item: (props: { rightElement?: unknown }) => React.createElement('Item', props, props.rightElement as never) };
});
vi.mock('@/components/ui/forms/FieldTextInput', () => ({ FieldTextInput: 'TextInput' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
// The administrator confirms opening the portal (the shared modal boundary).
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { confirm: vi.fn(async () => true) },
    }).module;
});
// Only the Home transport is replaced; the real read/abort wrapper the projection hook uses stays.
vi.mock('./identityAdministrationClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('./identityAdministrationClient')>(),
    createIdentityAdministrationClient: () => ({
        execute: executeMock,
        executeExternalGroupBinding: vi.fn(async () => ({ ok: true, value: { items: [], nextCursor: null } })),
    }),
}));
vi.mock('@/components/settings/home/identity/useManagedIdentityProviders', () => ({
    useManagedIdentityProviders: () => ({
        state: { kind: 'ready', refreshing: false, stale: false, failure: null, items: [], unreadableCount: 0 },
        refresh: vi.fn(),
    }),
}));
vi.mock('@/hooks/teams/useTeamGroups', () => ({
    useTeamGroups: () => ({ rows: [], status: 'ready', hasMore: false, error: null, reload: vi.fn(), loadMore: vi.fn() }),
}));
vi.mock('../TeamSection', () => ({
    TeamSection: (props: Readonly<{ children: (context: unknown) => React.ReactNode }>) => props.children({
        team: { id: 'team-1', capabilities: { manageAuthentication: true } },
        scope: { serverId: 'home-1', accountId: 'account-1' },
        canMutate: true,
        requestApproval: vi.fn(),
    }),
}));

import { IdentityConnectionDetailScreen } from './IdentityConnectionDetailScreen';

function workosConnection(
    overrides: Partial<TeamIdentityConnectionV1> = {},
): TeamIdentityConnectionV1 {
    return {
        v: 1,
        id: 'connection-1',
        teamId: 'team-1',
        provider: { id: 'provider-workos', kind: 'workos_sso', displayName: 'Acme SSO' },
        externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_1', connectionId: null },
        settings: { v: 1, kind: 'workos_sso' },
        enabled: false,
        firstEnabledAt: null,
        revision: 2,
        state: 'setting_up',
        allowedActions: ['teams.identity.workos.adminPortalLink.create', 'teams.identity.workos.reconcile'],
        lastObservation: { v: 1, kind: 'workos_sso', presentation: null },
        lastSuccessfulTest: null,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    } as TeamIdentityConnectionV1;
}

function serveHome(connections: () => readonly TeamIdentityConnectionV1[]) {
    executeMock.mockImplementation(async (actionId: string) => {
        if (actionId === 'teams.identity.connections.list') {
            return {
                ok: true,
                value: {
                    items: connections(),
                    eligibleProviders: [],
                    admissionModeApplicability: [],
                    memberSignInUrl: null,
                },
            };
        }
        if (actionId === 'teams.identity.workos.reconcile') {
            return { ok: true, value: { outcome: 'connected', connection: connections()[0] } };
        }
        if (actionId === 'teams.identity.workos.adminPortalLink.create') {
            return { ok: true, value: { url: 'https://setup.workos.test/portal' } };
        }
        throw new Error(`unexpected action ${actionId}`);
    });
}

function reconcileCalls() {
    return executeMock.mock.calls.filter(([actionId]) => actionId === 'teams.identity.workos.reconcile');
}

beforeEach(() => {
    standardCleanup();
    executeMock.mockReset();
    openExternalUrlMock.mockReset();
    openExternalUrlMock.mockResolvedValue(true);
    appStateChangeMock.current = null;
    screenFocusMock.focused = true;
    screenFocusMock.listeners.clear();
});

describe('IdentityConnectionDetailScreen WorkOS portal return', () => {
    it('checks setup when the portal returns a fresh document to the connection route', async () => {
        // The portal's return URL is this exact route. A new tab has no in-memory
        // "awaiting return" intent, so route focus itself must refresh and reconcile.
        serveHome(() => [workosConnection()]);

        await renderScreen(<IdentityConnectionDetailScreen serverId="home-1" teamId="team-1" connectionId="connection-1" />);

        await vi.waitFor(() => expect(reconcileCalls()).toHaveLength(1));
        expect(reconcileCalls()[0]![1]).toEqual({
            v: 1, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 2,
        });
    });

    it('checks setup again when the route regains focus with a freshly refreshed projection', async () => {
        let current = workosConnection({ allowedActions: ['teams.identity.workos.adminPortalLink.create'] });
        serveHome(() => [current]);

        await renderScreen(<IdentityConnectionDetailScreen serverId="home-1" teamId="team-1" connectionId="connection-1" />);
        await vi.waitFor(() => expect(executeMock).toHaveBeenCalledWith(
            'teams.identity.connections.list', expect.anything(), expect.anything(),
        ));
        // The first projection did not yet allow reconcile; that snapshot must not decide later focus.
        expect(reconcileCalls()).toHaveLength(0);

        current = workosConnection({ revision: 3 });
        await act(async () => {
            screenFocusMock.set(false);
        });
        await act(async () => {
            screenFocusMock.set(true);
        });

        await vi.waitFor(() => expect(reconcileCalls()).toHaveLength(1));
        expect(reconcileCalls()[0]![1]).toMatchObject({ expectedRevision: 3 });
    });

    it('does not re-check a connected WorkOS connection on ordinary route focus', async () => {
        serveHome(() => [workosConnection({
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_1', connectionId: 'conn_1' },
            enabled: true,
            firstEnabledAt: 1,
            state: 'connected',
        })]);

        await renderScreen(<IdentityConnectionDetailScreen serverId="home-1" teamId="team-1" connectionId="connection-1" />);
        await vi.waitFor(() => expect(executeMock).toHaveBeenCalledWith(
            'teams.identity.connections.list', expect.anything(), expect.anything(),
        ));
        await act(async () => {
            screenFocusMock.set(false);
        });
        await act(async () => {
            screenFocusMock.set(true);
        });

        await vi.waitFor(() => expect(
            executeMock.mock.calls.filter(([actionId]) => actionId === 'teams.identity.connections.list'),
        ).toHaveLength(2));
        expect(reconcileCalls()).toHaveLength(0);
    });

    it('reconciles in the original tab after the portal opens and the app returns to the foreground', async () => {
        serveHome(() => [workosConnection({ externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_1', connectionId: 'conn_1' }, state: 'needs_attention' })]);
        const screen = await renderScreen(<IdentityConnectionDetailScreen serverId="home-1" teamId="team-1" connectionId="connection-1" />);
        await vi.waitFor(() => expect(reconcileCalls()).toHaveLength(1));
        // The route-focus check and its projection refresh settle before the
        // administrator can open the portal; controls stay busy until then.
        await vi.waitFor(() => expect(screen.findByTestId('team-identity-workos-sso')?.props.disabled).toBe(false));

        await screen.pressByTestIdAsync('team-identity-workos-sso');
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://setup.workos.test/portal');
        await act(async () => appStateChangeMock.current?.('active'));

        await vi.waitFor(() => expect(reconcileCalls()).toHaveLength(2));
    });
});
