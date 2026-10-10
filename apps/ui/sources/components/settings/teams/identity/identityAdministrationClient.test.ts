import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createElement } from 'react';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    DEFAULT_ACTIONS_SETTINGS_V1,
    HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1,
    TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1,
} from '@happier-dev/protocol';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { useManagedIdentityProviders } from '@/components/settings/home/identity/useManagedIdentityProviders';
import { useManagedGitHubApps } from '@/components/settings/home/githubApps/useManagedGitHubApps';
import { useIdentityAdministration } from './useIdentityAdministration';
import { useDirectoryAdministration, useDirectorySourceAdministration } from './useDirectoryAdministration';

const serverFetchMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());

// Navigation and native presentation are host boundaries; the identity client,
// projection hook, shared detail and WorkOS step owner all remain real.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { replace: routerReplace } }).module;
});
vi.mock('@react-navigation/native', async () => {
    const React = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock(), NavigationContext: React.createContext({}) };
});

vi.mock('@/sync/http/client', async () => {
    const { createArtifactStoreBoundary } = await import('@/dev/testkit/harness/artifactStoreBoundary');
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-1', encryptionMode: 'plain' });
    return {
        serverFetch: serverFetchMock,
        createServerFetchAtEndpoint: () => async (path: string, init?: RequestInit) => {
            if (path.startsWith('/v1/account/encryption')) {
                return new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }), { status: 200 });
            }
            if (path.startsWith('/v2/account/settings')) {
                return new Response(JSON.stringify({ content: null, version: 0 }), { status: 200 });
            }
            if (path === '/v1/features') {
                return new Response(JSON.stringify({
                    features: {},
                    capabilities: {
                        accountStoredContentCompatibility: {
                            v: 1,
                            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                            declarationTransport: 'http-header-and-socket-auth-v1',
                        },
                    },
                }), { status: 200 });
            }
            const artifactResponse = artifacts.handle(path, init);
            if (artifactResponse) return artifactResponse;
            return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        },
    };
});
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchMock,
}));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: { getCredentialsForServerUrl: getCredentialsForServerUrlMock },
    });
});

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { createIdentityAdministrationClient } from './identityAdministrationClient';
import { IdentityConnectionDetailContent } from './IdentityConnectionDetailScreen';
import { IdentityWorkosSetupContent } from './IdentityWorkosSetupContent';
import { resetScopedHomeActionExecutorsForTests } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function connection(enabled: boolean) {
    return {
        v: 1,
        id: 'connection-1',
        teamId: 'team-1',
        provider: { id: 'provider-1', kind: 'oidc', displayName: 'Engineering OIDC' },
        externalReference: { v: 1, kind: 'oidc' },
        settings: { v: 1, kind: 'oidc', allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
        enabled,
        firstEnabledAt: enabled ? 1 : null,
        revision: enabled ? 1 : 2,
        state: enabled ? 'connected' : 'disabled',
        allowedActions: enabled
            ? ['teams.identity.connections.disable', 'teams.identity.connections.test.start', 'teams.identity.connections.remove']
            : ['teams.identity.connections.enable', 'teams.identity.connections.test.start', 'teams.identity.connections.remove'],
        lastObservation: { v: 1, kind: 'oidc' },
        lastSuccessfulTest: null,
        createdAt: 1,
        updatedAt: 2,
    } as const;
}

const admissionModeApplicability = {
    v: 1 as const,
    modes: {
        invite_only: { status: 'available' as const },
        provisioned: { status: 'unavailable' as const, reason: 'directory_source_required' as const },
        jit: { status: 'unavailable' as const, reason: 'team_connection_required' as const },
    },
};

function directorySource(id: string) {
    return {
        v: 1,
        id,
        teamId: 'team-1',
        kind: 'workos_directory',
        displayName: id,
        state: 'active',
        allowedActions: ['teams.directory.sources.sync', 'teams.directory.sources.remove'],
        sync: {
            mode: 'events_and_full',
            attempt: 'succeeded',
            freshness: 'fresh',
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastFullReconcileAt: null,
            nextScheduledAt: null,
        },
        error: null,
    } as const;
}

beforeEach(() => {
    runtimeFetchMock.mockReset();
    serverFetchMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
    routerReplace.mockReset();
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account-1') });
    resetScopedHomeActionExecutorsForTests();
});

afterEach(() => {
    standardCleanup();
    resetScopedHomeActionExecutorsForTests();
    vi.clearAllMocks();
});

describe('createIdentityAdministrationClient', () => {
    it('refreshes Home company connections on the Home governance wake', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-company-wake.example', name: 'Company Home' })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ items: [], eligibleProviders: [] }), { status: 200 }));
        const hook = await renderHook(() => useIdentityAdministration(scope, null));
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        await act(async () => { publishHomeAccountChange(serverId, [HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
        await vi.waitFor(() => expect(runtimeFetchMock.mock.calls.filter(([input]) => new URL(input.url).pathname === '/v1/home/identity/connections/list')).toHaveLength(2));
    });

    it('creates a named Home WorkOS draft through the shared setup with the captured Home scope', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-company-create.example', name: 'Company Home' })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        const item = { ...connection(false), teamId: null, provider: { id: 'company-provider', kind: 'workos_sso', displayName: 'Acme' }, settings: { v: 1, kind: 'workos_sso' }, externalReference: { v: 1, kind: 'workos_sso', organizationId: null, connectionId: null }, lastObservation: null, allowedActions: ['home.identity.workos.adminPortalLink.create'] };
        runtimeFetchMock.mockImplementation(async (input) => new Response(JSON.stringify(new URL(input.url).pathname.endsWith('/list')
            ? { items: [], eligibleProviders: [{ v: 1, providerKind: 'workos_sso', providerId: null, displayName: null, owner: 'home', availability: { status: 'available', setupChoice: { kind: 'create_managed', actionId: 'home.identity.workos.connection.create' } } }] }
            : { connection: item }), { status: 200 }));
        const created = vi.fn();
        const screen = await renderScreen(createElement(IdentityWorkosSetupContent, { scope, teamId: null, mutationsAvailable: true, onCreated: created }));
        await act(async () => {});
        await act(async () => { screen.changeTextByTestId('identity-workos-company-name', 'Acme'); });
        await screen.pressByTestIdAsync('identity-workos-create');
        expect(created).toHaveBeenCalledWith('connection-1');
        const request = runtimeFetchMock.mock.calls.find(([input]) => new URL(input.url).pathname === '/v1/home/identity/workos/connection/create')?.[0];
        expect(request).toBeDefined();
        expect(JSON.parse(request.init.body)).toEqual({ v: 1, displayName: 'Acme' });
        expect(new URL(request.url).origin).toBe('https://home-company-create.example');
    });
    it('consumes a Home Test return and refreshes its captured Home while another Home is focused', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-company-test.example', name: 'Company Home' })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        await upsertServerProfile({ serverUrl: 'https://other-company-test.example', name: 'Other Home' });
        const item = { ...connection(false), teamId: null, provider: { id: 'company-provider', kind: 'workos_sso', displayName: 'Acme' }, settings: { v: 1, kind: 'workos_sso' }, externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_acme', connectionId: 'conn_acme' }, lastObservation: null, allowedActions: ['home.identity.connections.test.start', 'home.identity.connections.enable'] };
        let consumed = false;
        runtimeFetchMock.mockImplementation(async (input) => {
            const path = new URL(input.url).pathname;
            if (path.endsWith('/test/consume')) {
                consumed = true;
                return new Response(JSON.stringify({ connection: { ...item, revision: 3 } }), { status: 200 });
            }
            return new Response(JSON.stringify({ items: [{ ...item, revision: consumed ? 3 : 2 }], eligibleProviders: [] }), { status: 200 });
        });
        const screen = await renderScreen(createElement(IdentityConnectionDetailContent, {
            scope, teamId: null, connectionId: 'connection-1', mutationsAvailable: true,
            testReturn: { purpose: 'identity_connection_test', resultHandle: 'test-result-1', error: null },
        }));
        await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith(`/settings/home/${serverId}/sign-in-providers/connections/connection-1`));
        const request = runtimeFetchMock.mock.calls.find(([input]) => new URL(input.url).pathname === '/v1/home/identity/connections/test/consume')?.[0];
        expect(JSON.parse(request.init.body)).toEqual({ v: 1, connectionId: 'connection-1', resultHandle: 'test-result-1' });
        expect(runtimeFetchMock.mock.calls.every(([input]) => new URL(input.url).origin === 'https://home-company-test.example')).toBe(true);
        expect(runtimeFetchMock.mock.calls.filter(([input]) => new URL(input.url).pathname.endsWith('/connections/list')).length).toBeGreaterThanOrEqual(2);
        expect(screen.findByTestId('identity-connection-failure')).toBeNull();
    });
    it('checks and refreshes a Home Portal return before clearing its captured return marker', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-company-portal.example', name: 'Company Home' })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        const item = { ...connection(true), teamId: null, provider: { id: 'company-provider', kind: 'workos_sso', displayName: 'Acme' }, settings: { v: 1, kind: 'workos_sso' }, externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_acme', connectionId: 'conn_acme' }, lastObservation: null, allowedActions: ['home.identity.workos.reconcile'] };
        let reconciled = false;
        runtimeFetchMock.mockImplementation(async (input) => {
            if (new URL(input.url).pathname.endsWith('/workos/reconcile')) {
                reconciled = true;
                return new Response(JSON.stringify({ outcome: 'connected', connection: { ...item, revision: 3 } }), { status: 200 });
            }
            return new Response(JSON.stringify({ items: [{ ...item, revision: reconciled ? 3 : 2 }], eligibleProviders: [] }), { status: 200 });
        });
        await renderScreen(createElement(IdentityConnectionDetailContent, { scope, teamId: null, connectionId: 'connection-1', mutationsAvailable: true, workosPortalReturn: true }));
        await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith(`/settings/home/${serverId}/sign-in-providers/connections/connection-1`));
        const request = runtimeFetchMock.mock.calls.find(([input]) => new URL(input.url).pathname === '/v1/home/identity/workos/reconcile')?.[0];
        expect(JSON.parse(request.init.body)).toEqual({ v: 1, connectionId: 'connection-1', expectedRevision: 2 });
        expect(runtimeFetchMock.mock.calls.every(([input]) => new URL(input.url).origin === 'https://home-company-portal.example')).toBe(true);
        expect(runtimeFetchMock.mock.calls.filter(([input]) => new URL(input.url).pathname.endsWith('/connections/list')).length).toBeGreaterThanOrEqual(2);
    });
    it('presents Home company setup through the shared WorkOS steps without Team directory controls', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-company-setup.example', name: 'Company Home' })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            items: [{
                ...connection(false),
                teamId: null,
                provider: { id: 'provider-company', kind: 'workos_sso', displayName: 'Acme' },
                externalReference: { v: 1, kind: 'workos_sso', organizationId: null, connectionId: null },
                settings: { v: 1, kind: 'workos_sso' },
                state: 'setting_up',
                lastObservation: null,
                allowedActions: ['home.identity.workos.adminPortalLink.create', 'home.identity.connections.remove'],
            }],
            eligibleProviders: [],
        }), { status: 200 }));

        const screen = await renderScreen(createElement(IdentityConnectionDetailContent, {
            scope, teamId: null, connectionId: 'connection-1', mutationsAvailable: true, requestApproval: vi.fn(),
        }));
        await act(async () => {});

        expect(screen.findHostByTestId('identity-workos-setup-steps')).not.toBeNull();
        expect(screen.findHostByTestId('team-identity-workos-sso')).not.toBeNull();
        expect(screen.findHostByTestId('team-identity-workos-directory')).toBeNull();
        const header = screen.findHostByTestId('identity-connection-header');
        expect(header).not.toBeNull();
        expect(header?.findAll((node) => typeof node.type === 'string' && node.props.children === 'Acme').length).toBeGreaterThan(0);
        expect(screen.findByTestId('identity-connection-status')).toBeNull();
        expect(screen.findByTestId('identity-connection-mode')).toBeNull();
    });
    it('keeps Home WorkOS choices inside Choose and submits only the explicitly selected usable connection', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-company-choose.example', name: 'Company Home' })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        let item = { ...connection(false), teamId: null, provider: { id: 'company-provider', kind: 'workos_sso', displayName: 'Acme' }, settings: { v: 1, kind: 'workos_sso' }, externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_acme', connectionId: null as string | null }, state: 'setting_up', lastObservation: null, allowedActions: ['home.identity.workos.reconcile', 'home.identity.workos.connection.set'] };
        runtimeFetchMock.mockImplementation(async (input) => {
            const path = new URL(input.url).pathname;
            if (path.endsWith('/workos/reconcile')) return new Response(JSON.stringify({ outcome: 'selection_required', connection: item, candidates: [
                { connectionId: 'candidate-draft', displayName: 'Draft', strategy: 'SAML', status: 'draft' },
                { connectionId: 'candidate-live', displayName: 'Acme Okta', strategy: 'SAML', status: 'active' },
            ] }), { status: 200 });
            if (path.endsWith('/workos/connection/set')) {
                item = { ...item, revision: 3, externalReference: { ...item.externalReference, connectionId: 'candidate-live' } };
                return new Response(JSON.stringify({ connection: item }), { status: 200 });
            }
            return new Response(JSON.stringify({ items: [item], eligibleProviders: [] }), { status: 200 });
        });
        const screen = await renderScreen(createElement(IdentityConnectionDetailContent, { scope, teamId: null, connectionId: 'connection-1', mutationsAvailable: true }));
        await vi.waitFor(() => expect(screen.findHostByTestId('identity-workos-candidate:candidate-live')).not.toBeNull());
        let parent = screen.findHostByTestId('identity-workos-candidate:candidate-live')?.parent;
        while (parent && parent.props.testID !== 'identity-workos-setup-steps') parent = parent.parent;
        expect(parent).not.toBeNull();
        expect(screen.findByTestId('identity-workos-candidate:candidate-draft')?.props.disabled).toBe(true);
        expect(screen.findByTestId('team-identity-workos-use')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('identity-workos-candidate:candidate-live');
        expect(runtimeFetchMock.mock.calls.some(([input]) => new URL(input.url).pathname.endsWith('/workos/connection/set'))).toBe(false);
        await screen.pressByTestIdAsync('team-identity-workos-use');
        const request = runtimeFetchMock.mock.calls.find(([input]) => new URL(input.url).pathname === '/v1/home/identity/workos/connection/set')?.[0];
        expect(JSON.parse(request.init.body)).toEqual({ v: 1, connectionId: 'connection-1', expectedRevision: 2, workosConnectionId: 'candidate-live' });
    });

    it('keeps Home lifecycle controls inert without owner mutation authority even when actions are advertised', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-company-readonly.example', name: 'Company Home' })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        const item = { ...connection(true), teamId: null, provider: { id: 'company-provider', kind: 'workos_sso', displayName: 'Acme' }, settings: { v: 1, kind: 'workos_sso' }, externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_acme', connectionId: 'conn_acme' }, lastObservation: null, allowedActions: ['home.identity.connections.disable', 'home.identity.connections.remove'] };
        runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ items: [item], eligibleProviders: [] }), { status: 200 }));
        const screen = await renderScreen(createElement(IdentityConnectionDetailContent, { scope, teamId: null, connectionId: 'connection-1', mutationsAvailable: false }));
        await vi.waitFor(() => expect(screen.findByTestId('team-identity-disable')).not.toBeNull());
        expect(screen.findHostByTestId('team-identity-disable')?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(screen.findHostByTestId('team-identity-remove')?.props.accessibilityState).toMatchObject({ disabled: true });
        await screen.pressByTestIdAsync('team-identity-disable');
        await screen.pressByTestIdAsync('team-identity-remove');
        expect(runtimeFetchMock.mock.calls.every(([input]) => new URL(input.url).pathname.endsWith('/connections/list'))).toBe(true);
    });
    it('reads Home company connections through the scoped Home action without a Team', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-company-identity.example', name: 'Company Home' })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        const item = {
            ...connection(true),
            teamId: null,
            provider: { id: 'provider-company', kind: 'workos_sso', displayName: 'Acme' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_acme', connectionId: 'conn_acme' },
            settings: { v: 1, kind: 'workos_sso' },
            lastObservation: null,
            allowedActions: ['home.identity.connections.disable'],
        };
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            items: [item], eligibleProviders: [],
        }), { status: 200 }));

        const result = await createIdentityAdministrationClient(scope).execute(
            'teams.identity.connections.list', { v: 1, teamId: null },
        );

        expect(result).toMatchObject({ ok: true, value: { items: [item] } });
        const request = runtimeFetchMock.mock.calls.at(-1)?.[0];
        expect(new URL(request.url).pathname).toBe('/v1/home/identity/connections/list');
        expect(JSON.parse(request?.init?.body ?? 'null')).toEqual({ v: 1 });
    });
    it('preserves the authoritative failure kind for a directory reader', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-directory-refused.example', name: 'Refused Home' })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));

        const result = await createIdentityAdministrationClient(scope).executeDirectory('teams.directory.sources.list', { v: 1, teamId: 'team-1' });

        expect(result).toMatchObject({ ok: false, failure: { domainFailure: { kind: 'forbidden', retryable: false } } });
    });

    it('keeps every connection and eligible provider reachable beyond 100 rows', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-large-identity.example',
            name: 'Large Identity Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        const items = Array.from({ length: 101 }, (_, index) => ({
            ...connection(true),
            id: `connection-${index}`,
            provider: {
                ...connection(true).provider,
                id: `provider-${index}`,
                displayName: `Provider ${index}`,
            },
        }));
        const eligibleProviders = Array.from({ length: 101 }, (_, index) => ({
            v: 1 as const,
            providerId: `eligible-provider-${index}`,
            providerKind: 'oidc' as const,
            owner: 'home' as const,
            displayName: `Eligible provider ${index}`,
            availability: {
                status: 'available' as const,
                setupChoice: {
                    kind: 'use_existing' as const,
                    providerInstanceId: `eligible-provider-${index}`,
                    connectionDraft: {
                        externalReference: { v: 1 as const, kind: 'oidc' as const },
                        settings: {
                            v: 1 as const,
                            kind: 'oidc' as const,
                            allowedUsers: [] as string[],
                            allowedEmailDomains: [] as string[],
                            groupsAny: [] as string[],
                            groupsAll: [] as string[],
                        },
                    },
                },
            },
        }));
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            items,
            eligibleProviders,
            admissionModeApplicability,
            memberSignInUrl: null,
        }), { status: 200 }));

        const result = await createIdentityAdministrationClient(scope).execute(
            'teams.identity.connections.list',
            { v: 1, teamId: 'team-1' },
        );

        expect(result).toEqual({
            ok: true,
            value: { items, eligibleProviders, admissionModeApplicability, memberSignInUrl: null },
        });
        if (result.ok) {
            expect(result.value.items.at(-1)?.id).toBe('connection-100');
            expect(result.value.eligibleProviders.at(-1)?.providerId).toBe('eligible-provider-100');
        }
    });

    it('refreshes mounted Team identity and provider projections on the exact Home Team wake', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-currentness.example',
            name: 'Currentness Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockImplementation(async (request: Readonly<{ url: string }>) => (
            new Response(JSON.stringify(request.url.endsWith('/v1/identity/providers/list')
                ? { items: [], unreadableCount: 0 }
                : request.url.endsWith('/v1/identity/github-apps/list')
                    ? { registrations: [], installations: [] }
                    : new URL(request.url).pathname === '/v1/teams/team-1/directory-sources'
                        ? { items: [directorySource('directory-1')], nextCursor: null }
                    : { items: [connection(true)], eligibleProviders: [], admissionModeApplicability, memberSignInUrl: null }), { status: 200 })
        ));

        const connections = await renderHook(() => useIdentityAdministration(scope, 'team-1'));
        const providers = await renderHook(() => useManagedIdentityProviders(
            scope,
            { kind: 'team', teamId: 'team-1' },
        ));
        const githubApps = await renderHook(() => useManagedGitHubApps(
            scope,
            { kind: 'team', teamId: 'team-1' },
        ));
        const directory = await renderHook(() => useDirectoryAdministration(scope, 'team-1'));
        await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalledTimes(4));

        await act(async () => {
            publishHomeAccountChange('another-home', [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            publishHomeAccountChange(serverId, ['home-governance']);
        });
        expect(runtimeFetchMock).toHaveBeenCalledTimes(4);

        await act(async () => {
            publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });
        await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalledTimes(8));
        expect(connections.getCurrent().state).toMatchObject({ kind: 'ready', stale: false });
        expect(providers.getCurrent().state).toMatchObject({ kind: 'ready', stale: false });
        expect(githubApps.getCurrent().state).toMatchObject({ kind: 'ready', stale: false });
        expect(directory.getCurrent().state).toMatchObject({ kind: 'ready', stale: false });

        await act(async () => {
            publishHomeAccountChange(serverId);
        });
        await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalledTimes(12));
    });

    it.each(['connections', 'directory'] as const)('never presents or settles scope A %s under scope B for the same Team ID', async (kind) => {
        const serverA = (await upsertServerProfile({ serverUrl: `https://home-a-${kind}-scope.example`, name: 'Scope Home A' })).id;
        const serverB = (await upsertServerProfile({ serverUrl: `https://home-b-${kind}-scope.example`, name: 'Scope Home B' })).id;
        const scopeA = createServerAccountScope(serverA, 'account-1')!;
        const scopeB = createServerAccountScope(serverB, 'account-1')!;
        const useProjection = kind === 'connections' ? useIdentityAdministration : useDirectoryAdministration;
        const staleA = createDeferred<Response>();
        const answerB = createDeferred<Response>();
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify(kind === 'connections'
            ? { items: [connection(true)], eligibleProviders: [], admissionModeApplicability, memberSignInUrl: null }
            : { items: [directorySource('directory-a')], nextCursor: null }), { status: 200 }));
        runtimeFetchMock.mockImplementationOnce(() => staleA.promise);
        runtimeFetchMock.mockImplementationOnce(() => answerB.promise);
        const renders: Array<Readonly<{ serverId: string; kind: string; itemId: string | null }>> = [];
        const hook = await renderHook((scope: typeof scopeA) => {
            const projection = useProjection(scope, 'team-1');
            renders.push({
                serverId: scope.serverId,
                kind: projection.state.kind,
                itemId: projection.state.kind === 'ready' ? projection.state.items[0]?.id ?? null : null,
            });
            return projection;
        }, { initialProps: scopeA });
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        await act(async () => hook.getCurrent().refresh());
        await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalledTimes(2));

        await hook.rerender(scopeB);

        expect(hook.getCurrent().state.kind).toBe('loading');
        const scopeBRenders = renders.filter((render) => render.serverId === serverB);
        expect(scopeBRenders.length).toBeGreaterThan(0);
        expect(scopeBRenders.every((render) => render.kind === 'loading' && render.itemId === null)).toBe(true);

        await act(async () => staleA.resolve(new Response(JSON.stringify(kind === 'connections'
            ? { items: [{ ...connection(true), id: 'connection-stale-a' }], eligibleProviders: [], admissionModeApplicability, memberSignInUrl: null }
            : { items: [directorySource('directory-stale-a')], nextCursor: null }), { status: 200 })));
        expect(hook.getCurrent().state.kind).toBe('loading');

        await act(async () => answerB.resolve(new Response(JSON.stringify(kind === 'connections'
            ? { items: [{ ...connection(true), id: 'connection-b' }], eligibleProviders: [], admissionModeApplicability, memberSignInUrl: null }
            : { items: [directorySource('directory-b')], nextCursor: null }), { status: 200 })));
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        const refreshed = hook.getCurrent().state;
        expect(refreshed.kind === 'ready' && refreshed.items[0]?.id)
            .toBe(kind === 'connections' ? 'connection-b' : 'directory-b');
    });

    it('accumulates directory source pages and retries a failed continuation without losing loaded rows', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-directory-paging.example',
            name: 'Directory Paging Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({
                items: [directorySource('directory-1')],
                nextCursor: 'cursor-1',
            }), { status: 200 }))
            .mockRejectedValueOnce(new Error('continuation unavailable'))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                items: [directorySource('directory-51')],
                nextCursor: null,
            }), { status: 200 }));

        const hook = await renderHook(() => useDirectoryAdministration(scope, 'team-1'));
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        expect(hook.getCurrent().state).toMatchObject({
            kind: 'ready',
            nextCursor: 'cursor-1',
            loadingMore: false,
        });

        await act(async () => hook.getCurrent().loadMore());
        expect(hook.getCurrent().state).toMatchObject({
            kind: 'ready',
            items: [expect.objectContaining({ id: 'directory-1' })],
            nextCursor: 'cursor-1',
            loadingMore: false,
            failure: expect.objectContaining({ retryable: true }),
        });

        await act(async () => hook.getCurrent().loadMore());
        await vi.waitFor(() => {
            const state = hook.getCurrent().state;
            expect(state.kind === 'ready' && state.items.map((item) => item.id)).toEqual([
            'directory-1',
            'directory-51',
            ]);
        });
        expect(hook.getCurrent().state).toMatchObject({
            kind: 'ready',
            nextCursor: null,
            loadingMore: false,
            failure: null,
        });
        expect(runtimeFetchMock.mock.calls[1]?.[0].url).toContain('cursor=cursor-1');
        expect(runtimeFetchMock.mock.calls[2]?.[0].url).toContain('cursor=cursor-1');
    });

    it('restarts directory paging at cursor zero on AccountChange and ignores the superseded continuation', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-directory-refresh.example',
            name: 'Directory Refresh Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        const staleContinuation = createDeferred<Response>();
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({
                items: [directorySource('directory-old')],
                nextCursor: 'cursor-old',
            }), { status: 200 }))
            .mockImplementationOnce(() => staleContinuation.promise)
            .mockResolvedValueOnce(new Response(JSON.stringify({
                items: [directorySource('directory-current')],
                nextCursor: 'cursor-current',
            }), { status: 200 }));

        const hook = await renderHook(() => useDirectoryAdministration(scope, 'team-1'));
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        void hook.getCurrent().loadMore();
        await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalledTimes(2));

        await act(async () => {
            publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });
        await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalledTimes(3));
        expect(runtimeFetchMock.mock.calls[2]?.[0].url).not.toContain('cursor=');
        await vi.waitFor(() => {
            const state = hook.getCurrent().state;
            expect(state.kind === 'ready' && state.items[0]?.id).toBe('directory-current');
        });

        await act(async () => staleContinuation.resolve(new Response(JSON.stringify({
            items: [directorySource('directory-stale')],
            nextCursor: null,
        }), { status: 200 })));
        const settleddirectory_current = hook.getCurrent().state;
        expect(settleddirectory_current.kind === 'ready' && settleddirectory_current.items.map((item) => item.id)).toEqual(['directory-current']);
    });

    it('drops directory pages when the exact Home/Account scope changes', async () => {
        const serverA = (await upsertServerProfile({ serverUrl: 'https://home-directory-page-a.example', name: 'Page A' })).id;
        const serverB = (await upsertServerProfile({ serverUrl: 'https://home-directory-page-b.example', name: 'Page B' })).id;
        const scopeA = createServerAccountScope(serverA, 'account-1')!;
        const scopeB = createServerAccountScope(serverB, 'account-2')!;
        const staleContinuation = createDeferred<Response>();
        const answerB = createDeferred<Response>();
        getCredentialsForServerUrlMock.mockImplementation(async (serverUrl: string) => ({
            token: tokenForSub(serverUrl === 'https://home-directory-page-b.example' ? 'account-2' : 'account-1'),
        }));
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({
                items: [directorySource('directory-a')],
                nextCursor: 'cursor-a',
            }), { status: 200 }))
            .mockImplementationOnce(() => staleContinuation.promise)
            .mockImplementationOnce(() => answerB.promise);

        const hook = await renderHook((scope: typeof scopeA) => useDirectoryAdministration(scope, 'team-1'), {
            initialProps: scopeA,
        });
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        void hook.getCurrent().loadMore();
        await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalledTimes(2));

        await hook.rerender(scopeB);
        expect(hook.getCurrent().state.kind).toBe('loading');
        await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalledTimes(3));
        await act(async () => answerB.resolve(new Response(JSON.stringify({
            items: [directorySource('directory-b')],
            nextCursor: null,
        }), { status: 200 })));
        await vi.waitFor(() => {
            const state = hook.getCurrent().state;
            expect(state.kind === 'ready' && state.items[0]?.id).toBe('directory-b');
        });

        await act(async () => staleContinuation.resolve(new Response(JSON.stringify({
            items: [directorySource('directory-stale-a')],
            nextCursor: null,
        }), { status: 200 })));
        const settleddirectory_b = hook.getCurrent().state;
        expect(settleddirectory_b.kind === 'ready' && settleddirectory_b.items.map((item) => item.id)).toEqual(['directory-b']);
    });

    it('never presents or settles a scope A directory detail under scope B for the same Team and source IDs', async () => {
        const serverA = (await upsertServerProfile({ serverUrl: 'https://home-a-directory-detail.example', name: 'Detail Home A' })).id;
        const serverB = (await upsertServerProfile({ serverUrl: 'https://home-b-directory-detail.example', name: 'Detail Home B' })).id;
        const scopeA = createServerAccountScope(serverA, 'account-1')!;
        const scopeB = createServerAccountScope(serverB, 'account-1')!;
        const staleA = createDeferred<Response>();
        const answerB = createDeferred<Response>();
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify(directorySource('directory-a')), { status: 200 }));
        runtimeFetchMock.mockImplementationOnce(() => staleA.promise);
        runtimeFetchMock.mockImplementationOnce(() => answerB.promise);
        const renders: Array<Readonly<{ serverId: string; kind: string; itemId: string | null }>> = [];
        const hook = await renderHook((scope: typeof scopeA) => {
            const projection = useDirectorySourceAdministration(scope, 'team-1', 'directory-1');
            renders.push({
                serverId: scope.serverId,
                kind: projection.state.kind,
                itemId: projection.state.kind === 'ready' ? projection.state.item.id : null,
            });
            return projection;
        }, { initialProps: scopeA });
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        await act(async () => hook.getCurrent().refresh());
        await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalledTimes(2));

        await hook.rerender(scopeB);

        expect(hook.getCurrent().state.kind).toBe('loading');
        const scopeBRenders = renders.filter((render) => render.serverId === serverB);
        expect(scopeBRenders.length).toBeGreaterThan(0);
        expect(scopeBRenders.every((render) => render.kind === 'loading' && render.itemId === null)).toBe(true);

        await act(async () => staleA.resolve(new Response(JSON.stringify(directorySource('directory-stale-a')), { status: 200 })));
        expect(hook.getCurrent().state.kind).toBe('loading');

        await act(async () => answerB.resolve(new Response(JSON.stringify(directorySource('directory-b')), { status: 200 })));
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        const reread = hook.getCurrent().state;
        expect(reread.kind === 'ready' && reread.item.id).toBe('directory-b');
    });

    it('binds a directory read to the Action-declared GET path and query', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-directory.example',
            name: 'Directory Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));

        const result = await createIdentityAdministrationClient(scope).executeDirectory(
            'teams.directory.sources.list',
            { v: 1, teamId: 'team-1', limit: 25 },
        );

        expect(result).toEqual({ ok: true, value: { items: [], nextCursor: null } });
        const request = runtimeFetchMock.mock.calls[0]?.[0];
        expect(request?.url).toBe('https://home-directory.example/v1/teams/team-1/directory-sources?limit=25');
        expect(request?.init?.method).toBe('GET');
        expect(request?.init?.body).toBeUndefined();
    });

    it('executes a Team mutation through its Action row against the exact Home without a daemon', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-a.example',
            name: 'Home A',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            connection: connection(false),
        }), { status: 200 }));

        const result = await createIdentityAdministrationClient(scope).execute(
            'teams.identity.connections.disable',
            { v: 1, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 1 },
        );

        expect(result).toEqual({ ok: true, value: { connection: connection(false) } });
        const request = runtimeFetchMock.mock.calls[0]?.[0];
        expect(request?.url).toBe('https://home-a.example/v1/teams/identity/connections/disable');
        expect(JSON.parse(request?.init?.body ?? 'null')).toEqual({
            v: 1,
            teamId: 'team-1',
            connectionId: 'connection-1',
            expectedRevision: 1,
        });
        expect(serverFetchMock).not.toHaveBeenCalled();
    });

    it('surfaces an ambiguous Team identity mutation response loss as outcome unknown', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-team-identity-unknown.example',
            name: 'Team Identity Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockImplementation(async (request) => {
            request.onIssued?.();
            throw Object.assign(new Error('connection reset after dispatch'), { code: 'ECONNRESET' });
        });

        const result = await createIdentityAdministrationClient(scope).execute(
            'teams.identity.connections.disable',
            { v: 1, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 1 },
        );

        expect(result).toMatchObject({
            ok: false,
            failure: { code: 'outcome_unknown', retryable: false },
        });
    });

    it('keeps the Home’s declared non-retryable answer even when the code name sounds transient', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-declared-retryability.example',
            name: 'Declared Retryability Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            v: 1,
            code: 'provider_credential_transport_unavailable',
            retryable: false,
            action: 'review_credential_transport',
        }), { status: 409 }));

        const result = await createIdentityAdministrationClient(scope).execute(
            'teams.identity.connections.disable',
            { v: 1, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 1 },
        );

        expect(result).toMatchObject({
            ok: false,
            failure: { code: 'provider_credential_transport_unavailable', retryable: false },
        });
    });

    it('classifies a deferred Team identity mutation as approval-pending without parsing it as domain output', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-approval.example',
            name: 'Approval Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        storage.setState({
            settingsScope: scope,
            settings: {
                ...settingsDefaults,
                actionsSettingsV1: {
                    ...DEFAULT_ACTIONS_SETTINGS_V1,
                    actions: {
                        ...DEFAULT_ACTIONS_SETTINGS_V1.actions,
                        'teams.identity.connections.disable': {
                            ...DEFAULT_ACTIONS_SETTINGS_V1.actions['teams.identity.connections.disable'],
                            approvalRequiredSurfaces: ['ui'],
                        },
                    },
                },
            },
        });
        const onApprovalPending = vi.fn();
        const result = await createIdentityAdministrationClient(scope, { onApprovalPending }).execute(
            'teams.identity.connections.disable',
            { v: 1, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 1 },
        );

        expect(result).toMatchObject({
            ok: false,
            approvalPending: true,
            artifactId: expect.any(String),
            failure: { code: 'approval_pending', retryable: false },
        });
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(onApprovalPending).toHaveBeenCalledWith(expect.objectContaining({
            artifactId: expect.any(String),
            onExecuted: expect.any(Function),
            onTerminal: expect.any(Function),
        }));
    });

    it('threads directory and external-Group terminal approval results through the shared continuation', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-directory-approval.example',
            name: 'Directory approval Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        storage.setState({
            settingsScope: scope,
            settings: {
                ...settingsDefaults,
                actionsSettingsV1: {
                    ...DEFAULT_ACTIONS_SETTINGS_V1,
                    actions: {
                        ...DEFAULT_ACTIONS_SETTINGS_V1.actions,
                        'teams.directory.sources.create': {
                            ...DEFAULT_ACTIONS_SETTINGS_V1.actions['teams.directory.sources.create'],
                            approvalRequiredSurfaces: ['ui'],
                        },
                        'teams.externalGroupBindings.set': {
                            ...DEFAULT_ACTIONS_SETTINGS_V1.actions['teams.externalGroupBindings.set'],
                            approvalRequiredSurfaces: ['ui'],
                        },
                    },
                },
            },
        });
        const onApprovalPending = vi.fn();
        const sourceFailure = vi.fn();
        const mappingFailure = vi.fn();
        const client = createIdentityAdministrationClient(scope, { onApprovalPending });

        await client.executeDirectory('teams.directory.sources.create', {
            v: 1,
            teamId: 'team-1',
            kind: 'github_organization',
            displayName: 'happier-dev',
            githubAppInstallationId: 'installation-1',
        }, { onApprovalFailed: sourceFailure });
        await client.executeExternalGroupBinding('teams.externalGroupBindings.set', {
            v: 1,
            teamId: 'team-1',
            owner: { kind: 'directory_source', directorySourceId: 'source-1' },
            externalGroupId: 'external-1',
            target: { kind: 'directory_created' },
        }, { onApprovalFailed: mappingFailure });

        expect(onApprovalPending).toHaveBeenCalledTimes(2);
        const sourceContinuation = onApprovalPending.mock.calls[0]?.[0];
        const mappingContinuation = onApprovalPending.mock.calls[1]?.[0];
        sourceContinuation.onTerminal?.('rejected');
        mappingContinuation.onTerminal?.('failed');
        expect(sourceFailure).toHaveBeenCalledWith('approval_rejected');
        expect(mappingFailure).toHaveBeenCalledWith('approval_failed');
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('reads fresh directory removal impact through the canonical public Action', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-directory-impact.example',
            name: 'Directory Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            v: 1,
            status: 'allowed',
            sourceId: 'source/1',
            sourceLabel: 'Acme directory',
            impact: {
                teamMembershipsRemoved: 2,
                groupMembershipsRemoved: 6,
                groupContributionsRemoved: 3,
                directoryCreatedGroupsRetained: 1,
                nativeMembershipsPreserved: 4,
                nativeGroupContributionsPreserved: 5,
            },
        }), { status: 200 }));

        const result = await createIdentityAdministrationClient(scope).executeDirectory(
            'teams.directory.sources.remove.preview',
            { v: 1, teamId: 'team/1', sourceId: 'source/1' },
        );

        expect(result.ok).toBe(true);
        const request = runtimeFetchMock.mock.calls[0]?.[0];
        expect(request?.url).toBe(
            'https://home-directory-impact.example/v1/teams/team%2F1/directory-sources/source%2F1/removal-impact',
        );
        expect(request?.init?.method).toBe('GET');
        expect(request?.init?.body).toBeUndefined();
    });

    it('sets an external Group mapping through the declared exact-Team Action', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-group-mapping.example',
            name: 'Group mapping Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            v: 1,
            id: 'binding-1',
            teamId: 'team-1',
            owner: { kind: 'directory_source', directorySourceId: 'source-1' },
            externalGroupId: 'external-1',
            mode: 'native_target',
            target: { teamGroupId: 'group-1', name: 'Engineering', archivedAt: null },
        }), { status: 200 }));

        const result = await createIdentityAdministrationClient(scope).executeExternalGroupBinding(
            'teams.externalGroupBindings.set',
            {
                v: 1,
                teamId: 'team-1',
                owner: { kind: 'directory_source', directorySourceId: 'source-1' },
                externalGroupId: 'external-1',
                target: { kind: 'native_target', teamGroupId: 'group-1' },
            },
        );

        expect(result.ok).toBe(true);
        const request = runtimeFetchMock.mock.calls[0]?.[0];
        expect(request?.url).toBe('https://home-group-mapping.example/v1/teams/team-1/external-group-bindings');
        expect(request?.init?.method).toBe('PUT');
    });
});
