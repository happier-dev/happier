import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    buildApprovalRequestArtifactHeaderV1,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    DEFAULT_ACTIONS_SETTINGS_V1,
    type ApprovalRequestV2,
    type ManagedIdentityProviderOwnerV1,
} from '@happier-dev/protocol';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { useManagedIdentityProviders } from './useManagedIdentityProviders';
import type { ActionApprovalContinuation, ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

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
        if (path.startsWith('/v1/features')) return serverFetchMock(path, init);
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

import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';

import { createManagedIdentityProviderClient, executeManagedIdentityProviderRead } from './managedIdentityProviderClient';
import { executeIdentityAdministrationRead } from '@/components/settings/teams/identity/identityAdministrationClient';
import { resetScopedHomeActionExecutorsForTests } from '@/sync/ops/actions/scopedHomeActionExecutor';

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

async function readApprovalScope(actionId: 'identity.providers.list' | 'identity.providers.remove.preview' = 'identity.providers.list') {
    const serverId = (await upsertServerProfile({
        serverUrl: 'https://home-provider-read-approval.example',
        name: 'Read approval Home',
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
                    [actionId]: { ...DEFAULT_ACTIONS_SETTINGS_V1.actions[actionId], approvalRequiredSurfaces: ['ui'] },
                },
            },
        },
    });
    const features = {
        features: {},
        capabilities: {
            accountStoredContentCompatibility: {
                v: 1,
                minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        },
    };
    // Capability discovery can use either transport according to whether this
    // exact Home is active; both are genuine HTTP boundaries.
    serverFetchMock.mockImplementation(async () => Response.json(features));
    runtimeFetchMock.mockImplementation(async (request: Readonly<{ url: string }>) => new Response(JSON.stringify(
        request.url.includes('/v1/features') ? features : { items: [], unreadableCount: 0 },
    ), { status: 200, headers: { 'content-type': 'application/json' } }));
    return scope;
}

function continuation(registration: ActionApprovalRegistration | undefined): ActionApprovalContinuation {
    if (!registration || typeof registration === 'string') throw new Error('Expected a result-bearing approval');
    return registration;
}

function approvedListArtifact(input: Readonly<{
    approval: ActionApprovalContinuation;
    scope: ServerAccountScope;
    owner: ManagedIdentityProviderOwnerV1;
    unreadableCount: number;
}>): DecryptedArtifact {
    const request: ApprovalRequestV2 = {
        v: 2,
        status: 'executed',
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' },
        requestedSurface: 'ui',
        executionOriginV1: {
            v: 1,
            authority: 'present_user',
            surface: 'ui',
            caller: { kind: 'host' },
            ...input.scope,
            actionId: 'identity.providers.list',
            requestId: 'read-request',
        },
        actionId: 'identity.providers.list',
        actionArgs: { owner: input.owner },
        summary: 'Read managed providers',
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 2, ok: true, result: { items: [], unreadableCount: input.unreadableCount } },
    };
    return {
        id: input.approval.artifactId,
        title: null,
        header: buildApprovalRequestArtifactHeaderV1(request),
        body: JSON.stringify(request),
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        isDecrypted: true,
    };
}

beforeEach(() => {
    runtimeFetchMock.mockReset();
    serverFetchMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account-1') });
    storage.setState({ settingsScope: null, settings: settingsDefaults });
    resetScopedHomeActionExecutorsForTests();
});

afterEach(() => {
    standardCleanup();
    resetScopedHomeActionExecutorsForTests();
    vi.clearAllMocks();
});

