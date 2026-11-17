import { homeGovernancePolicyProjectionFixture, homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import '@/sync/domains/state/storage';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { NO_HOME_CAPABILITIES_V1 } from '@happier-dev/protocol/home/governance';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectApprovalRequestForPublicRead } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { ManagedResourceDependencyV1Schema } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema, normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readFriendMutationProfile } from '@/sync/ops/friends';

installDisconnectedServerSocketBoundary();
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

beforeAll(async () => { await loadSyncSingletonForTests(); });

const runtimeFetchMock = vi.hoisted(() => vi.fn());

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createServerAccountConnectionProbeHttpResponse } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

import {
    createHomeDomainActionExecutorForScope,
    homeDomainFailureCode,
    homeDomainFailureFromActionFailure,
} from './homeDomainActions';

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function projection() {
    return homeGovernanceProjectionFixture({
        viewer: { accountId: 'account', homeRole: 'owner', status: 'active' },
        capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
        policy: homeGovernancePolicyProjectionFixture({ revision: 3 }),
        activeOwnerCount: 1,
    });
}

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), { status });
}

async function scopeForNewHome(serverUrl: string) {
    const serverId = await homes.addHome({ serverUrl, name: serverUrl, accountId: 'account', active: false });
    await setActiveServerId(serverId, { scope: 'device' });
    return { serverId, scope: createServerAccountScope(serverId, 'account')! };
}

beforeEach(async () => {
    await homes.reset();
    runtimeFetchMock.mockReset();
    setRuntimeFetch((url, init) => createServerAccountConnectionProbeHttpResponse(new URL(String(url)).pathname)
        ?? runtimeFetchMock({ url: String(url), init }));
});

it.each(['team_not_found', 'invitation_not_found', 'group_not_found', 'home_account_not_found', 'team_forbidden'])(
    'retains the access refusal %s after the Action envelope is decoded', (code) => {
        expect(homeDomainFailureFromActionFailure({ errorCode: code, details: { error: code } })).toEqual({
            kind: 'forbidden', retryable: false, code, details: { error: code },
        });
    },
);

it('keeps a disabled Team route unsupported after the Action envelope is decoded', () => {
    expect(homeDomainFailureFromActionFailure({ errorCode: 'teams_unavailable' }).kind).toBe('unsupported');
});

it.each([
    { status: 409, error: 'references_conflict', kind: 'conflict' },
    { status: 403, error: 'references_conflict', kind: 'unknown' },
    { status: 409, error: 'unknown_refusal', kind: 'unknown' },
])('preserves the Saved Secret currentness classification for $status $error', ({ status, error, kind }) => {
    expect(homeDomainFailureFromActionFailure({ errorCode: error, details: { error, httpStatus: status } }, 'secrets.shared.delete'))
        .toMatchObject({ kind, code: error, httpStatus: status, retryable: false });
});

it('retains only canonical vault repair hints for Saved Secret failures', () => {
    const failure = { errorCode: 'authentication_required', details: { repair: 'unlock', nativeError: 'private-marker' } };
    expect(homeDomainFailureFromActionFailure(failure, 'secrets.list')).toMatchObject({
        code: 'authentication_required', details: { repair: 'unlock' },
    });
    expect(JSON.stringify(homeDomainFailureFromActionFailure(failure, 'secrets.list'))).not.toContain('private-marker');
    expect(homeDomainFailureFromActionFailure({ ...failure, details: { repair: 'private-marker' } }, 'secrets.list').details).toBeUndefined();
    expect(homeDomainFailureFromActionFailure(failure, 'teams.members.list').details).toBeUndefined();
});

it('retains retryable Team qualification failure inside a successful discovery transport', () => {
    // Discovery carries per-Team refusals in HTTP 200. The original single-Team
    // owner serves this exact refusal as 503, so it must still offer Retry.
    expect(homeDomainFailureFromActionFailure({ errorCode: 'team_authentication_policy_unavailable' },
        'teams.credentials.entitled.list')).toMatchObject({
        kind: 'conflict', retryable: true, code: 'team_authentication_policy_unavailable',
    });
    // This code is also a non-retryable 409 in the ordinary Team family.
    expect(homeDomainFailureFromActionFailure({ errorCode: 'team_authentication_policy_unavailable' },
        'teams.members.list').retryable).toBe(false);
});

