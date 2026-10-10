import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

const http = vi.hoisted(() => vi.fn());
// HTTP and credential storage are boundaries; scope capture, transport, schemas and Actions stay real.
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({ runtimeFetchWithServerReachability: http }));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: 'e30.eyJzdWIiOiJhY2NvdW50In0.signature' }),
    } });
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { createHomeDomainActionExecutorForScope } from '@/sync/api/home/homeDomainActions';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { createSettingsDeclarationAction } from './settingsDeclarationAction';
import { createSettingsOwnerActionExecutor } from './settingsOwnerActionExecutor';
import { teamSummaryFixture, teamPolicyFixture } from '@/dev/testkit/fixtures/teamFixtures';
import type { TeamIdentityConnectionV1 } from '@happier-dev/protocol/teams';
import type { TeamRestrictedAuthenticationPolicyV1 } from '@happier-dev/protocol';

const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
const anchor = `homeAdministration.serverSettings.${key}`;
function projection(value = 600, revision = 3, fixed = false) {
    return { revision, startedAt: null, entries: [{ key, value, fixed, source: 'default', editable: 'home', apply: 'restart',
        declaration: { type: 'int', section: 'server', bounds: { min: 0 } } }] };
}

async function harness(requireHomeApproval = false, approvalsCreate?: ActionExecutorDeps['approvalsCreate']) {
    const profile = await upsertServerProfile({ serverUrl: 'https://settings-home.example', name: 'Home' });
    await setActiveServerId(profile.id, { scope: 'device' });
    const scope = createServerAccountScope(profile.id, 'account')!;
    let current = true;
    const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', serverId: scope.serverId };
    let executor: ReturnType<typeof createActionExecutor>;
    const action = createSettingsDeclarationAction({ host: { os: 'web', desktop: false }, tauriDesktop: false, serverId: scope.serverId,
        readPageGate: () => undefined, isFeatureEnabled: async () => true, isCurrent: () => current,
        readAccountSettings: async () => settingsDefaults,
        writeAccountSettings: async () => { throw new Error('Home must never write Account preferences'); },
        mutateAccountSettings: async () => { throw new Error('Home must never mutate Account preferences'); },
        readLocalSettings: () => localSettingsDefaults,
        writeLocalSettings: () => { throw new Error('Home must never write device preferences'); },
        mutationServices: { executeSettingsOwnerAction: createSettingsOwnerActionExecutor(
            request => executor.execute(request.actionId, request.input, request.context),
            { serverId: scope.serverId, accountId: scope.accountId,
                assertCurrent: () => { if (!current) throw new Error('Account retired'); } },
        ) },
    });
    const unused = async () => { throw new Error('unexpected unrelated effect'); };
    executor = createActionExecutor({ settingsDeclarationAction: action,
        homeDomainAction: createHomeDomainActionExecutorForScope(scope),
        isActionApprovalRequired: id => requireHomeApproval && id === 'home.settings.set',
        ...(approvalsCreate ? { approvalsCreate } : {}),
        executionRunStart: unused, executionRunList: unused, executionRunGet: unused, detachedExecutionRunSend: unused,
        executionRunStop: unused, executionRunAction: unused, executionRunWait: unused, sessionOpen: unused,
        sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused, pathsListRecent: unused,
        machinesList: unused, serversList: unused, reviewEnginesList: unused, agentsBackendsList: unused,
        agentsModelsList: unused, sessionSendMessage: unused, sessionModeSet: unused, sessionModesList: unused,
        sessionList: unused, sessionActivityGet: unused, sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: unused,
        daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
    } satisfies ActionExecutorDeps);
    return { execute: (id: 'settings.get' | 'settings.set' | 'settings.list' | 'settings.invoke', input: unknown, overrides?: ActionExecutorContext) =>
        executor.execute(id, input, { ...context, ...overrides }), serverId: scope.serverId, retire: () => { current = false; } };
}