describe('createManagedIdentityProviderClient', () => {
    it('classifies an approval-deferred read failure exactly like the Teams identity read owner', async () => {
        const unreachable = { ok: false as const, errorCode: 'home_unreachable', error: 'home_unreachable' };
        const failLater = (onApprovalFailed?: (code: string, failure?: typeof unreachable) => void) => {
            queueMicrotask(() => onApprovalFailed?.('approval_execution_failed', unreachable));
        };
        const managed = await executeManagedIdentityProviderRead<unknown>(async (options) => {
            failLater(options.onApprovalFailed);
            return { kind: 'approval_pending', artifactId: 'artifact-1', approval: {} as ActionApprovalContinuation };
        });
        const teams = await executeIdentityAdministrationRead<unknown>(async (options) => {
            failLater(options.onApprovalFailed);
            return { ok: false, approvalPending: true, artifactId: 'artifact-1', failure: { code: 'approval_pending', retryable: false } };
        });

        expect(managed).toEqual({ kind: 'failed', failure: { code: 'home_unreachable', retryable: true } });
        expect(teams).toMatchObject({ ok: false, failure: { code: 'home_unreachable', retryable: true } });
    });

    it('retains a configured approval for a removal-preview read until its terminal result', async () => {
        const scope = await readApprovalScope('identity.providers.remove.preview');
        const onApprovalFailed = vi.fn();
        const result = await createManagedIdentityProviderClient(scope).execute(
            'identity.providers.remove.preview',
            { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 1 },
            { onApprovalFailed },
        );

        expect(result.kind).toBe('approval_pending');
        if (result.kind !== 'approval_pending') throw new Error('Expected approval to await a decision');
        result.approval.onTerminal?.('rejected');
        expect(onApprovalFailed).toHaveBeenCalledWith('approval_rejected');
        expect(runtimeFetchMock.mock.calls.filter(([request]) => request.url.endsWith('/v1/identity/providers/remove/preflight'))).toHaveLength(0);
    });

    it.each<ManagedIdentityProviderOwnerV1>([{ kind: 'home' }, { kind: 'team', teamId: 'team-1' }])(
        'consumes an approved $kind provider read in the mounted list without issuing it again',
        async (owner) => {
            const scope = await readApprovalScope();
            const onApprovalPending = vi.fn<(registration: ActionApprovalRegistration) => void>();
            const hook = await renderHook(() => useManagedIdentityProviders(scope, owner, onApprovalPending));

            await vi.waitFor(() => expect(onApprovalPending).toHaveBeenCalledTimes(1));
            expect(hook.getCurrent().state).toEqual({ kind: 'loading' });
            const approval = continuation(onApprovalPending.mock.calls[0]?.[0]);
            await act(async () => {
                await approval.onExecuted(approvedListArtifact({ approval, scope, owner, unreadableCount: 3 }));
            });

            expect(hook.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 3, refreshing: false, stale: false });
            expect(onApprovalPending).toHaveBeenCalledTimes(1);
            expect(runtimeFetchMock.mock.calls.filter(([request]) => request.url.endsWith('/v1/identity/providers/list'))).toHaveLength(0);
        },
    );

    it('releases a rejected read for explicit retry and settles the new approval', async () => {
        const scope = await readApprovalScope();
        const owner = { kind: 'home' } as const;
        const onApprovalPending = vi.fn<(registration: ActionApprovalRegistration) => void>();
        const hook = await renderHook(() => useManagedIdentityProviders(scope, owner, onApprovalPending));
        await vi.waitFor(() => expect(onApprovalPending).toHaveBeenCalledTimes(1));
        await act(async () => continuation(onApprovalPending.mock.calls[0]?.[0]).onTerminal?.('rejected'));

        expect(hook.getCurrent().state).toEqual({ kind: 'unavailable', failure: { code: 'approval_rejected', retryable: true } });
        await act(async () => hook.getCurrent().refresh());
        await vi.waitFor(() => expect(onApprovalPending).toHaveBeenCalledTimes(2));
        const approval = continuation(onApprovalPending.mock.calls[1]?.[0]);
        await act(async () => {
            await approval.onExecuted(approvedListArtifact({ approval, scope, owner, unreadableCount: 4 }));
        });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 4, stale: false });
    });

    it('ignores approval results after the Team query changes or a new refresh supersedes them', async () => {
        const scope = await readApprovalScope();
        const onApprovalPending = vi.fn<(registration: ActionApprovalRegistration) => void>();
        const hook = await renderHook((teamId: string) => useManagedIdentityProviders(scope, { kind: 'team', teamId }, onApprovalPending), { initialProps: 'team-1' });
        await vi.waitFor(() => expect(onApprovalPending).toHaveBeenCalledTimes(1));
        const previousTeam = continuation(onApprovalPending.mock.calls[0]?.[0]);
        await hook.rerender('team-2');
        await vi.waitFor(() => expect(onApprovalPending).toHaveBeenCalledTimes(2));
        const supersededRefresh = continuation(onApprovalPending.mock.calls[1]?.[0]);
        await act(async () => hook.getCurrent().refresh());
        await vi.waitFor(() => expect(onApprovalPending).toHaveBeenCalledTimes(3));
        const approval = continuation(onApprovalPending.mock.calls[2]?.[0]);
        await act(async () => {
            await approval.onExecuted(approvedListArtifact({ approval, scope, owner: { kind: 'team', teamId: 'team-2' }, unreadableCount: 2 }));
            await previousTeam.onExecuted(approvedListArtifact({ approval: previousTeam, scope, owner: { kind: 'team', teamId: 'team-1' }, unreadableCount: 1 }));
            supersededRefresh.onTerminal?.('rejected');
        });

        expect(hook.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 2, stale: false });
    });

    it('does not retain another owner’s projection when the mounted query changes Team', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-provider-scope.example', name: 'Scope Home' })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], unreadableCount: 3 }), { status: 200 }));
        const hook = await renderHook((teamId: string) => useManagedIdentityProviders(scope, { kind: 'team', teamId }), { initialProps: 'team-1' });
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));

        await hook.rerender('team-2');

        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('unavailable'));
    });
    it('lists Home-owned providers through the Action-declared exact Home route', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-provider.example',
            name: 'Provider Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [], unreadableCount: 0 }), { status: 200 }));

        const result = await createManagedIdentityProviderClient(scope).execute(
            'identity.providers.list',
            { owner: { kind: 'home' } },
        );

        expect(result).toEqual({ kind: 'succeeded', value: { items: [], unreadableCount: 0 } });
        const request = runtimeFetchMock.mock.calls[0]?.[0];
        expect(request?.url).toBe('https://home-provider.example/v1/identity/providers/list');
        expect(request?.init?.method).toBe('POST');
        expect(JSON.parse(request?.init?.body ?? 'null')).toEqual({ owner: { kind: 'home' } });
        expect(serverFetchMock).not.toHaveBeenCalled();
    });

    it('reads fresh removal impact through the canonical public Action', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-provider-impact.example',
            name: 'Provider Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            provider: {
                v: 1,
                owner: { kind: 'home' },
                id: 'provider/1',
                kind: 'oidc',
                displayName: 'Corporate OIDC',
                enabled: false,
                firstEnabledAt: null,
                securityRevision: 1,
                revision: 2,
                config: {
                    v: 1,
                    kind: 'oidc',
                    issuer: 'https://id.example',
                    clientId: 'client',
                    clientAuthenticationMethod: 'client_secret_post',
                    scopes: 'openid',
                    httpTimeoutSeconds: 15,
                    claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
                    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                    fetchUserInfo: true,
                    storeRefreshToken: false,
                    ui: { buttonColor: null, iconHint: null },
                },
                secret: { configured: true, health: 'configured' },
                teamConsumers: [],
                lastSuccessfulTest: null,
                createdByAccountId: 'account-1',
                createdAt: 1,
                updatedAt: 2,
            },
            canRemove: false,
            blockers: { identityCount: 2, connectionCount: 1, affectedAccountIds: ['account-2'] },
        }), { status: 200 }));

        const result = await createManagedIdentityProviderClient(scope).execute(
            'identity.providers.remove.preview',
            { owner: { kind: 'home' }, id: 'provider/1', expectedRevision: 2 },
        );

        expect(result.kind).toBe('succeeded');
        const request = runtimeFetchMock.mock.calls[0]?.[0];
        expect(request?.url).toBe('https://home-provider-impact.example/v1/identity/providers/remove/preflight');
        expect(request?.init?.method).toBe('POST');
        expect(JSON.parse(request?.init?.body ?? 'null')).toEqual({
            owner: { kind: 'home' }, id: 'provider/1', expectedRevision: 2,
        });
    });

    it('surfaces an ambiguous managed-provider mutation response loss as outcome unknown', async () => {
        const serverId = (await upsertServerProfile({
            serverUrl: 'https://home-provider-unknown.example',
            name: 'Provider Home',
        })).id;
        const scope = createServerAccountScope(serverId, 'account-1')!;
        runtimeFetchMock.mockImplementation(async (request) => {
            request.onIssued?.();
            throw Object.assign(new Error('connection reset after dispatch'), { code: 'ECONNRESET' });
        });

        const result = await createManagedIdentityProviderClient(scope).execute(
            'identity.providers.disable',
            { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 2, expectedSecurityRevision: 1 },
        );

        expect(result).toEqual({
            kind: 'failed',
            failure: { code: 'outcome_unknown', retryable: false },
        });
    });
});