afterEach(async () => {
    resetRuntimeFetch();
    await homes.reset();
    vi.clearAllMocks();
});

describe('createHomeDomainActionExecutorForScope', () => {
    it.each(['friends.add', 'friends.remove'] as const)('admits %s through the shared UI, Agent and MCP Home transport', async (actionId) => {
        const { scope, serverId } = await scopeForNewHome('https://friends-actions.example');
        const user = { id: 'friend-1', firstName: 'Ada', lastName: null, username: 'ada', avatar: null,
            bio: null, publicKey: null, status: actionId === 'friends.add' ? 'requested' : 'none' };
        runtimeFetchMock.mockImplementation(async () => jsonResponse({ user }, 200));
        const executor = createActionExecutor({
            homeDomainAction: createHomeDomainActionExecutorForScope(scope),
            readActionsSettings: (context) => normalizeActionsSettingsV1(context.actionsSettings),
        } as ActionExecutorDeps);
        for (const surface of ['ui', 'agent', 'mcp'] as const) {
            const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
            const result = await executor.execute(actionId, { uid: user.id }, {
                surface, authority: surface === 'ui' ? 'present_user' : 'account_automation', serverId,
                runtimeAccountId: 'account', actionCaller: { kind: 'host' }, actionsSettings: settings,
            });
            expect(result).toMatchObject({ ok: true, result: { user: { id: user.id, status: user.status } } });
            expect(runtimeFetchMock).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    url: `https://friends-actions.example/v1/friends/${actionId === 'friends.add' ? 'add' : 'remove'}`,
                    init: expect.objectContaining({ method: 'POST', body: JSON.stringify({ uid: user.id }) }),
                }),
            );
        }
        expect(getActionSpec(actionId).surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
        runtimeFetchMock.mockResolvedValueOnce(jsonResponse({ user: null }, 200));
        expect(await executor.execute(actionId, { uid: 'missing-person' }, {
            surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'account',
            actionCaller: { kind: 'host' }, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { [actionId]: ['ui'] } }),
        })).toEqual({ ok: true, result: { user: null } });
    });

    it.each(['friends.add', 'friends.remove'] as const)('keeps Off and Ask admission ahead of %s, without disabling the profile neighbour', async (actionId) => {
        const { scope, serverId } = await scopeForNewHome('https://friends-policy.example');
        runtimeFetchMock.mockResolvedValue(jsonResponse({ user: null }, 200));
        let accepted = false;
        let confirmations = 0;
        const executor = createActionExecutor({
            homeDomainAction: createHomeDomainActionExecutorForScope(scope),
            readActionsSettings: (context) => normalizeActionsSettingsV1(context.actionsSettings),
            presentUserActionConfirmation: async () => {
                confirmations += 1;
                expect(runtimeFetchMock).not.toHaveBeenCalled();
                return accepted;
            },
        } as ActionExecutorDeps);
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId,
            runtimeAccountId: 'account', actionRequestId: 'friends-policy-request', actionCaller: { kind: 'host' as const } };
        const off = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { enabled: false } } });
        expect(await executor.execute(actionId, { uid: 'friend-1' }, { ...context, actionsSettings: off }))
            .toMatchObject({ ok: false, errorCode: 'action_disabled' });
        const ask = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
        expect(await executor.execute(actionId, { uid: 'friend-1' }, { ...context, actionsSettings: ask }))
            .toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        accepted = true;
        expect(await executor.execute(actionId, { uid: 'friend-1' }, { ...context, actionsSettings: ask }))
            .toEqual({ ok: true, result: { user: null } });
        expect(confirmations).toBe(2);
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        // The profile read remains available under a Friends-only policy override.
        expect(getActionSpec('account.profile.get').surfaces.ui).toBe(true);
        expect(await executor.prepare('account.profile.get', {}, { ...context, actionsSettings: off }))
            .toMatchObject({ kind: 'ready' });
    });

    it.each([
        { status: 400, body: { error: 'provider-required', provider: 'github' }, code: 'provider-required' },
        { status: 400, body: { error: 'username-required' }, code: 'username-required' },
        { status: 404, body: { error: 'not_found' }, code: 'not_found' },
        { status: 404, body: { error: 'User not found' }, code: 'User not found' },
    ])('retains the Friends server refusal $code', async ({ status, body, code }) => {
        const { scope } = await scopeForNewHome('https://friends-refusal.example');
        runtimeFetchMock.mockResolvedValue(jsonResponse(body, status));
        const result = await createHomeDomainActionExecutorForScope(scope)({ actionId: 'friends.add', input: { uid: 'friend-1' },
            context: { surface: 'ui', authority: 'present_user' } });
        expect(result).toMatchObject({ ok: false, errorCode: code });
        const failure = ActionExecuteFailureSchema.parse(result);
        if (status === 404) expect(readFriendMutationProfile(failure)).toBeNull();
        else expect(() => readFriendMutationProfile(failure)).toThrow(code);
    });

    it.each([
        { actionId: 'secrets.shared.delete', input: { resourceId: 'secret-1', expectedRevision: 3, expectedSettingsVersion: 1,
            referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } } },
            code: 'managed_resources_review_required' },
        { actionId: 'home.accounts.delete', input: { accountId: 'account-to-delete' }, code: 'account_erasure_managed_resources_review_required' },
    ] as const)('carries the HTTP $actionId removal review through durable approval and public follow', async ({ actionId, input, code }) => {
        const { serverId, scope } = await scopeForNewHome('https://removal-review.example');
        const provider = { pluginId: 'custom.compute', localId: 'vm' };
        const resource = ManagedResourceDependencyV1Schema.parse({ managedId: 'managed-1', homeId: serverId,
            custodianAccountId: 'account', intentRevision: 7,
            controller: { machineId: 'controller-1', installationId: 'installation-1' }, provider, allocation: 'may-exist',
            resource: { contributionRef: provider, schemaVersion: 1, value: { nativeId: 'native-1' } } });
        const details = { error: code, resources: [resource] };
        runtimeFetchMock.mockResolvedValue(jsonResponse(details, 409));
        const result = await createHomeDomainActionExecutorForScope(scope)({ actionId, input,
            context: { surface: 'ui', authority: 'present_user' } });
        const failure = ActionExecuteFailureSchema.parse(result);
        expect(failure.details).toEqual({ ...details, httpStatus: 409 });
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs: input, summary: 'Review removal',
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                serverId, accountId: 'account', actionId, requestId: 'request-1' } });
        const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
        expect(execution.details).toEqual(details);
        const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
            decision: { kind: 'approve', decidedAtMs: 2 }, execution });
        expect(readApprovalExecutionFailure(stored)?.details).toEqual(details);
        expect(projectApprovalRequestForPublicRead(stored)).toMatchObject({ execution: { details } });
    });
    it.each([
        { payload: { error: 'credential_scope_denied' }, errorCode: 'credential_scope_denied' },
        { payload: { error: 'credential_scope_denied', details: {} }, errorCode: 'credential_scope_denied' },
        { payload: { error: 'unknown_denial' }, errorCode: 'home_forbidden' },
    ])("preserves the HTTP owner's credential refusal classification: $errorCode", async ({ payload, errorCode }) => {
        const { scope } = await scopeForNewHome('https://scope-denial.example');
        runtimeFetchMock.mockResolvedValue(jsonResponse(payload, 403));
        await expect(createHomeDomainActionExecutorForScope(scope)({ actionId: 'session.delete', input: { sessionId: 'same' }, context: {} }))
            .resolves.toMatchObject({ ok: false, errorCode, error: errorCode });
    });

    it.each([
        { status: 409, body: { error: 'username-taken' }, code: 'username-taken', retryable: false },
        { status: 429, body: {}, code: 'home_unknown', retryable: true },
    ])('round-trips actual HTTP $status without losing typed domain details', async ({ status, body, code, retryable }) => {
        const { scope } = await scopeForNewHome('https://profile-refusal.example');
        runtimeFetchMock.mockResolvedValue(jsonResponse(body, status));
        const result = await createHomeDomainActionExecutorForScope(scope)({ actionId: 'account.username.set', input: { username: 'self' },
            context: { surface: 'ui', authority: 'present_user' } });
        expect(result).toMatchObject({ ok: false, errorCode: code });
        const failure = homeDomainFailureFromActionFailure(ActionExecuteFailureSchema.parse(result));
        expect(failure).toMatchObject({ httpStatus: status, retryable, ...(status === 409 ? { details: body } : {}) });
    });

    it.each([
        { status: 404, error: 'Session not found or not owned by user', code: 'session_absent' },
        { status: 409, error: 'Session is active', code: 'session_active' },
        { status: 409, error: 'Session delete condition was lost', code: 'session_delete_conflict' },
    ])('retains deletion refusal $code and its exact Home payload', async ({ status, error, code }) => {
        const { scope } = await scopeForNewHome('https://delete-home.example');
        runtimeFetchMock.mockResolvedValue(jsonResponse({ error }, status));
        const result = await createHomeDomainActionExecutorForScope(scope)({ actionId: 'session.delete',
            input: { sessionId: 'session' }, context: { surface: 'ui', authority: 'present_user' } });
        expect(result).toEqual({ ok: false, errorCode: code, error: code, details: { error, httpStatus: status } });
    });

    it('settles a confirmed transaction rollback as a typed failure instead of an unknown mutation outcome', async () => {
        const { scope } = await scopeForNewHome('https://delete-rollback.example');
        runtimeFetchMock.mockResolvedValue(jsonResponse({
            error: 'database_transaction_conflict_exhausted', statusCode: 503,
        }, 503));
        const result = await createHomeDomainActionExecutorForScope(scope)({
            actionId: 'session.delete', input: { sessionId: 'session' },
            context: { surface: 'ui', authority: 'present_user' },
        });
        expect(result).toEqual({
            ok: false,
            errorCode: 'database_transaction_conflict_exhausted',
            error: 'database_transaction_conflict_exhausted',
            details: { error: 'database_transaction_conflict_exhausted', statusCode: 503, httpStatus: 503 },
        });
    });
    it('carries a family intent to the path its Action row declares', async () => {
        const { scope } = await scopeForNewHome('https://home-a.example');
        runtimeFetchMock.mockResolvedValue(jsonResponse(projection(), 200));

        const execute = createHomeDomainActionExecutorForScope(scope);
        const result = await execute({
            actionId: 'home.governance.get',
            input: {},
            context: { surface: 'ui', authority: 'present_user' } as never,
        });

        expect(result).toEqual(projection());
        expect(String(runtimeFetchMock.mock.calls[0]?.[0]?.url))
            .toBe('https://home-a.example/v1/home/governance/get');
    });

    it('carries managed GitHub administration through the same exact-Home executor', async () => {
        const { scope } = await scopeForNewHome('https://home-github.example');
        runtimeFetchMock.mockResolvedValue(jsonResponse({ registrations: [], installations: [] }, 200));

        const execute = createHomeDomainActionExecutorForScope(scope);
        const result = await execute({
            actionId: 'identity.githubApps.list',
            input: { owner: { kind: 'team', teamId: 'team-1' } },
            context: { surface: 'ui', authority: 'present_user' } as never,
        });

        expect(result).toEqual({ registrations: [], installations: [] });
        expect(String(runtimeFetchMock.mock.calls[0]?.[0]?.url))
            .toBe('https://home-github.example/v1/identity/github-apps/list');
    });

    it('uses the Action row side-effect class to preserve an ambiguous mutation outcome', async () => {
        const { scope } = await scopeForNewHome('https://home-loss.example');
        runtimeFetchMock.mockImplementation(async (params) => {
            throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
        });

        const execute = createHomeDomainActionExecutorForScope(scope);
        await expect(execute({
            actionId: 'identity.githubApps.create',
            input: {
                owner: { kind: 'home' },
                githubHost: 'https://github.com',
                githubAppId: '44',
                githubClientId: 'Iv1.client',
                secrets: { privateKey: 'private-key' },
            },
            context: { surface: 'ui', authority: 'present_user' } as never,
        })).resolves.toEqual({
            ok: false,
            errorCode: 'outcome_unknown',
            error: 'outcome_unknown',
        });

        await expect(execute({
            actionId: 'identity.githubApps.list',
            input: { owner: { kind: 'home' } },
            context: { surface: 'ui', authority: 'present_user' } as never,
        })).resolves.toEqual({
            ok: false,
            errorCode: 'home_unreachable',
            error: 'home_unreachable',
        });
    });

    it('reports a Home denial as a typed Action failure instead of throwing', async () => {
        const { scope } = await scopeForNewHome('https://home-b.example');
        runtimeFetchMock.mockResolvedValue(jsonResponse({ error: 'home_governance_forbidden' }, 403));

        const execute = createHomeDomainActionExecutorForScope(scope);
        const result = await execute({
            actionId: 'home.accounts.role.set',
            input: { accountId: 'other', homeRole: 'admin' },
            context: { surface: 'ui', authority: 'present_user' } as never,
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'home_governance_forbidden',
            error: 'home_governance_forbidden',
            details: { error: 'home_governance_forbidden', httpStatus: 403 },
        });
    });

    it('carries canonical recovery details through the shared Action failure envelope', async () => {
        const { scope } = await scopeForNewHome('https://home-provider.example');
        const details = {
            v: 1,
            code: 'provider_endpoint_rate_limited',
            retryable: true,
            retryAfterMs: 1_500,
            action: 'retry',
        } as const;
        runtimeFetchMock.mockResolvedValue(jsonResponse(details, 429));

        const execute = createHomeDomainActionExecutorForScope(scope);
        const result = await execute({
            actionId: 'home.governance.get',
            input: {},
            context: { surface: 'ui', authority: 'present_user' } as never,
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'provider_endpoint_rate_limited',
            error: 'provider_endpoint_rate_limited',
            details: { ...details, httpStatus: 429 },
        });
    });

    it('binds a directory read to its exact Team path and query', async () => {
        const { scope } = await scopeForNewHome('https://home-directory.example');
        runtimeFetchMock.mockResolvedValue(jsonResponse({ items: [], nextCursor: null }, 200));

        const execute = createHomeDomainActionExecutorForScope(scope);
        await expect(execute({
            actionId: 'teams.directory.groups.list',
            input: { v: 1, teamId: 'team/a', sourceId: 'source b', limit: 25, query: 'R&D' },
            context: { surface: 'ui', authority: 'present_user' } as never,
        })).resolves.toEqual({ items: [], nextCursor: null });

        expect(String(runtimeFetchMock.mock.calls[0]?.[0]?.url)).toBe(
            'https://home-directory.example/v1/teams/team%2Fa/directory-sources/source%20b/groups?limit=25&query=R%26D',
        );
        expect(runtimeFetchMock.mock.calls[0]?.[0]?.init).toMatchObject({ method: 'GET' });
        expect(runtimeFetchMock.mock.calls[0]?.[0]?.init?.body).toBeUndefined();
    });

    it('reports a Home without the operation as unsupported rather than as a denial', async () => {
        const { scope } = await scopeForNewHome('https://home-c.example');
        runtimeFetchMock.mockResolvedValue(new Response('', { status: 404 }));

        const execute = createHomeDomainActionExecutorForScope(scope);
        const result = await execute({
            actionId: 'teams.archive',
            input: { v: 1, teamId: 'team-1' },
            context: { surface: 'ui', authority: 'present_user' } as never,
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'unsupported_action',
            error: 'unsupported_action:teams.archive',
            details: { httpStatus: 404 },
        });
    });

    it('fails closed without issuing a request when the credential authenticates another Account', async () => {
        const { scope } = await scopeForNewHome('https://home-d.example');
        await TokenStorage.setCredentialsForServerUrl('https://home-d.example', { serverId: scope.serverId }, { token: tokenForSub('someone-else') });

        const execute = createHomeDomainActionExecutorForScope(scope);
        const result = await execute({
            actionId: 'home.governance.get',
            input: {},
            context: { surface: 'ui', authority: 'present_user' } as never,
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'home_unreachable',
            error: 'home_unreachable',
        });
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('completes against the Home it captured even when focus moves first', async () => {
        const { scope } = await scopeForNewHome('https://home-e.example');
        const other = (await upsertServerProfile({ serverUrl: 'https://home-f.example', name: 'F' })).id;

        let release: (() => void) | null = null;
        runtimeFetchMock.mockImplementation(async () => {
            await new Promise<void>((resolve) => { release = resolve; });
            return jsonResponse(projection(), 200);
        });

        const execute = createHomeDomainActionExecutorForScope(scope);
        const pending = execute({
            actionId: 'home.governance.get',
            input: {},
            context: { surface: 'ui', authority: 'present_user' } as never,
        });

        await vi.waitFor(() => expect(release).not.toBeNull());
        await setActiveServerId(other, { scope: 'device' });
        release!();

        await expect(pending).resolves.toEqual(projection());
        const urls = runtimeFetchMock.mock.calls.map(([input]) => String(input?.url ?? ''));
        expect(urls.some((url) => url.startsWith('https://home-f.example'))).toBe(false);
    });
});

