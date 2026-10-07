import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    DEFAULT_ACTIONS_SETTINGS_V1,
    TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1,
} from '@happier-dev/protocol';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { useManagedIdentityProviders } from '@/components/settings/home/identity/useManagedIdentityProviders';
import { useManagedGitHubApps } from '@/components/settings/home/githubApps/useManagedGitHubApps';
import { useIdentityAdministration } from './useIdentityAdministration';
import { useDirectoryAdministration, useDirectorySourceAdministration } from './useDirectoryAdministration';

const serverFetchMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());

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
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account-1') });
    resetScopedHomeActionExecutorsForTests();
});

afterEach(() => {
    standardCleanup();
    resetScopedHomeActionExecutorsForTests();
    vi.clearAllMocks();
});

describe('createIdentityAdministrationClient', () => {
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