beforeEach(() => http.mockReset());
describe('Home registry Settings Actions', () => {
    it('rejects mismatched targets and missing Team identity before reaching a domain transport', async () => {
        const owner = await harness();
        for (const input of [
            { anchor, target: { kind: 'team', serverId: owner.serverId, teamId: 'team-1' } },
            { anchor, target: { kind: 'home', serverId: 'other-home' } },
            { anchor: 'delegation.workDepthLimit', target: { kind: 'team', serverId: owner.serverId, teamId: 'team-1' } },
        ]) expect(await owner.execute('settings.set', { ...input, value: 3 })).toMatchObject({ ok: false, errorCode: 'setting_target_mismatch' });
        expect(await owner.execute('settings.get', { anchor: 'teams.authentication.admissionJit' }))
            .toMatchObject({ ok: false, errorCode: 'setting_target_required' });
        expect(await owner.execute('settings.invoke', { anchor: 'teams.authentication.admissionJit' }))
            .toMatchObject({ ok: false, errorCode: 'setting_operation_unavailable' });
        expect(http.mock.calls).toHaveLength(0);
        http.mockResolvedValueOnce(Response.json(projection()));
        expect(await owner.execute('settings.get', { anchor, target: { kind: 'home', serverId: owner.serverId } }))
            .toEqual({ ok: true, result: { anchor, value: 600 } });
    });

    it('discovers and edits the explicit Team through its existing policy Action', async () => {
        const owner = await harness();
        expect(await owner.execute('settings.list', { pageId: 'teams' })).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
            expect.objectContaining({ anchor: 'teams.authentication.admissionJit', targetKinds: ['team'], targetRequired: true, readable: true, writable: true }),
        ]) } });
        const target = { kind: 'team', serverId: owner.serverId, teamId: 'team-explicit' };
        const team = teamSummaryFixture({ id: target.teamId });
        http.mockResolvedValueOnce(Response.json(team));
        expect(await owner.execute('settings.get', { anchor: 'teams.authentication.admissionJit', target }))
            .toEqual({ ok: true, result: { anchor: 'teams.authentication.admissionJit', value: false } });
        http.mockResolvedValueOnce(Response.json(team));
        http.mockImplementationOnce(async request => {
            expect(new URL(String(request.url)).pathname).toBe('/v1/teams/policy/set');
            expect(JSON.parse(String(request.init.body))).toEqual({ v: 1, teamId: target.teamId, admissionMode: 'jit' });
            return Response.json({ ...team, policy: teamPolicyFixture({ admissionMode: 'jit' }) });
        });
        expect(await owner.execute('settings.set', { anchor: 'teams.authentication.admissionJit', value: true, target }))
            .toEqual({ ok: true, result: { anchor: 'teams.authentication.admissionJit', value: true } });
    });

    it('edits an exact connection with its current revision and preserves sibling restrictions', async () => {
        const owner = await harness();
        const target = { kind: 'team_identity_connection', serverId: owner.serverId, teamId: 'team-explicit', connectionId: 'connection-explicit' };
        const connection: TeamIdentityConnectionV1 = { v: 1, id: target.connectionId, teamId: target.teamId,
            provider: { id: 'provider', kind: 'oidc', displayName: 'OIDC' }, externalReference: { v: 1, kind: 'oidc' },
            settings: { v: 1, kind: 'oidc', allowedUsers: ['alice'], allowedEmailDomains: ['example.org'], groupsAny: ['staff'], groupsAll: [] },
            enabled: true, firstEnabledAt: 1, revision: 7, state: 'connected', allowedActions: ['teams.identity.connections.settings.update'],
            lastObservation: null, lastSuccessfulTest: null, createdAt: 1, updatedAt: 1 };
        const list = { items: [connection], eligibleProviders: [], memberSignInUrl: null,
            admissionModeApplicability: { v: 1, modes: { invite_only: { status: 'available' }, provisioned: { status: 'available' }, jit: { status: 'available' } } } };
        http.mockResolvedValueOnce(Response.json(list));
        http.mockImplementationOnce(async request => {
            expect(new URL(String(request.url)).pathname).toBe('/v1/teams/identity/connections/settings/update');
            expect(JSON.parse(String(request.init.body))).toEqual({ v: 1, teamId: target.teamId, connectionId: target.connectionId,
                expectedRevision: 7, settings: { ...connection.settings, allowedUsers: ['bob'] } });
            return Response.json({ connection: { ...connection, revision: 8, settings: { ...connection.settings, allowedUsers: ['bob'] } } });
        });
        expect(await owner.execute('settings.set', { anchor: 'teams.identityConnection.allowedUsers', value: ['bob'], target }))
            .toEqual({ ok: true, result: { anchor: 'teams.identityConnection.allowedUsers', value: ['bob'] } });
        http.mockResolvedValueOnce(Response.json({ ...list, items: [] }));
        expect(await owner.execute('settings.set', { anchor: 'teams.identityConnection.allowedUsers', value: ['bob'], target }))
            .toMatchObject({ ok: false, errorCode: 'setting_target_unavailable' });
    });

    it('keeps accepted authentication under the Team policy CAS and nested caller grant', async () => {
        const owner = await harness();
        const target = { kind: 'team', serverId: owner.serverId, teamId: 'team-authentication' };
        const previous: TeamRestrictedAuthenticationPolicyV1 = { v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'github' }] };
        const team = teamSummaryFixture({ id: target.teamId, policy: teamPolicyFixture({ authenticationPolicy: previous }) });
        const accepted = [{ kind: 'team_connection', connectionId: 'connection-explicit' }];
        http.mockResolvedValueOnce(Response.json(team));
        http.mockImplementationOnce(async request => {
            expect(JSON.parse(String(request.init.body))).toEqual({ v: 1, teamId: target.teamId,
                authenticationPolicy: { v: 1, mode: 'restricted', accepted }, previousAuthenticationPolicy: previous });
            return Response.json({ ...team, policy: { ...team.policy, authenticationPolicy: { v: 1, mode: 'restricted', accepted } } });
        });
        expect(await owner.execute('settings.set', { anchor: 'teams.authentication.acceptedMethods', value: accepted, target }))
            .toEqual({ ok: true, result: { anchor: 'teams.authentication.acceptedMethods', value: accepted } });
        http.mockResolvedValueOnce(Response.json(team));
        expect(await owner.execute('settings.set', { anchor: 'teams.authentication.acceptedMethods', value: [], target }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        const writes = http.mock.calls.filter(([request]) => String(request.url).endsWith('/policy/set'));
        expect(writes).toHaveLength(1);
        expect(await owner.execute('settings.get', { anchor: 'teams.authentication.acceptedMethods', target }, {
            authority: 'account_automation', externalActionCredential: {
                accountId: 'account', principalId: 'principal', credentialId: 'credential',
                grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['settings.get'] } },
            },
        })).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        expect(http.mock.calls).toHaveLength(3);
    });
    it('uses the exact Home projection and its fresh revision without writing Account preferences', async () => {
        const owner = await harness();
        http.mockResolvedValueOnce(Response.json(projection()));
        expect(await owner.execute('settings.get', { anchor })).toEqual({ ok: true, result: { anchor, value: 600 } });
        http.mockResolvedValueOnce(Response.json(projection()));
        const listing = await owner.execute('settings.list', { pageId: 'homeAdministration' });
        expect(listing).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
            expect.objectContaining({ anchor, readable: true, writable: true }),
        ]) } });
        if (listing.ok && typeof listing.result === 'object' && listing.result && 'items' in listing.result
            && Array.isArray(listing.result.items)) {
            expect(listing.result.items.find(item => item.anchor === anchor)).not.toHaveProperty('storageScope');
        } else throw new Error('Home declaration list was not returned');
        http.mockResolvedValueOnce(Response.json(projection(650, 8)));
        http.mockImplementationOnce(async (request) => {
            expect(new URL(String(request.url)).origin).toBe('https://settings-home.example');
            expect(JSON.parse(String(request.init.body))).toEqual({ expectedRevision: 8, values: { [key]: 900 } });
            return Response.json(projection(900, 9));
        });
        expect(await owner.execute('settings.set', { anchor, value: 900 })).toEqual({ ok: true, result: { anchor, value: 900 } });
        http.mockResolvedValueOnce(Response.json(projection(900, 9)));
        http.mockImplementationOnce(async (request) => {
            expect(JSON.parse(String(request.init.body))).toEqual({ expectedRevision: 9, values: { [key]: null } });
            return Response.json(projection(600, 10));
        });
        expect(await owner.execute('settings.set', { anchor, value: null })).toEqual({ ok: true, result: { anchor, value: 600 } });
    });

    it('preserves Home approval even when the outer Settings write was already approved', async () => {
        const owner = await harness(true);
        http.mockResolvedValue(Response.json(projection()));
        const result = await owner.execute('settings.set', { anchor, value: 900 }, { bypassApprovals: true });
        expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(http.mock.calls.every(([request]) => !String(request.url).endsWith('/settings/set'))).toBe(true);
    });

    it('returns the incumbent Home approval artifact with the original request provenance and exact CAS intent', async () => {
        const requests: ApprovalRequest[] = [];
        // The persisted Artifact transport is a boundary; approval admission and origin construction stay real.
        const owner = await harness(true, async ({ request }) => {
            requests.push(request);
            return { artifactId: 'home-setting-approval' };
        });
        http.mockResolvedValue(Response.json(projection()));
        expect(await owner.execute('settings.set', { anchor, value: 900 }, {
            bypassApprovals: true, actionRequestId: 'original-settings-request', runtimeAccountId: 'other-account',
            serverId: 'other-focused-home',
            serverIdentityId: 'srv_settings_home',
        })).toEqual({ ok: true, result: { kind: 'approval_request_created', artifactId: 'home-setting-approval', actionId: 'home.settings.set' } });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            actionId: 'home.settings.set', actionArgs: { expectedRevision: 3, values: { [key]: 900 } },
            executionOriginV1: { surface: 'cli', authority: 'present_user', accountId: 'account',
                serverIdentityId: 'srv_settings_home', requestId: 'original-settings-request' },
        });
        expect(http.mock.calls.every(([request]) => !String(request.url).endsWith('/settings/set'))).toBe(true);
    });

    it('keeps deployment locks, strict values, Home refusals and Account retirement fail closed', async () => {
        const owner = await harness();
        http.mockResolvedValueOnce(Response.json(projection(600, 3, true)));
        expect(await owner.execute('settings.set', { anchor, value: 900 })).toMatchObject({ ok: false, errorCode: 'setting_read_only' });
        http.mockResolvedValueOnce(Response.json(projection()));
        expect(await owner.execute('settings.set', { anchor, value: '900' })).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        http.mockResolvedValueOnce(Response.json({ error: 'home_governance_forbidden' }, { status: 403 }));
        expect(await owner.execute('settings.get', { anchor })).toMatchObject({ ok: false, errorCode: 'home_governance_forbidden' });
        http.mockResolvedValueOnce(Response.json(projection()));
        http.mockResolvedValueOnce(Response.json({ error: 'home_settings_revision_conflict' }, { status: 409 }));
        expect(await owner.execute('settings.set', { anchor, value: 900 })).toMatchObject({ ok: false, errorCode: 'home_settings_revision_conflict' });
        const requestsBeforeSecret = http.mock.calls.length;
        expect(await owner.execute('settings.get', { anchor: 'homeAdministration.serverSettings.HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY' }))
            .toMatchObject({ ok: false, errorCode: 'setting_sensitive' });
        expect(http.mock.calls.length).toBe(requestsBeforeSecret);
        owner.retire();
        expect(await owner.execute('settings.get', { anchor })).toMatchObject({ ok: false, errorCode: 'setting_not_bound' });
    });

    it('retains autonomous caller admission and refuses a credential that grants only the outer Settings Action', async () => {
        const owner = await harness();
        http.mockResolvedValueOnce(Response.json(projection()));
        expect(await owner.execute('settings.get', { anchor }, { surface: 'agent', authority: 'account_automation',
            actionRequestId: 'original-settings-request' })).toEqual({ ok: true, result: { anchor, value: 600 } });
        const result = await owner.execute('settings.get', { anchor }, {
            authority: 'account_automation', externalActionCredential: {
                accountId: 'account', principalId: 'principal', credentialId: 'credential',
                grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['settings.get'] } },
            },
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        expect(http.mock.calls).toHaveLength(1);
    });

    it('keeps unrelated Account and local declarations usable when Home administration is forbidden', async () => {
        const owner = await harness();
        http.mockResolvedValueOnce(Response.json({ error: 'home_governance_forbidden' }, { status: 403 }));
        expect(await owner.execute('settings.list', {})).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
            expect.objectContaining({ anchor, readable: false, writable: false, unavailableReason: 'not_bound' }),
            expect.objectContaining({ anchor: 'appearance.themeMode', readable: true, writable: true, storageScope: 'local' }),
        ]) } });
    });
});
