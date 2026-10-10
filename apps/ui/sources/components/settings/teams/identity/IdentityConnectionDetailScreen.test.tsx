import * as React from 'react';
import type { TeamIdentityConnectionV1 } from '@happier-dev/protocol/teams';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

const executeMock = vi.hoisted(() => vi.fn());
const executeBindingMock = vi.hoisted(() => vi.fn());
const announceMock = vi.hoisted(() => vi.fn());
const groupBindingRowsMock = vi.hoisted(() => ({
    current: [] as Array<Readonly<{
        id: string;
        externalGroupId: string;
        target: Readonly<{ teamGroupId: string; name: string; archivedAt: number | null }>;
    }>>,
}));
const nativeGroupsMock = vi.hoisted(() => ({
    current: [] as Array<Readonly<{ id: string; name: string; memberCount: number }>>,
    enabled: false,
    status: 'ready' as 'loading' | 'ready' | 'error',
    error: null as null | { kind: 'unreachable'; retryable: boolean; code: null },
    reload: vi.fn(),
}));
const refreshMock = vi.hoisted(() => vi.fn());
const routerReplaceMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());
const requestApprovalMock = vi.hoisted(() => vi.fn());
const canMutateMock = vi.hoisted(() => ({ current: true }));
const openExternalUrlMock = vi.hoisted(() => vi.fn());
const appStateChangeMock = vi.hoisted(() => ({ current: null as null | ((state: string) => void) }));
const managedProvidersStateMock = vi.hoisted(() => ({
    current: { kind: 'ready' as const, refreshing: false, stale: false, failure: null, items: [] as Array<{ id: string }>, unreadableCount: 0 },
}));
const identityStateMock = vi.hoisted(() => ({
    version: 0,
    listeners: new Set<() => void>(),
    current: {
        kind: 'ready' as const,
        refreshing: false,
        stale: false,
        failure: null,
        items: [{
            v: 1 as const,
            id: 'connection-1',
            teamId: 'team-1',
            provider: { id: 'provider-1', kind: 'oidc' as const, displayName: 'OIDC' },
            externalReference: { v: 1 as const, kind: 'oidc' as const },
            settings: { v: 1 as const, kind: 'oidc' as const, allowedUsers: [] as string[], allowedEmailDomains: [] as string[], groupsAny: [] as string[], groupsAll: [] as string[] },
            enabled: true,
            firstEnabledAt: 1,
            revision: 1,
            state: 'connected' as const,
            allowedActions: [] as string[],
            lastObservation: { v: 1 as const, kind: 'oidc' as const },
            lastSuccessfulTest: null,
            createdAt: 1,
            updatedAt: 1,
            // The canonical union, not the first fixture's literal kind: cases
            // below legitimately replace this row with a GitHub or WorkOS
            // connection, which a narrowed `'oidc'` literal type forbids.
        }] as TeamIdentityConnectionV1[],
    },
    publish() {
        this.version += 1;
        for (const listener of this.listeners) listener();
    },
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { replace: routerReplaceMock, push: routerPushMock } }).module;
});
// Navigation focus is the router runtime boundary; route-focus behavior itself is
// proven against the real projection owner in `.workosReturn.test.tsx`.
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useFocusEffect: (effect: () => void | (() => void)) => {
            ReactModule.useEffect(effect, [effect]);
        },
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
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { confirm: vi.fn(async () => true) },
    }).module;
});
vi.mock('@/components/settings/home/identity/useManagedIdentityProviders', () => ({
    useManagedIdentityProviders: () => ({
        state: managedProvidersStateMock.current,
        refresh: vi.fn(),
    }),
}));
vi.mock('./TeamAuthenticationSettingsScreen', () => ({ connectionStateLabel: (value: string) => value }));
vi.mock('./identityAdministrationClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('./identityAdministrationClient')>(),
    createIdentityAdministrationClient: () => ({
        execute: executeMock,
        executeExternalGroupBinding: executeBindingMock,
    }),
}));
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: announceMock,
}));
vi.mock('@/hooks/teams/useTeamGroups', () => ({
    useTeamGroups: (params: { enabled: boolean }) => ({
        enabled: (nativeGroupsMock.enabled = params.enabled),
        rows: nativeGroupsMock.current,
        status: nativeGroupsMock.status,
        isCurrent: nativeGroupsMock.status === 'ready' && nativeGroupsMock.error === null,
        hasMore: false,
        error: nativeGroupsMock.error,
        reload: nativeGroupsMock.reload,
        loadMore: vi.fn(),
    }),
}));
vi.mock('./useIdentityAdministration', async () => {
    const ReactModule = await import('react');
    return {
        useIdentityAdministration: () => {
            ReactModule.useSyncExternalStore(
                (listener) => {
                    identityStateMock.listeners.add(listener);
                    return () => identityStateMock.listeners.delete(listener);
                },
                () => identityStateMock.version,
            );
            return { state: identityStateMock.current, refresh: refreshMock };
        },
    };
});
vi.mock('../TeamSection', () => ({
    TeamSection: (props: Readonly<{ children: (context: unknown) => React.ReactNode }>) => props.children({
        team: { id: 'team-1', capabilities: { manageAuthentication: true } },
        scope: { serverId: 'home-1', accountId: 'account-1' },
        canMutate: canMutateMock.current,
        requestApproval: requestApprovalMock,
    }),
}));

