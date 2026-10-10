import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';

beforeAll(loadSyncSingletonForTests);

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetRuntimeFetch();
});

async function setup() {
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `follow-${crypto.randomUUID()}`);
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    const active = await upsertAndActivateServer({ serverUrl: 'https://active.example', name: 'Active' });
    // A selected profile alone is not a published Home lifetime. Apply the
    // real signed-out connection before hydrating its Account projection.
    await switchConnectionToActiveServer();
    const target = await upsertServerProfile({ serverUrl: 'https://target.example', name: 'Target' });
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().activateProfileScope({ serverId: active.id, accountId: 'active-account' });
    const token = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    // Persistent credentials and the network are the only replaced boundaries.
    const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url) => ({
        token: token(url === 'https://target.example' ? 'target-account' : 'active-account'),
    }));
    const request = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response(JSON.stringify({ sources: [] }), { status: 200 }));
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        return request(String(url), init);
    });
    return { target, request, credentials, token, storage, active, TokenStorage };
}

describe('Follow exact Home Action transport', () => {
    it('edits declared auto-follow defaults on the captured Home without Account or device writes', async () => {
        const env = await setup();
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { createSettingsDeclarationAction } = await import('@/sync/ops/actions/settingsDeclarationAction');
        const { createSettingsOwnerActionExecutor } = await import('@/sync/ops/actions/settingsOwnerActionExecutor');
        const { sessionFollowAction } = await import('./sessionFollowApi');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
        let current = true;
        let requireApproval = false;
        let executor: ReturnType<typeof createActionExecutor>;
        const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: env.target.id };
        const unused = async () => { throw new Error('unexpected unrelated transport or preference write'); };
        const settingsDeclarationAction = createSettingsDeclarationAction({
            host: { os: 'ios', desktop: false }, tauriDesktop: false, readPageGate: () => undefined,
            isFeatureEnabled: async () => true, isCurrent: () => current,
            readAccountSettings: async () => settingsDefaults, readLocalSettings: () => localSettingsDefaults,
            writeAccountSettings: unused, mutateAccountSettings: unused, writeLocalSettings: () => { throw new Error('unexpected local preference write'); },
            mutationServices: { executeSettingsOwnerAction: createSettingsOwnerActionExecutor(
                request => executor.execute(request.actionId, request.input, request.context),
                { serverId: env.target.id, accountId: 'target-account',
                    assertCurrent: () => { if (!current) throw new Error('Account retired'); } },
            ) },
        });
        executor = createActionExecutor({ settingsDeclarationAction, sessionFollowAction,
            isActionApprovalRequired: id => requireApproval && id === 'session.follow.preferences.set',
            executionRunStart: unused, executionRunList: unused, executionRunGet: unused, detachedExecutionRunSend: unused,
            executionRunStop: unused, executionRunAction: unused, executionRunWait: unused, sessionOpen: unused,
            sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused, pathsListRecent: unused,
            machinesList: unused, serversList: unused, reviewEnginesList: unused, agentsBackendsList: unused,
            agentsModelsList: unused, sessionSendMessage: unused, sessionModeSet: unused, sessionModesList: unused,
            sessionList: unused, sessionActivityGet: unused, sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: unused,
            daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
        });
        let preferences = { assigned: false, direct: true, team: false, group: true };
        env.request.mockImplementation(async (url, init) => {
            expect(new URL(url).origin).toBe('https://target.example');
            expect(new URL(url).pathname).toBe('/v2/account/session-follow-preferences');
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${env.token('target-account')}`);
            if (init?.method === 'PUT') preferences = JSON.parse(String(init.body));
            return Response.json(preferences);
        });
        const listing = await executor.execute('settings.list', { pageId: 'notifications' }, context);
        expect(listing).toMatchObject({ ok: true, result: { items: expect.arrayContaining(
            ['Assigned', 'Direct', 'Team', 'Group'].map(field => expect.objectContaining({ anchor: `notifications.autoFollow${field}`, readable: true, writable: true })),
        ) } });
        // The focused Home and caller-supplied scope cannot redirect the captured owner.
        expect(await executor.execute('settings.get', { anchor: 'notifications.autoFollowAssigned' }, {
            ...context, serverId: env.active.id, runtimeAccountId: 'active-account', expectedAccountId: 'active-account',
        }))
            .toEqual({ ok: true, result: { anchor: 'notifications.autoFollowAssigned', value: false } });
        expect(await executor.execute('settings.set', { anchor: 'notifications.autoFollowAssigned', value: true }, context))
            .toEqual({ ok: true, result: { anchor: 'notifications.autoFollowAssigned', value: true } });
        expect(preferences).toEqual({ assigned: true, direct: true, team: false, group: true });
        requireApproval = true;
        expect(await executor.execute('settings.set', { anchor: 'notifications.autoFollowTeam', value: true }, { ...context, bypassApprovals: true }))
            .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(preferences.team).toBe(false);
        current = false;
        expect(await executor.execute('settings.get', { anchor: 'notifications.autoFollowGroup' }, context)).toMatchObject({ ok: false, errorCode: 'setting_not_bound' });
    });

    it('lists sources on the requested Home with its credential even while another Home is focused', async () => {
        const env = await setup();
        const { listSessionFollowSources } = await import('./sessionFollowSourcesApi');
        const result = await listSessionFollowSources({ serverId: env.target.id, sessionId: 'same/id' });
        expect(result).toEqual({ kind: 'ok', value: { sources: [] } });
        const call = env.request.mock.calls.find(([url]) => url.includes('/follows/sessions'));
        expect(call?.[0]).toBe('https://target.example/v2/sessions/same%2Fid/follows/sessions');
        expect(new Headers(call?.[1]?.headers).get('Authorization')).toBe(`Bearer ${env.token('target-account')}`);
    });

    it('executes Account preferences and source mutations through their strict domain resources', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        const sources = await import('./sessionFollowSourcesApi');
        const address = { serverId: env.target.id, sessionId: 'same/id' } satisfies SessionAddress;
        const preferences = { assigned: false, direct: true, team: false, group: true };
        const follow = { sessionId: address.sessionId, following: true, notificationLevel: 'none', includeInVoice: true };
        const source = { sourceSessionId: 'source/id', destinationSessionId: address.sessionId, mode: 'next_turn', deliveryState: 'eligible', hasPendingUpdates: false };
        env.request.mockImplementation(async (url, init) => {
            const value = url.endsWith('session-follow-preferences') ? preferences
                : init?.method === 'DELETE' ? { changed: false }
                    : url.includes('/follows/sessions/') ? { changed: true, source }
                        : init?.method === 'PUT' ? { changed: true, follow, voiceInitialSnapshotPending: true }
                            : { follow: null, isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false };
            return new Response(JSON.stringify(value), { status: 200 });
        });
        await expect(api.sessionFollowGet(address)).resolves.toEqual({ kind: 'ok', value: { follow: null, isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false } });
        await expect(api.sessionFollowSet(address, { notificationLevel: 'none', includeInVoice: true })).resolves.toEqual({ kind: 'ok', value: { changed: true, follow, voiceInitialSnapshotPending: true } });
        await expect(api.sessionFollowRemove(address)).resolves.toEqual({ kind: 'ok', value: { changed: false } });
        await expect(api.sessionAutoFollowPreferencesGet(env.target.id)).resolves.toEqual({ kind: 'ok', value: preferences });
        await expect(api.sessionAutoFollowPreferencesSet(env.target.id, preferences)).resolves.toEqual({ kind: 'ok', value: preferences });
        const pair = { serverId: env.target.id, destinationSessionId: address.sessionId, sourceSessionId: 'source/id' };
        await expect(sources.setSessionFollowSource(pair)).resolves.toEqual({ kind: 'ok', value: { changed: true, source } });
        await expect(sources.removeSessionFollowSource(pair)).resolves.toEqual({ kind: 'ok', value: { changed: false } });
        const requests = env.request.mock.calls.filter(([url]) => url.includes('follow'));
        expect(requests.map(([url, init]) => [new URL(url).origin, init?.method, init?.body ? JSON.parse(String(init.body)) : null])).toEqual([
            ['https://target.example', 'GET', null],
            ['https://target.example', 'PUT', { notificationLevel: 'none', includeInVoice: true }],
            ['https://target.example', 'DELETE', null],
            ['https://target.example', 'GET', null],
            ['https://target.example', 'PUT', preferences],
            ['https://target.example', 'PUT', {}],
            ['https://target.example', 'DELETE', null],
        ]);
    });

    it('rejects a response after the UI Account retires and never redirects the write to the new Home', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        env.request.mockImplementation(async () => {
            retireActiveServerAccountScopeLifetime();
            return new Response(JSON.stringify({ changed: true }), { status: 200 });
        });
        await expect(api.sessionFollowRemove({ serverId: env.target.id, sessionId: 'same' })).resolves.toEqual({ kind: 'failed', error: 'unavailable' });
        expect(env.request.mock.calls.filter(([url]) => url.includes('/follow')).map(([url]) => new URL(url).origin)).toEqual(['https://target.example']);
    });

    it('preserves domain failures but rejects malformed projections and unsupported Account error codes', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        const address = { serverId: env.target.id, sessionId: 'same' };
        env.request.mockImplementation(async () => new Response(JSON.stringify({ error: 'session_archived' }), { status: 409 }));
        await expect(api.sessionFollowSet(address, { notificationLevel: 'important', includeInVoice: false })).resolves.toEqual({ kind: 'failed', error: 'session_archived' });
        env.request.mockImplementation(async () => new Response(JSON.stringify({ changed: true, frontier: 'private' }), { status: 200 }));
        await expect(api.sessionFollowRemove(address)).resolves.toEqual({ kind: 'failed', error: 'unavailable' });
        env.request.mockImplementation(async () => new Response(JSON.stringify({ error: 'session_follow_source_forbidden' }), { status: 403 }));
        await expect(api.sessionFollowGet(address)).resolves.toEqual({ kind: 'failed', error: 'unavailable' });
    });

    it('cancels on a credential change at an inactive target Home', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        env.request.mockImplementation(async () => {
            await env.TokenStorage.setCredentialsForServerUrl('https://target.example', { serverId: env.target.id }, { token: env.token('new-target-account') });
            return new Response(JSON.stringify({ changed: true }), { status: 200 });
        });
        await expect(api.sessionFollowRemove({ serverId: env.target.id, sessionId: 'same' })).resolves.toEqual({ kind: 'failed', error: 'unavailable' });
    });

    it('cancels a delayed Voice inclusion replacement when the target Home credential changes', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        let releaseResponse!: (response: Response) => void;
        const responseReady = new Promise<Response>((resolve) => { releaseResponse = resolve; });
        env.request.mockImplementation(async () => responseReady);

        const operation = api.replaceSessionVoiceInclusions(env.target.id, ['same']);
        await Promise.resolve();
        await env.TokenStorage.setCredentialsForServerUrl(
            'https://target.example',
            { serverId: env.target.id },
            { token: env.token('new-target-account') },
        );
        releaseResponse(new Response(JSON.stringify({ changed: true, sessionIds: ['same'] }), { status: 200 }));

        await expect(operation).resolves.toEqual({ kind: 'failed', error: 'unavailable' });
    });

    it('rejects a saved projection for a different Session', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        env.request.mockImplementation(async () => new Response(JSON.stringify({ changed: true, follow: {
            sessionId: 'other', following: true, notificationLevel: 'none', includeInVoice: true,
        } }), { status: 200 }));
        await expect(api.sessionFollowSet({ serverId: env.target.id, sessionId: 'same' }, {
            notificationLevel: 'none', includeInVoice: true,
        })).resolves.toEqual({ kind: 'failed', error: 'unavailable' });
    });

    it('executes the public Account Action through the real family adapter and preserves its result envelope', async () => {
        const env = await setup();
        const { sessionFollowAction } = await import('./sessionFollowApi');
        const { createActionExecutor } = await import('@happier-dev/protocol');
        const preferences = { assigned: true, direct: false, team: false, group: false };
        env.request.mockImplementation(async () => new Response(JSON.stringify(preferences), { status: 200 }));
        // Unrelated required ports are never reached by this Account Action.
        const executor = createActionExecutor({ sessionFollowAction } as unknown as import('@happier-dev/protocol').ActionExecutorDeps);
        await expect(executor.execute('session.follow.preferences.get', {}, {
            surface: 'ui', authority: 'present_user', serverId: env.target.id, actionCaller: { kind: 'host' },
        })).resolves.toEqual({ ok: true, result: preferences });
    });
});
