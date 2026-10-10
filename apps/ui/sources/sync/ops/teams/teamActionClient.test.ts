import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const serverFetchMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());

/**
 * The front door captures the Account context before it dispatches, and that
 * capture uses its own endpoint-bound request rather than the reachability
 * fetch these tests drive. Answering it here keeps this suite about the Team
 * Action contract while leaving `runtimeFetchMock` free to control the timing
 * of the Team call itself, which the focus-switch test depends on.
 */
vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchMock,
    createServerFetchAtEndpoint: () => async (path: string) => {
        if (path.startsWith('/v1/account/encryption')) {
            return new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }), { status: 200 });
        }
        if (path.startsWith('/v2/account/settings')) {
            return new Response(JSON.stringify({ content: null, version: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    },
}));

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
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { listTeamCredentialDirectMaterialPreparation } from './teamCredentialOperations';

import {
    resetTeamActionClientForTests,
    runTeamAction,
} from './teamActionClient';

import {
    homeDomainFailureCode,
    homeDomainFailureFromActionFailure,
} from '@/sync/api/home/homeDomainActions';

const PageSchema = z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullable() });

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), { status });
}

beforeEach(() => {
    serverFetchMock.mockReset();
    runtimeFetchMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account') });
    resetTeamActionClientForTests();
});

afterEach(() => {
    resetTeamActionClientForTests();
    vi.clearAllMocks();
});

describe('runTeamAction', () => {
    it('checks credential preparation through the registered read Action without requesting the recipient census', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-a.example', name: 'A' })).id;
        await setActiveServerId(serverId, { scope: 'device' });
        const observation = { status: 'not_ready', reason: 'preparation_pending', counts: { ready: 2, pending: 1 } };
        runtimeFetchMock.mockResolvedValue(json(observation));
        const outcome = await listTeamCredentialDirectMaterialPreparation({
            scope: createServerAccountScope(serverId, 'account')!, teamId: 'team /1', resourceId: 'resource?/1',
        });
        expect(outcome).toEqual({ kind: 'succeeded', value: observation });
        expect(runtimeFetchMock.mock.calls.map(([input]) => String(input?.url))).toEqual([
            'https://home-a.example/v2/teams/team%20%2F1/credential-resources/resource%3F%2F1/direct-material?view=readiness',
        ]);
    });
    it('carries a Team intent to the path its Action row declares, naming no path itself', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-a.example', name: 'A' })).id;
        await setActiveServerId(serverId, { scope: 'device' });
        runtimeFetchMock.mockResolvedValue(json({ items: [], nextCursor: null }));

        const outcome = await runTeamAction({
            scope: createServerAccountScope(serverId, 'account')!,
            actionId: 'teams.groups.list',
            input: { v: 1, teamId: 'team-1', archived: 'active' },
            parse: (value) => PageSchema.parse(value),
        });

        expect(outcome.kind).toBe('succeeded');
        // The path came from the registered row through the shared front door,
        // not from any table in the Team wrappers.
        expect(String(runtimeFetchMock.mock.calls[0]?.[0]?.url))
            .toBe('https://home-a.example/v1/teams/groups/list');
    });

    it('completes against the Home it captured even when focus moves first', async () => {
        const homeA = (await upsertServerProfile({ serverUrl: 'https://home-a.example', name: 'A' })).id;
        const homeB = (await upsertServerProfile({ serverUrl: 'https://home-b.example', name: 'B' })).id;
        await setActiveServerId(homeA, { scope: 'device' });

        let release: (() => void) | null = null;
        runtimeFetchMock.mockImplementation(async () => {
            await new Promise<void>((resolve) => { release = resolve; });
            return json({ items: [], nextCursor: null });
        });

        const pending = runTeamAction({
            scope: createServerAccountScope(homeA, 'account')!,
            actionId: 'teams.groups.list',
            input: { v: 1, teamId: 'team-1', archived: 'active' },
            parse: (value) => PageSchema.parse(value),
        });

        await vi.waitFor(() => expect(release).not.toBeNull());
        // The person focuses another Home while the mutation is in flight. The
        // executor's default Home port would follow them; a Team screen must not.
        await setActiveServerId(homeB, { scope: 'device' });
        release!();

        await expect(pending).resolves.toMatchObject({ kind: 'succeeded' });
        const urls = runtimeFetchMock.mock.calls.map(([input]) => String(input?.url ?? ''));
        expect(urls.every((url) => url.startsWith('https://home-a.example'))).toBe(true);
        expect(urls.some((url) => url.startsWith('https://home-b.example'))).toBe(false);
    });

    it('addresses two Homes independently rather than sharing one bound port', async () => {
        const homeA = (await upsertServerProfile({ serverUrl: 'https://home-a.example', name: 'A' })).id;
        const homeB = (await upsertServerProfile({ serverUrl: 'https://home-b.example', name: 'B' })).id;
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockResolvedValue(json({ items: [], nextCursor: null }));

        const input = { v: 1, teamId: 'team-1', archived: 'active' } as const;
        await runTeamAction({
            scope: createServerAccountScope(homeA, 'account')!,
            actionId: 'teams.groups.list',
            input,
            parse: (value) => PageSchema.parse(value),
        });
        await runTeamAction({
            scope: createServerAccountScope(homeB, 'account')!,
            actionId: 'teams.groups.list',
            input,
            parse: (value) => PageSchema.parse(value),
        });

        const urls = runtimeFetchMock.mock.calls.map(([entry]) => String(entry?.url ?? ''));
        expect(urls[0]).toBe('https://home-a.example/v1/teams/groups/list');
        expect(urls[1]).toBe('https://home-b.example/v1/teams/groups/list');
    });

    it('reports a Home refusal in the vocabulary the Team surfaces already speak', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-c.example', name: 'C' })).id;
        await setActiveServerId(serverId, { scope: 'device' });
        runtimeFetchMock.mockResolvedValue(json({}, 403));

        const outcome = await runTeamAction({
            scope: createServerAccountScope(serverId, 'account')!,
            actionId: 'teams.groups.list',
            input: { v: 1, teamId: 'team-1', archived: 'active' },
            parse: (value) => PageSchema.parse(value),
        });

        expect(outcome).toMatchObject({
            kind: 'failed',
            failure: { kind: 'forbidden', retryable: false },
        });
    });

    it('preserves an issued mutation whose outcome cannot be confirmed', async () => {
        const serverId = (await upsertServerProfile({ serverUrl: 'https://home-d.example', name: 'D' })).id;
        await setActiveServerId(serverId, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async (request) => {
            request.onIssued?.();
            throw Object.assign(new Error('connection reset after dispatch'), { code: 'ECONNRESET' });
        });

        const outcome = await runTeamAction({
            scope: createServerAccountScope(serverId, 'account')!,
            actionId: 'teams.update',
            input: { v: 1, teamId: 'team-1', name: 'Platform' },
            parse: (value) => value,
        });

        expect(outcome).toEqual({
            kind: 'failed',
            failure: { kind: 'outcome_unknown', retryable: false, code: null },
        });
    });

});

