import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    HomeGovernanceProjectionV1Schema,
    NO_HOME_CAPABILITIES_V1,
    type HomeGovernanceProjectionV1,
} from '@happier-dev/protocol/home/governance';
import {
    ManagedGitHubAppErrorCodeV1Schema,
    SavedSecretResourceEnvelopeCensusResponseV1Schema,
} from '@happier-dev/protocol';

const serverFetchMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchMock,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchMock,
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    // The barrel imports runtime consumers of tokenStorage while this mock is
    // still being initialized, deadlocking module collection.
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal: importOriginal as <T = typeof import('@/auth/storage/tokenStorage')>() => Promise<T>,
        tokenStorage: { getCredentialsForServerUrl: getCredentialsForServerUrlMock },
    });
});

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { requestHomeDomain } from './homeServerActionTransport';

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function projection(): HomeGovernanceProjectionV1 {
    return {
        viewer: { accountId: 'account', homeRole: 'owner', status: 'active' },
        capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
        policy: {
            revision: 3,
            teamCreationPolicy: 'managed_only',
            authentication: { status: 'inherited' },
        },
        authenticationOptions: {
            methods: [],
            permittedAccountModes: ['e2ee'],
            recommendedProvisioningMode: 'e2ee',
            signInService: { deploymentMode: null, canDisable: false },
        },
        setupState: 'owned',
        activeOwnerCount: 1,
        teamsEnabled: true,
    };
}

async function addHome(name: string, serverUrl: string): Promise<string> {
    return (await upsertServerProfile({ serverUrl, name })).id;
}

async function focusHome(serverId: string): Promise<void> {
    await setActiveServerId(serverId, { scope: 'device' });
}

/**
 * A plain Home credential. Governance administration is not Account-encrypted,
 * so the token-only credential is the real shape this path carries; no
 * encryption material is fabricated to make the transport resolve.
 */
function plainCredentialsFor(sub: string): void {
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub(sub) });
}

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), { status });
}

function requestedUrls(): string[] {
    return runtimeFetchMock.mock.calls.map(([input]) => String(input?.url ?? ''));
}

function governanceRequest(serverId: string, accountId = 'account') {
    return requestHomeDomain({
        scope: createServerAccountScope(serverId, accountId)!,
        path: '/v1/home/governance/get',
        effect: 'read',
        input: {},
        schema: HomeGovernanceProjectionV1Schema,
    });
}

