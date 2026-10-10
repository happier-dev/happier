import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_HOME_CAPABILITIES_V1 } from '@happier-dev/protocol/home/governance';

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
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: { getCredentialsForServerUrl: getCredentialsForServerUrlMock },
    });
});

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

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
    return {
        viewer: { accountId: 'account', homeRole: 'owner', status: 'active' },
        capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
        policy: { revision: 3, teamCreationPolicy: 'managed_only', authentication: { status: 'inherited' } },
        setupState: 'owned',
        activeOwnerCount: 1,
        teamsEnabled: true,
        authenticationOptions: {
            methods: [],
            permittedAccountModes: ['e2ee'],
            recommendedProvisioningMode: 'e2ee',
            signInService: { deploymentMode: null, canDisable: false },
        },
    };
}

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), { status });
}

async function scopeForNewHome(serverUrl: string) {
    const serverId = (await upsertServerProfile({ serverUrl, name: serverUrl })).id;
    await setActiveServerId(serverId, { scope: 'device' });
    return { serverId, scope: createServerAccountScope(serverId, 'account')! };
}

beforeEach(() => {
    serverFetchMock.mockReset();
    runtimeFetchMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account') });
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('createHomeDomainActionExecutorForScope', () => {
    it.each([
        { status: 404, error: 'Session not found or not owned by user', code: 'session_absent' },
        { status: 409, error: 'Session delete condition was lost', code: 'session_delete_conflict' },
    ])('retains deletion refusal $code and its exact Home payload', async ({ status, error, code }) => {
        const { scope } = await scopeForNewHome('https://delete-home.example');
        runtimeFetchMock.mockResolvedValue(jsonResponse({ error }, status));
        const result = await createHomeDomainActionExecutorForScope(scope)({ actionId: 'session.delete',
            input: { sessionId: 'session' }, context: { surface: 'ui', authority: 'present_user' } });
        expect(result).toEqual({ ok: false, errorCode: code, error: code, details: { error } });
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
            params.onIssued?.();
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
            details: { error: 'home_governance_forbidden' },
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
            details,
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
        });
    });

    it('fails closed without issuing a request when the credential authenticates another Account', async () => {
        const { scope } = await scopeForNewHome('https://home-d.example');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('someone-else') });

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