import { IdentityConnectionDetailScreen } from './IdentityConnectionDetailScreen';

beforeEach(() => {
    standardCleanup();
    executeMock.mockReset();
    groupBindingRowsMock.current = [];
    nativeGroupsMock.current = [];
    nativeGroupsMock.enabled = false;
    nativeGroupsMock.status = 'ready';
    nativeGroupsMock.error = null;
    nativeGroupsMock.reload.mockReset();
    announceMock.mockReset();
    executeBindingMock.mockReset();
    executeBindingMock.mockImplementation(async (actionId: string) => actionId === 'teams.externalGroupBindings.list'
        ? { ok: true, value: { items: groupBindingRowsMock.current, nextCursor: null } }
        : { ok: true, value: { v: 1, outcome: 'removed' } });
    refreshMock.mockReset();
    routerReplaceMock.mockReset();
    routerPushMock.mockReset();
    requestApprovalMock.mockReset();
    managedProvidersStateMock.current.items = [];
    canMutateMock.current = true;
    openExternalUrlMock.mockReset();
    openExternalUrlMock.mockResolvedValue(true);
    appStateChangeMock.current = null;
    identityStateMock.current = {
        kind: 'ready',
        refreshing: false,
        stale: false,
        failure: null,
        items: [{
            v: 1 as const,
            id: 'connection-1',
            teamId: 'team-1',
            provider: { id: 'provider-1', kind: 'oidc' as const, displayName: 'OIDC' },
            externalReference: { v: 1 as const, kind: 'oidc' as const },
            settings: { v: 1 as const, kind: 'oidc' as const, allowedUsers: [] as string[], allowedEmailDomains: [] as string[], groupsAny: [] as string[], groupsAll: [] as string[] },
            enabled: true,
            firstEnabledAt: 1,
            revision: 1,
            state: 'connected' as const,
            allowedActions: [] as string[],
            lastObservation: { v: 1 as const, kind: 'oidc' as const },
            lastSuccessfulTest: null,
            createdAt: 1,
            updatedAt: 1,
            // The canonical union, not the first fixture's literal kind: cases
            // below legitimately replace this row with a GitHub or WorkOS
            // connection, which a narrowed `'oidc'` literal type forbids.
        }] as TeamIdentityConnectionV1[],
    };
});