beforeEach(() => {
    serverFetchMock.mockReset();
    runtimeFetchMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('requestHomeDomain', () => {
    it('posts the declared input to the exact Home path and parses the strict domain result', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        runtimeFetchMock.mockResolvedValue(jsonResponse(projection(), 200));

        const result = await governanceRequest(homeA);

        expect(result).toEqual({ ok: true, value: projection() });
        const call = runtimeFetchMock.mock.calls[0]?.[0];
        expect(call?.url).toBe('https://home-a.example/v1/home/governance/get');
        expect(call?.init?.method).toBe('POST');
        expect(JSON.parse(call?.init?.body ?? 'null')).toEqual({});
        // The explicit-Home authority carried it, not the focused-Home fetch.
        expect(serverFetchMock).not.toHaveBeenCalled();
    });

    it('reads first and next Saved Secret envelope-census pages through encoded GET queries without bodies', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        const resourceId = 'resource/a +&';
        const firstPage = SavedSecretResourceEnvelopeCensusResponseV1Schema.parse({
            resourceId, revision: 3,
            recipients: [{
                account: { kind: 'account', accountId: 'account-b', firstName: 'Bob', lastName: null, username: null, avatarUrl: null },
                readiness: { status: 'unavailable', reason: 'plain_account' },
                envelopeStatus: 'missing',
            }],
            nextCursor: 'cursor/ +?=',
        });
        const nextPage = SavedSecretResourceEnvelopeCensusResponseV1Schema.parse({
            resourceId, revision: 3,
            recipients: [{
                account: { kind: 'account', accountId: 'account-c', firstName: 'Carol', lastName: null, username: null, avatarUrl: null },
                readiness: { status: 'unavailable', reason: 'encryption_setup_required' },
                envelopeStatus: 'missing',
            }],
            nextCursor: null,
        });
        runtimeFetchMock.mockResolvedValueOnce(jsonResponse(firstPage, 200));
        runtimeFetchMock.mockResolvedValueOnce(jsonResponse(nextPage, 200));

        // Exercise the actual operation and its HTTP binding, not an internal transport double.
        const { readSavedSecretResourceRecipientReadiness } = await import('@/sync/ops/settings/savedSecretResourceOperations');
        const result = await readSavedSecretResourceRecipientReadiness({
            scope: createServerAccountScope(homeA, 'account')!,
            resourceId,
        });

        expect(result).toEqual({ ok: true, revision: 3, recipients: [...firstPage.recipients, ...nextPage.recipients] });
        const firstRequest = runtimeFetchMock.mock.calls[0]?.[0];
        const nextRequest = runtimeFetchMock.mock.calls[1]?.[0];
        expect(firstRequest?.url).toBe('https://home-a.example/v1/account/saved-secrets/resources/envelope-census?resourceId=resource%2Fa+%2B%26&limit=100');
        expect(nextRequest?.url).toBe('https://home-a.example/v1/account/saved-secrets/resources/envelope-census?resourceId=resource%2Fa+%2B%26&cursor=cursor%2F+%2B%3F%3D&limit=100');
        expect(firstRequest?.init?.method).toBe('GET');
        expect(nextRequest?.init?.method).toBe('GET');
        expect(firstRequest?.init?.body).toBeUndefined();
        expect(nextRequest?.init?.body).toBeUndefined();
        expect(serverFetchMock).not.toHaveBeenCalled();
    });

    it('completes against the Home it captured even when focus moves to another Home first', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        const homeB = await addHome('Home B', 'https://home-b.example');
        await focusHome(homeA);
        plainCredentialsFor('account');

        let releaseResponse: (() => void) | null = null;
        runtimeFetchMock.mockImplementation(async () => {
            await new Promise<void>((resolve) => {
                releaseResponse = resolve;
            });
            return jsonResponse(projection(), 200);
        });

        const pending = governanceRequest(homeA);

        // Focus moves while the request is in flight; the captured Home wins.
        await vi.waitFor(() => expect(releaseResponse).not.toBeNull());
        await focusHome(homeB);
        releaseResponse!();

        await expect(pending).resolves.toEqual({ ok: true, value: projection() });
        expect(requestedUrls().every((url) => url.startsWith('https://home-a.example'))).toBe(true);
        expect(requestedUrls().some((url) => url.startsWith('https://home-b.example'))).toBe(false);
    });

    it('fails closed without issuing a request when the credential authenticates another Account', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('someone-else');

        const result = await governanceRequest(homeA);

        expect(result.ok).toBe(false);
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(serverFetchMock).not.toHaveBeenCalled();
    });

    it('distinguishes a mutation response loss after dispatch from a safe read retry', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        runtimeFetchMock.mockImplementation(async (params) => {
            params.onIssued?.();
            throw Object.assign(new Error('connection reset after dispatch'), { code: 'ECONNRESET' });
        });

        const mutation = await requestHomeDomain({
            scope: createServerAccountScope(homeA, 'account')!,
            path: '/v1/home/policy/set',
            input: { teamCreationPolicy: 'managed_only', expectedRevision: 3 },
            schema: HomeGovernanceProjectionV1Schema,
            effect: 'write',
        });
        const read = await governanceRequest(homeA);

        expect(mutation).toEqual({
            ok: false,
            failure: { kind: 'outcome_unknown', retryable: false, code: null },
        });
        expect(read).toEqual({
            ok: false,
            failure: { kind: 'unreachable', retryable: true, code: null },
        });

        runtimeFetchMock.mockImplementation(async (params) => {
            params.onIssued?.();
            throw Object.assign(new Error('connection refused before dispatch'), { code: 'ECONNREFUSED' });
        });

        await expect(requestHomeDomain({
            scope: createServerAccountScope(homeA, 'account')!,
            path: '/v1/home/policy/set',
            input: { teamCreationPolicy: 'managed_only', expectedRevision: 3 },
            schema: HomeGovernanceProjectionV1Schema,
            effect: 'write',
        })).resolves.toEqual({
            ok: false,
            failure: { kind: 'unreachable', retryable: true, code: null },
        });
    });

    it('keeps a mutation retryable when exact-Home authority fails before dispatch', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('someone-else');

        const result = await requestHomeDomain({
            scope: createServerAccountScope(homeA, 'account')!,
            path: '/v1/home/policy/set',
            input: { teamCreationPolicy: 'managed_only', expectedRevision: 3 },
            schema: HomeGovernanceProjectionV1Schema,
            effect: 'write',
        });

        expect(result).toEqual({
            ok: false,
            failure: { kind: 'unreachable', retryable: true, code: null },
        });
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('reports the Home typed denial without retry advice', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        runtimeFetchMock.mockResolvedValue(jsonResponse({ error: 'home_governance_forbidden' }, 403));

        await expect(governanceRequest(homeA)).resolves.toEqual({
            ok: false,
            failure: {
                kind: 'forbidden',
                retryable: false,
                code: 'home_governance_forbidden',
                details: { error: 'home_governance_forbidden' },
            },
        });
    });

    it('reports a Home without the operation as unsupported rather than as a denial', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        runtimeFetchMock.mockResolvedValue(new Response('', { status: 404 }));

        await expect(governanceRequest(homeA)).resolves.toEqual({
            ok: false,
            failure: { kind: 'unsupported', retryable: false, code: null },
        });
    });

    it('reports a rejected credential as unauthorized', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        runtimeFetchMock.mockResolvedValue(new Response('', { status: 401 }));

        await expect(governanceRequest(homeA)).resolves.toEqual({
            ok: false,
            failure: { kind: 'unauthorized', retryable: false, code: null },
        });
    });

    it('preserves the typed conflict code so the editor can reload and resubmit', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        runtimeFetchMock.mockResolvedValue(jsonResponse({ error: 'home_policy_revision_conflict' }, 409));

        const result = await requestHomeDomain({
            scope: createServerAccountScope(homeA, 'account')!,
            path: '/v1/home/policy/set',
            effect: 'write',
            input: { teamCreationPolicy: 'self_service', expectedRevision: 2 },
            schema: HomeGovernanceProjectionV1Schema,
        });

        expect(result).toEqual({
            ok: false,
            failure: {
                kind: 'conflict',
                retryable: false,
                code: 'home_policy_revision_conflict',
                details: { error: 'home_policy_revision_conflict' },
            },
        });
    });

    it('uses a domain family error schema without teaching the transport its codes', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        runtimeFetchMock.mockResolvedValue(jsonResponse({ error: 'github_app_revision_conflict' }, 409));

        const result = await requestHomeDomain({
            scope: createServerAccountScope(homeA, 'account')!,
            path: '/v1/identity/github-apps/remove',
            effect: 'write',
            input: { owner: { kind: 'home' }, installationId: 'installation-1', expectedRevision: 1 },
            schema: HomeGovernanceProjectionV1Schema,
            errorSchema: ManagedGitHubAppErrorCodeV1Schema,
        });

        expect(result).toEqual({
            ok: false,
            failure: {
                kind: 'conflict',
                retryable: false,
                code: 'github_app_revision_conflict',
                details: { error: 'github_app_revision_conflict' },
            },
        });
    });

    it('keeps an erasure blocked by encryption cleanup retryable', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        runtimeFetchMock.mockResolvedValue(jsonResponse({ error: 'account_erasure_transition_cleanup_pending' }, 409));

        const result = await requestHomeDomain({
            scope: createServerAccountScope(homeA, 'account')!,
            path: '/v1/home/accounts/delete',
            effect: 'write',
            input: { accountId: 'target' },
            schema: HomeGovernanceProjectionV1Schema,
        });

        expect(result).toEqual({
            ok: false,
            failure: {
                kind: 'conflict',
                retryable: true,
                code: 'account_erasure_transition_cleanup_pending',
                details: { error: 'account_erasure_transition_cleanup_pending' },
            },
        });
    });

    it('preserves a typed Team code so a Team surface can explain the refusal', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        // The Home family carries Team intents too. Dropping the Team vocabulary
        // would leave a join or invite surface unable to distinguish "archived"
        // from "not allowed" and force it to invent a second interpretation.
        runtimeFetchMock.mockResolvedValue(jsonResponse({ error: 'invitation_not_active' }, 409));

        await expect(governanceRequest(homeA)).resolves.toEqual({
            ok: false,
            failure: {
                kind: 'conflict',
                retryable: false,
                code: 'invitation_not_active',
                details: { error: 'invitation_not_active' },
            },
        });
    });

    it('preserves the canonical bounded recovery details instead of flattening them to a code', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        const details = {
            v: 1,
            code: 'provider_endpoint_rate_limited',
            retryable: true,
            retryAfterMs: 1_500,
            action: 'retry',
        } as const;
        runtimeFetchMock.mockResolvedValue(jsonResponse(details, 429));

        await expect(governanceRequest(homeA)).resolves.toEqual({
            ok: false,
            failure: {
                kind: 'unknown',
                retryable: true,
                code: 'provider_endpoint_rate_limited',
                details,
            },
        });
    });

    it('treats an unreachable Home as retryable and publishes no value', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        runtimeFetchMock.mockRejectedValue(new Error('network down'));

        await expect(governanceRequest(homeA)).resolves.toEqual({
            ok: false,
            failure: { kind: 'unreachable', retryable: true, code: null },
        });
    });

    it('rejects a body the strict domain schema does not accept instead of publishing it', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await focusHome(homeA);
        plainCredentialsFor('account');
        runtimeFetchMock.mockResolvedValue(jsonResponse(
            { ...projection(), unexpectedTopLevelField: true },
            200,
        ));

        await expect(governanceRequest(homeA)).resolves.toEqual({
            ok: false,
            failure: { kind: 'invalid', retryable: false, code: null },
        });
    });
});