describe('Home domain contributed-family failure decoding', () => {
    it('preserves the Machine availability cause and remedy only for target unavailability', () => {
        const details = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
        expect(homeDomainFailureFromActionFailure({ errorCode: 'target_unavailable', details }))
            .toEqual({ kind: 'unknown', retryable: false, code: 'target_unavailable', details });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'admission_unavailable', details }))
            .toEqual({ kind: 'unknown', retryable: false, code: 'admission_unavailable' });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'target_unavailable', details: { ...details, secret: 'private' } }))
            .toEqual({ kind: 'unknown', retryable: false, code: 'target_unavailable' });
    });
    it('preserves validated retained admission details without accepting unrelated error data', () => {
        const details = { error: 'invalid_request', code: 'target_unavailable', requestId: 'request-a',
            managedAdmission: { managedId: 'managed-a' } };
        expect(homeDomainFailureFromActionFailure({ errorCode: 'target_unavailable', details }))
            .toEqual({ kind: 'unknown', retryable: false, code: 'target_unavailable', details });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'admission_unavailable', details }))
            .toEqual({ kind: 'unknown', retryable: false, code: 'admission_unavailable' });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'target_unavailable', details: { ...details, secret: 'untrusted' } }))
            .toEqual({ kind: 'unknown', retryable: false, code: 'target_unavailable' });
    });

    it('preserves a pre-dispatch managed admission refusal without inventing a Home outage', () => {
        const failure = homeDomainFailureFromActionFailure({ errorCode: 'admission_unavailable' });
        expect(failure).toEqual({ kind: 'unknown', retryable: false, code: 'admission_unavailable' });
        expect(homeDomainFailureCode(failure)).toBe('admission_unavailable');
    });

    it.each([
        'identity_connection_conflict',
        'directory_source_permission_lost',
        'directory_unavailable',
        'recipient_key_unavailable',
    ] as const)('preserves %s as the exact Home-domain failure code', (code) => {
        const failure = homeDomainFailureFromActionFailure({
            errorCode: code,
            details: { error: code },
        });

        expect(homeDomainFailureCode(failure)).toBe(code);
        expect(failure.code).toBe(code);
    });
});