describe('IdentityConnectionDetailScreen test return', () => {
    it('keeps a failed mapping read distinct from an empty mapping list', async () => {
        executeBindingMock.mockImplementation(async (actionId: string) => actionId === 'teams.externalGroupBindings.list'
            ? { ok: false, failure: { code: 'home_unreachable', retryable: true } }
            : { ok: true, value: { v: 1, outcome: 'removed' } });
        const screen = await renderScreen(<IdentityConnectionDetailScreen serverId="home-1" teamId="team-1" connectionId="connection-1" />);

        await vi.waitFor(() => expect(screen.findByTestId('identity-group-bindings-retry')).not.toBeNull());
        expect(screen.getTextContent()).not.toContain(t('identityAdministration.unmapped'));
    });
    it('loads native Groups only for the open mapping chooser and distinguishes loading, empty, and retryable failure', async () => {
        const screen = await renderScreen(<IdentityConnectionDetailScreen serverId="home-1" teamId="team-1" connectionId="connection-1" />);
        expect(nativeGroupsMock.enabled).toBe(false);

        nativeGroupsMock.status = 'loading';
        await screen.pressByTestIdAsync('identity-group-map-existing');
        expect(nativeGroupsMock.enabled).toBe(true);
        expect(screen.findByTestId('identity-group-native-loading')).not.toBeNull();

        nativeGroupsMock.status = 'ready';
        await act(async () => { identityStateMock.publish(); });
        expect(screen.findByTestId('identity-group-native-empty')).not.toBeNull();

        nativeGroupsMock.status = 'error';
        nativeGroupsMock.error = { kind: 'unreachable', retryable: true, code: null };
        await act(async () => { identityStateMock.publish(); });
        expect(screen.findByTestId('identity-group-native-error')).not.toBeNull();
        await screen.pressByTestIdAsync('identity-group-native-retry');
        expect(nativeGroupsMock.reload).toHaveBeenCalledOnce();
    });
    it('gives every Team identity restriction field its translated accessible name', async () => {
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        expect(screen.findByTestId('identity-settings-allowed-users')?.props.accessibilityLabel)
            .toBe(t('teams.authentication.detail.allowedUsers'));
        expect(screen.findByTestId('identity-settings-allowed-domains')?.props.accessibilityLabel)
            .toBe(t('teams.authentication.detail.allowedDomains'));
        expect(screen.findByTestId('identity-settings-groups-any')?.props.accessibilityLabel)
            .toBe(t('identityAdministration.groupsAny'));
        expect(screen.findByTestId('identity-settings-groups-all')?.props.accessibilityLabel)
            .toBe(t('identityAdministration.groupsAll'));

        identityStateMock.current.items[0] = {
            ...identityStateMock.current.items[0]!,
            provider: { id: 'provider-github', kind: 'github_app_identity', displayName: 'GitHub' },
            externalReference: { v: 1, kind: 'github_app_identity', installationId: 'installation-1' },
            settings: { v: 1, kind: 'github_app_identity', organizationLogin: 'example' },
            lastObservation: { v: 1, kind: 'github_app_identity' },
        };
        await act(async () => identityStateMock.publish());

        expect(screen.findByTestId('identity-settings-organization')?.props.accessibilityLabel)
            .toBe(t('teams.authentication.detail.organization'));
    });

    it('presents WorkOS provider, strategy, and status values without exposing raw wire enums', async () => {
        identityStateMock.current.items[0] = {
            ...identityStateMock.current.items[0]!,
            provider: { id: 'provider-workos', kind: 'workos_sso', displayName: 'Acme SSO' },
            externalReference: {
                v: 1,
                kind: 'workos_sso',
                organizationId: 'organization-1',
                connectionId: null,
            },
            settings: { v: 1, kind: 'workos_sso' },
            allowedActions: ['teams.identity.workos.reconcile'],
            lastObservation: {
                v: 1,
                kind: 'workos_sso',
                presentation: {
                    displayName: 'Ok',
                    strategy: 'SAML',
                    status: 'active',
                    lastCheckedAt: 1,
                },
            },
        };
        executeMock.mockResolvedValueOnce({
            ok: true,
            value: {
                outcome: 'selection_required',
                candidates: [
                    { connectionId: 'candidate-1', displayName: 'Primary', strategy: 'SAML', status: 'active' },
                    { connectionId: 'candidate-2', displayName: 'Backup', strategy: 'SAML', status: 'active' },
                ],
            },
        });
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        expect(screen.findByTestId('identity-connection-provider')).toBeNull();
        expect(screen.findByTestId('identity-connection-header')?.props.description)
            .toBe(t('identityAdministration.providerWorkosSso'));
        expect(screen.findByTestId('identity-workos-current-connection')?.props.subtitle)
            .toBe(`Ok · ${t('identityAdministration.workosStrategySaml')} · ${t('identityAdministration.active')}`);

        await screen.pressByTestIdAsync('team-identity-workos-reconcile');
        const candidate = screen.findByTestId('identity-workos-candidate:candidate-1');
        expect(candidate?.props.subtitle)
            .toBe(`${t('identityAdministration.workosStrategySaml')} · ${t('identityAdministration.active')}`);
        expect(screen.getTextContent()).not.toContain('SAML · active');
    });

    it('explains a blocked removal through each typed blocker and labels the sole-login count truthfully', async () => {
        identityStateMock.current.items[0] = {
            ...identityStateMock.current.items[0]!,
            allowedActions: ['teams.identity.connections.remove'],
        };
        executeMock.mockResolvedValueOnce({
            ok: true,
            value: {
                v: 1,
                canRemove: false,
                connection: identityStateMock.current.items[0],
                impact: { linkedAccounts: 3, accountsRequiringAlternateLogin: 2, directorySources: 1, externalGroupBindings: 0, managedMemberships: 0 },
                blockers: ['account_would_lose_login', 'directory_source_in_use'],
            },
        });
        const { Modal } = await import('@/modal');
        const { identityAdministrationFailureMessage, identityAdministrationFailureRecoveryLabel } = await import('@/components/settings/identity/identityAdministrationFailure');
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        await screen.pressByTestIdAsync('team-identity-remove');

        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(Modal.alertAsync).toHaveBeenCalledTimes(1);
        const body = String(vi.mocked(Modal.alertAsync).mock.calls[0]?.[1]);
        // Each blocker leads with its own count when the preview carries one,
        // then names where it is resolved; zero counts never appear.
        expect(body).toContain(t('identityAdministration.removeBlockedAlternateLogins', { count: 2 }));
        expect(body).toContain(identityAdministrationFailureRecoveryLabel('alternate_login'));
        expect(body).toContain(t('identityAdministration.removeBlockedDirectories', { count: 1 }));
        expect(body).toContain(identityAdministrationFailureRecoveryLabel('directory'));
        expect(body).not.toContain(t('identityAdministration.removeBlockedGroups', { count: 0 }));
        expect(body).not.toContain(identityAdministrationFailureMessage('account_would_lose_login'));
        expect(body).not.toContain(t('identityAdministration.needsTest'));
    });

    it('does not consume or refresh when the callback has no result handle', async () => {
        renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
            testReturn={{ purpose: 'identity_connection_test', resultHandle: null, error: null }}
        />);

        await vi.waitFor(() => expect(routerReplaceMock).toHaveBeenCalledOnce());
        expect(executeMock).not.toHaveBeenCalled();
        expect(refreshMock).not.toHaveBeenCalled();
    });

    it('shows the sanitized diagnostics the consumed result carried', async () => {
        executeMock.mockResolvedValue({
            ok: true,
            value: {
                connection: { id: 'connection-1' },
                diagnostics: {
                    subjectPresent: true,
                    loginAvailable: true,
                    emailAvailable: true,
                    emailVerified: false,
                    groups: { state: 'complete', count: 2 },
                    eligibility: { status: 'ineligible', rules: [{ kind: 'email_domains', matched: false }] },
                    mappedGroups: [{ id: 'group-1', name: 'Engineering' }],
                },
            },
        });
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
            testReturn={{ purpose: 'identity_connection_test', resultHandle: 'result-1', error: null }}
        />);

        await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(
            screen.findByTestId('identity-test-diagnostics:mappedGroups'),
        ).not.toBeNull());
        expect(screen.findByTestId('identity-test-diagnostics:mappedGroups')?.props.detail)
            .toBe('Engineering');
        expect(screen.findByTestId('identity-test-diagnostics:rule:email_domains')).not.toBeNull();
    });

    it('applies returned diagnostics after approval settles without replaying the consume mutation', async () => {
        let complete: ((value: Readonly<{
            connection: Readonly<{ id: string }>;
            diagnostics: Readonly<{
                subjectPresent: boolean;
                loginAvailable: boolean;
                emailAvailable: boolean;
                emailVerified: boolean | null;
                groups: Readonly<{ state: 'complete'; count: number }>;
                eligibility: Readonly<{ status: 'eligible'; rules: readonly [] }>;
                mappedGroups: readonly [];
            }>;
        }>) => void | Promise<void>) | undefined;
        executeMock.mockImplementationOnce(async (
            _actionId: string,
            _input: unknown,
            options?: Readonly<{ onApprovalSucceeded?: typeof complete; onApprovalFailed?: (code: string) => void }>,
        ) => {
            complete = options?.onApprovalSucceeded;
            expect(options?.onApprovalFailed).toBeTypeOf('function');
            return {
                ok: false,
                approvalPending: true,
                artifactId: 'approval-consume-1',
                failure: { code: 'approval_pending', retryable: false },
            };
        });
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
            testReturn={{ purpose: 'identity_connection_test', resultHandle: 'result-1', error: null }}
        />);

        await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
        expect(refreshMock).not.toHaveBeenCalled();

        await act(async () => {
            await complete?.({
                connection: { id: 'connection-1' },
                diagnostics: {
                    subjectPresent: true,
                    loginAvailable: true,
                    emailAvailable: true,
                    emailVerified: true,
                    groups: { state: 'complete', count: 0 },
                    eligibility: { status: 'eligible', rules: [] },
                    mappedGroups: [],
                },
            });
        });

        expect(refreshMock).toHaveBeenCalledOnce();
        expect(screen.findByTestId('identity-test-diagnostics:subject')).not.toBeNull();
        expect(executeMock).toHaveBeenCalledOnce();
    });

    it('does not publish a refresh when the Home refuses the result', async () => {
        executeMock.mockResolvedValue({
            ok: false,
            failure: { code: 'team_forbidden', retryable: false },
        });
        renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
            testReturn={{ purpose: 'identity_connection_test', resultHandle: 'result-1', error: null }}
        />);

        await vi.waitFor(() => expect(executeMock).toHaveBeenCalledOnce());
        expect(refreshMock).not.toHaveBeenCalled();
        expect(routerReplaceMock).toHaveBeenCalledOnce();
    });

    it('shows a busy return state and blocks mutations while a test result is being consumed', async () => {
        identityStateMock.current.items[0]!.allowedActions = [
            'teams.identity.connections.test.start',
            'teams.identity.connections.disable',
        ];
        const deferred = createDeferred<Readonly<{
            ok: true;
            value: Readonly<{ connection: Readonly<{ id: string }>; diagnostics: null }>;
        }>>();
        executeMock.mockReturnValueOnce(deferred.promise);

        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
            testReturn={{ purpose: 'identity_connection_test', resultHandle: 'result-1', error: null }}
        />);

        await vi.waitFor(() => expect(executeMock).toHaveBeenCalledOnce());
        expect(screen.findByTestId('identity-connection-test-status')).toMatchObject({
            props: { loading: true },
        });
        expect(screen.findByTestId('team-identity-test')?.props.disabled).toBe(true);
        expect(screen.findByTestId('team-identity-disable')?.props.disabled).toBe(true);

        await act(async () => {
            deferred.resolve({ ok: true, value: { connection: { id: 'connection-1' }, diagnostics: null } });
        });
        await vi.waitFor(() => expect(routerReplaceMock).toHaveBeenCalledOnce());
    });

    it('opens the exact Team test URL when an approved Action settles, using the same completion as immediate success', async () => {
        identityStateMock.current.items[0]!.allowedActions = ['teams.identity.connections.test.start'];
        let complete: ((value: Readonly<{ authorizeUrl: string; attemptId: string }>) => void | Promise<void>) | undefined;
        executeMock.mockImplementationOnce(async (
            _actionId: string,
            _input: unknown,
            options?: Readonly<{ onApprovalSucceeded?: typeof complete }>,
        ) => {
            complete = options?.onApprovalSucceeded;
            return {
                ok: false,
                approvalPending: true,
                artifactId: 'approval-test-1',
                failure: { code: 'approval_pending', retryable: false },
            };
        });
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        await screen.pressByTestIdAsync('team-identity-test');
        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(complete).toBeTypeOf('function');

        await act(async () => {
            await complete?.({ authorizeUrl: 'https://id.example/approved', attemptId: 'attempt-1' });
        });
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://id.example/approved');
    });

    it('opens and marks the WorkOS portal when approval settles instead of losing the result URL', async () => {
        identityStateMock.current.items[0] = {
            ...identityStateMock.current.items[0]!,
            provider: { id: 'provider-1', kind: 'workos_sso', displayName: 'WorkOS' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: null, connectionId: null },
            settings: { v: 1, kind: 'workos_sso' },
            lastObservation: null,
            enabled: false,
            firstEnabledAt: null,
            state: 'setting_up',
            allowedActions: ['teams.identity.workos.adminPortalLink.create'],
        };
        let complete: ((value: Readonly<{ url: string }>) => void | Promise<void>) | undefined;
        executeMock.mockImplementationOnce(async (
            _actionId: string,
            _input: unknown,
            options?: Readonly<{ onApprovalSucceeded?: typeof complete }>,
        ) => {
            complete = options?.onApprovalSucceeded;
            return {
                ok: false,
                approvalPending: true,
                artifactId: 'approval-portal-1',
                failure: { code: 'approval_pending', retryable: false },
            };
        });
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        await screen.pressByTestIdAsync('team-identity-workos-sso');
        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(complete).toBeTypeOf('function');

        await act(async () => {
            await complete?.({ url: 'https://workos.example/approved' });
        });
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://workos.example/approved');

        await act(async () => appStateChangeMock.current?.('active'));
        expect(refreshMock).toHaveBeenCalled();
    });

    it('hands Directory Sync setup to the directory journey instead of opening a second portal return flow', async () => {
        identityStateMock.current.items[0] = {
            ...identityStateMock.current.items[0]!,
            provider: { id: 'provider-1', kind: 'workos_sso', displayName: 'WorkOS' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'organization-1', connectionId: 'workos-connection-a' },
            settings: { v: 1, kind: 'workos_sso' },
            lastObservation: null,
            allowedActions: ['teams.identity.workos.adminPortalLink.create'],
        };
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        await screen.pressByTestIdAsync('team-identity-workos-directory');

        expect(routerPushMock).toHaveBeenCalledWith(
            '/settings/teams/home-1/team-1/authentication/directory',
        );
        expect(executeMock).not.toHaveBeenCalled();
        expect(openExternalUrlMock).not.toHaveBeenCalled();
    });

    it('requires reloading and reapplying a preserved draft before saving against a refreshed revision', async () => {
        identityStateMock.current.items[0]!.allowedActions = ['teams.identity.connections.settings.update'];
        executeMock.mockResolvedValue({ ok: false, failure: { code: 'identity_connection_conflict' } });
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);
        await act(async () => {
            screen.changeTextByTestId('identity-settings-allowed-users', 'alice@example.com');
        });

        await act(async () => {
            identityStateMock.current.items[0] = { ...identityStateMock.current.items[0]!, revision: 2 };
            identityStateMock.publish();
        });
        expect(screen.findByTestId('identity-settings-save')?.props.disabled).toBe(true);
        expect(executeMock).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('identity-settings-reload-conflict');
        expect(screen.findByTestId('identity-settings-allowed-users')?.props.value).toBe('');
        expect(screen.findByTestId('identity-settings-save')?.props.disabled).toBe(true);
        await act(async () => {
            screen.changeTextByTestId('identity-settings-allowed-users', 'alice@example.com');
        });
        await screen.pressByTestIdAsync('identity-settings-save');

        expect(executeMock).toHaveBeenCalledWith('teams.identity.connections.settings.update', expect.objectContaining({
            expectedRevision: 2,
            settings: expect.objectContaining({
                kind: 'oidc',
                allowedUsers: ['alice@example.com'],
            }),
        }), expect.any(Object));
    });

    it('refreshes a server CAS conflict and waits for the newer connection revision before retry', async () => {
        identityStateMock.current.items[0]!.allowedActions = ['teams.identity.connections.settings.update'];
        executeMock.mockResolvedValueOnce({ ok: false, failure: { code: 'identity_connection_conflict' } });
        const renderElement = () => <IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />;
        const screen = await renderScreen(renderElement());
        await act(async () => {
            screen.changeTextByTestId('identity-settings-allowed-users', 'alice@example.com');
        });

        await screen.pressByTestIdAsync('identity-settings-save');

        expect(refreshMock).toHaveBeenCalledOnce();
        expect(screen.findByTestId('identity-settings-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('identity-settings-reload-conflict')).toBeNull();
        await screen.pressByTestIdAsync('identity-settings-refresh-conflict');
        expect(refreshMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            identityStateMock.current.items[0] = { ...identityStateMock.current.items[0]!, revision: 2 };
            identityStateMock.publish();
        });
        expect(screen.findByTestId('identity-settings-reload-conflict')).not.toBeNull();
        expect(screen.findByTestId('identity-settings-refresh-conflict')).toBeNull();

        executeMock.mockResolvedValueOnce({ ok: true, value: {} });
        await screen.pressByTestIdAsync('identity-settings-reload-conflict');
        expect(screen.findByTestId('identity-settings-allowed-users')?.props.value).toBe('');
        await act(async () => {
            screen.changeTextByTestId('identity-settings-allowed-users', 'alice@example.com');
        });
        await screen.pressByTestIdAsync('identity-settings-save');

        expect(executeMock).toHaveBeenLastCalledWith('teams.identity.connections.settings.update', expect.objectContaining({
            expectedRevision: 2,
            settings: expect.objectContaining({ allowedUsers: ['alice@example.com'] }),
        }), expect.any(Object));
    });

    it('refreshes the authoritative projection when a lifecycle CAS loses', async () => {
        identityStateMock.current.items[0]!.allowedActions = ['teams.identity.connections.disable'];
        executeMock.mockResolvedValueOnce({ ok: false, failure: { code: 'identity_connection_conflict' } });
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        await screen.pressByTestIdAsync('team-identity-disable');

        expect(refreshMock).toHaveBeenCalledOnce();
        expect(screen.findByTestId('identity-connection-failure')).not.toBeNull();
    });

    it('disables every connection mutation when the Team is read-only', async () => {
        canMutateMock.current = false;
        identityStateMock.current.items[0] = {
            ...identityStateMock.current.items[0]!,
            allowedActions: [
                'teams.identity.connections.settings.update',
                'teams.identity.connections.test.start',
                'teams.identity.connections.enable',
                'teams.identity.workos.adminPortalLink.create',
                'teams.identity.workos.reconcile',
                'teams.identity.connections.remove',
            ],
        };
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        expect(screen.findByTestId('identity-settings-allowed-users')?.props.editable).toBe(false);
        expect(screen.findByTestId('identity-external-group-id')?.props.editable).toBe(false);
        for (const testID of [
            'identity-settings-save',
            'identity-group-map-create',
            'identity-group-map-existing',
            'team-identity-test',
            'team-identity-enable',
            'team-identity-remove',
        ]) {
            expect(screen.findByTestId(testID)?.props.disabled).toBe(true);
        }
    });

    it('disables the WorkOS setup step and connection controls when the Team is read-only', async () => {
        canMutateMock.current = false;
        identityStateMock.current.items[0] = {
            ...identityStateMock.current.items[0]!,
            provider: { id: 'provider-1', kind: 'workos_sso', displayName: 'WorkOS' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: null, connectionId: null },
            settings: { v: 1, kind: 'workos_sso' },
            lastObservation: null,
            enabled: false,
            firstEnabledAt: null,
            state: 'setting_up',
            allowedActions: ['teams.identity.workos.adminPortalLink.create', 'teams.identity.connections.remove'],
        };
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        for (const testID of ['team-identity-workos-sso', 'team-identity-workos-directory', 'team-identity-remove']) {
            expect(screen.findByTestId(testID)?.props.disabled).toBe(true);
        }
    });

    it('blocks stale allowed actions while the authoritative connection projection refreshes', async () => {
        identityStateMock.current.refreshing = true;
        identityStateMock.current.items[0]!.allowedActions = [
            'teams.identity.connections.settings.update',
            'teams.identity.connections.test.start',
            'teams.identity.connections.disable',
        ];
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        expect(screen.findByTestId('identity-settings-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('team-identity-test')?.props.disabled).toBe(true);
        expect(screen.findByTestId('team-identity-disable')?.props.disabled).toBe(true);
    });

    it('opens the shared editor for the Team-owned provider attached to this connection', async () => {
        managedProvidersStateMock.current.items = [{ id: 'provider-1' }];
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        await screen.pressByTestIdAsync('team-identity-provider-edit');

        expect(routerPushMock).toHaveBeenCalledWith(
            '/settings/teams/home-1/team-1/authentication/connection-1/edit?providerId=provider-1',
        );
    });

    it('puts the only setup action on the current WorkOS step and keeps later steps inert', async () => {
        identityStateMock.current.items[0] = {
            ...identityStateMock.current.items[0]!,
            provider: { id: 'provider-1', kind: 'workos_sso', displayName: 'WorkOS' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'organization-1', connectionId: null },
            settings: { v: 1, kind: 'workos_sso' },
            lastObservation: null,
            enabled: false,
            firstEnabledAt: null,
            state: 'connected',
            allowedActions: [
                'teams.identity.workos.reconcile',
                'teams.identity.workos.adminPortalLink.create',
                'teams.identity.connections.test.start',
                'teams.identity.connections.enable',
            ],
        };
        executeMock.mockResolvedValue({ ok: true, value: { v: 1, outcome: 'selection_required', candidates: [] } });
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        // Step 1 is done: the portal stays reachable as a quiet reopen, not as the next step.
        expect(screen.findByTestId('team-identity-workos-sso')).not.toBeNull();
        // Steps 3 and 4 are upcoming: neither offers its action yet.
        expect(screen.findByTestId('team-identity-test')).toBeNull();
        expect(screen.findByTestId('team-identity-enable')).toBeNull();

        executeMock.mockClear();
        await screen.pressByTestIdAsync('team-identity-workos-reconcile');
        expect(executeMock).toHaveBeenCalledWith('teams.identity.workos.reconcile', expect.objectContaining({ connectionId: 'connection-1' }), expect.any(Object));
    });

    it('chooses a WorkOS connection through one named primary action, never through a draft candidate', async () => {
        // Choosing a candidate permanently fixes the provider namespace for
        // every future identity under this binding, so the commit is the
        // explicit "Use <name>" action, not a tap on a row.
        identityStateMock.current.items[0] = {
            ...identityStateMock.current.items[0]!,
            provider: { id: 'provider-1', kind: 'workos_sso', displayName: 'WorkOS' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'organization-1', connectionId: null },
            settings: { v: 1, kind: 'workos_sso' },
            lastObservation: null,
            enabled: false,
            firstEnabledAt: null,
            allowedActions: ['teams.identity.workos.reconcile'],
        };
        executeMock.mockResolvedValue({
            ok: true,
            value: {
                v: 1,
                outcome: 'selection_required',
                candidates: [
                    { connectionId: 'workos-connection-a', displayName: 'Acme SAML', strategy: 'saml', status: 'active' },
                    { connectionId: 'workos-connection-b', displayName: 'Acme OIDC', strategy: 'oidc', status: 'draft' },
                ],
            },
        });
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        await screen.pressByTestIdAsync('team-identity-workos-reconcile');

        expect(announceMock).toHaveBeenCalledWith(t('identityAdministration.workosChooseConnection'));
        const candidate = screen.findByTestId('identity-workos-candidate:workos-connection-a');
        expect(candidate?.props.accessibilityRole).toBe('radio');
        expect(candidate?.props.accessibilityChecked).toBe(false);
        expect(screen.findByTestId('identity-workos-candidate:workos-connection-b')?.props.disabled).toBe(true);
        // Nothing is committed until a candidate is chosen.
        expect(screen.findByTestId('team-identity-workos-use')?.props.disabled).toBe(true);

        executeMock.mockClear();
        executeMock.mockResolvedValue({ ok: true, value: { v: 1 } });
        await screen.pressByTestIdAsync('identity-workos-candidate:workos-connection-a');
        expect(executeMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('identity-workos-candidate:workos-connection-a')?.props.accessibilityChecked).toBe(true);

        await screen.pressByTestIdAsync('team-identity-workos-use');
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(executeMock).toHaveBeenCalledWith(
            'teams.identity.workos.connection.set',
            expect.objectContaining({ connectionId: 'connection-1', workosConnectionId: 'workos-connection-a' }),
            expect.any(Object),
        );
    });

    it('names the target Team Group and the people a Group mapping moves before asking to confirm', async () => {
        // The external Group id alone never said where those people were about
        // to land, or how many of them there are. Both facts are already on the
        // rows behind the confirmation.
        groupBindingRowsMock.current = [{
            id: 'binding-1',
            externalGroupId: 'external-engineering',
            target: { teamGroupId: 'team-group-opaque-id', name: 'Platform Engineering', archivedAt: null },
        }];
        nativeGroupsMock.current = [{ id: 'team-group-opaque-id', name: 'Platform Engineering', memberCount: 12 }];
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        // Declining keeps this test on the confirmation contract: what the
        // person is told before anything is written.
        vi.mocked(Modal.confirm).mockResolvedValue(false);
        const screen = await renderScreen(<IdentityConnectionDetailScreen
            serverId="home-1"
            teamId="team-1"
            connectionId="connection-1"
        />);

        await screen.pressByTestIdAsync('identity-group-binding:binding-1');

        expect(Modal.confirm).toHaveBeenCalledWith(
            t('identityAdministration.removeMapping'),
            ['external-engineering',
                `${t('identityAdministration.mappedTo')}: Platform Engineering`,
                t('teams.groups.memberCount', { count: 12 })].join('\n'),
            expect.objectContaining({ destructive: true }),
        );

        vi.mocked(Modal.confirm).mockClear();
        screen.changeTextByTestId('identity-external-group-id', 'external-design');
        await screen.pressByTestIdAsync('identity-group-map-existing');
        await screen.pressByTestIdAsync('identity-group-native-target:team-group-opaque-id');

        expect(Modal.confirm).toHaveBeenCalledWith(
            t('identityAdministration.chooseGroup'),
            ['external-design',
                `${t('identityAdministration.mappedTo')}: Platform Engineering`,
                t('teams.groups.memberCount', { count: 12 })].join('\n'),
            expect.any(Object),
        );
        expect(executeBindingMock).not.toHaveBeenCalledWith(
            'teams.externalGroupBindings.set',
            expect.anything(),
            expect.anything(),
        );
    });
});