describe('Home domain Action failure decoding', () => {
    it('inverts the family port encoding without inventing a second vocabulary', () => {
        expect(homeDomainFailureFromActionFailure({ errorCode: 'home_unreachable' }))
            .toEqual({ kind: 'unreachable', retryable: true, code: null });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'home_conflict' }))
            .toEqual({ kind: 'conflict', retryable: false, code: null });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'unsupported_action:teams.archive' }))
            .toEqual({ kind: 'unsupported', retryable: false, code: null });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'outcome_unknown' }))
            .toEqual({ kind: 'outcome_unknown', retryable: false, code: null });
    });

    it('projects transport outcomes to stable consumer codes without flattening ambiguity', () => {
        expect(homeDomainFailureCode({ kind: 'outcome_unknown', retryable: false, code: null }))
            .toBe('outcome_unknown');
        expect(homeDomainFailureCode({ kind: 'unreachable', retryable: true, code: null }))
            .toBe('home_unreachable');
        expect(homeDomainFailureCode({ kind: 'forbidden', retryable: false, code: 'group_name_taken' }))
            .toBe('group_name_taken');
    });

    it('preserves a code the Home itself named rather than flattening it', () => {
        // The Home's own code is the most precise explanation available, so a
        // surface keeps the ability to explain the real refusal.
        expect(homeDomainFailureFromActionFailure({ errorCode: 'group_name_taken' }))
            .toEqual({ kind: 'conflict', retryable: false, code: 'group_name_taken' });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'home_policy_invalid' }))
            .toEqual({ kind: 'invalid', retryable: false, code: 'home_policy_invalid' });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'home_account_not_found' }))
            .toEqual({ kind: 'unsupported', retryable: false, code: 'home_account_not_found' });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'home_policy_revision_conflict' }))
            .toEqual({ kind: 'conflict', retryable: false, code: 'home_policy_revision_conflict' });
    });

    it('preserves only canonical details that match the Action failure code', () => {
        const details = {
            v: 1,
            code: 'provider_endpoint_rate_limited',
            retryable: true,
            retryAfterMs: 1_500,
            action: 'retry',
        } as const;

        expect(homeDomainFailureFromActionFailure({
            errorCode: 'provider_endpoint_rate_limited',
            details,
        })).toEqual({
            kind: 'unknown',
            retryable: true,
            code: 'provider_endpoint_rate_limited',
            details,
        });

        expect(homeDomainFailureFromActionFailure({
            errorCode: 'provider_endpoint_unavailable',
            details,
        })).toEqual({ kind: 'unknown', retryable: false, code: null });
        expect(homeDomainFailureFromActionFailure({
            errorCode: 'provider_endpoint_rate_limited',
            details: { code: 'provider_endpoint_rate_limited', bearer: 'must-not-pass' },
        })).toEqual({ kind: 'unknown', retryable: false, code: null });

        const authenticationDetails = {
            error: 'team_authentication_policy_unavailable',
            details: { reason: 'provider_test_required' },
        } as const;
        expect(homeDomainFailureFromActionFailure({
            errorCode: 'team_authentication_policy_unavailable',
            details: authenticationDetails,
        })).toEqual({
            kind: 'conflict',
            retryable: false,
            code: 'team_authentication_policy_unavailable',
            details: authenticationDetails,
        });
    });
});
