import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();

beforeAll(async () => {
    // Load the real scoped store once; repeated graph transforms obscure the
    // HTTP contract and can outlive a test while the shared VM is busy.
    await loadSyncSingletonForTests();
}, 600_000);

const token = {
    tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d',
    label: 'CI deploy',
    displayPrefix: 'hap_v1_dd03e74b',
    createdAt: '2026-08-22T12:00:00.000Z',
    lastUsedAt: null,
    expiresAt: '2026-11-20T12:00:00.000Z',
    hasEncryptionAccess: false,
    hasUnattendedTeamAccess: false,
} as const;

const created = {
    token: `hap_v1_${token.tokenId}_${'A'.repeat(43)}`,
    apiToken: token,
} as const;

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

async function loadClient(params?: Readonly<{
    retireBeforeRequest?: boolean;
    credentialsError?: Error;
    responseForPath?: (path: string) => unknown;
    statusForPath?: (path: string) => number;
    throwForPath?: (path: string) => unknown;
}>) {
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `api-token-${crypto.randomUUID()}`);
    // A case that stages several clients staged the previous one's credential
    // store too; the real switch below consults it, so restore it first. The
    // Home is applied with an intact store and the store's behaviour under
    // test is installed afterwards, which is the real order of events.
    vi.restoreAllMocks();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const profile = await upsertAndActivateServer({ serverUrl: 'https://server.example', name: 'Token test Home' });
    // Apply the Home through the real connection owner rather than staging the
    // applied-runtime facts it publishes. The credential store is still empty
    // here, so this runs the genuine switch lifecycle without starting
    // authenticated Sync or issuing network requests — the same composition
    // `pendingQueueV2.testHelpers.ts#activatePendingQueueScope` relies on.
    const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await switchConnectionToActiveServer();
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().activateProfileScope({ serverId: profile.id, accountId: 'account-a' });
    const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    // The credential store and HTTP transport are persistent/network boundaries;
    // scope capture, credential parsing and request authority stay real.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async () => {
        if (params?.credentialsError) throw params.credentialsError;
        if (params?.retireBeforeRequest) retireActiveServerAccountScopeLifetime();
        return { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature` };
    });
    const transport = vi.fn(async (path: string, _init?: RequestInit) => {
        const thrown = params?.throwForPath?.(path);
        if (thrown !== undefined) throw thrown;
        const body = params?.responseForPath?.(path) ?? (
            path.endsWith('/create') ? created
                : path.endsWith('/list') ? { tokens: [token] }
                    : path.endsWith('/revoke-all') ? { revokedCount: 1 }
                        : { revoked: true }
        );
        return new Response(JSON.stringify(body), {
            status: params?.statusForPath?.(path) ?? 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        // Reachability probes are independent of the token endpoint response
        // under test, including deliberate endpoint validation failures.
        if (url.pathname === '/v1/auth/ping') {
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return await transport(`${url.pathname}${url.search}`, init);
    });
    const client = await import('./apiTokens');
    return {
        ...client,
        transport,
        retireScope: retireActiveServerAccountScopeLifetime,
        advanceGeneration: () => upsertAndActivateServer({ serverUrl: 'https://other.example' }),
    };
}

describe('current-Account API-token Action transport', () => {
    it('sends the complete optional encryption arm through the one create route and never retries', async () => {
        const input = {
            tokenId: token.tokenId,
            label: token.label,
            encryption: {
                access: {
                    v: 1 as const,
                    serverIdentityId: 'srv_home-identity',
                    contentPublicKey: Buffer.alloc(32, 1).toString('base64'),
                    wrappedContentPrivateKey: Buffer.alloc(72, 2).toString('base64url'),
                },
            },
        };
        const encryptedCreated = { ...created, apiToken: { ...created.apiToken, hasEncryptionAccess: true } };
        const client = await loadClient({ responseForPath: () => encryptedCreated });
        await expect(client.createCurrentAccountApiToken(input)).resolves.toEqual(encryptedCreated);
        expect(client.transport.mock.calls.map(([path, init]) => ({ path, body: JSON.parse(String(init?.body)) })))
            .toEqual([{ path: '/v1/auth/api-tokens/create', body: input }]);

        const rejected = await loadClient({
            statusForPath: () => 409,
            responseForPath: () => ({ error: 'api_token_encryption_not_ready' }),
        });
        await expect(rejected.createCurrentAccountApiToken(input)).resolves.toEqual({
            ok: false, errorCode: 'api_token_encryption_not_ready', error: 'api_token_encryption_not_ready',
        });
        expect(rejected.transport.mock.calls.map(([path]) => path)).toEqual(['/v1/auth/api-tokens/create']);

        const older = await loadClient({ statusForPath: () => 404, responseForPath: () => ({ error: 'Not Found' }) });
        await expect(older.createCurrentAccountApiToken(input)).resolves.toEqual({
            ok: false, errorCode: 'unsupported', error: 'unsupported',
        });
        expect(older.transport.mock.calls.map(([path]) => path)).toEqual(['/v1/auth/api-tokens/create']);
    });

    it('uses the one strict list route with required encryption metadata and no query or fallback', async () => {
        const listed = { tokens: [{ ...token, hasEncryptionAccess: true }] };
        const client = await loadClient({ responseForPath: () => listed });
        await expect(client.listCurrentAccountApiTokens({})).resolves.toEqual(listed);
        expect(client.transport.mock.calls[0]?.[0]).toBe('/v1/auth/api-tokens/list');
        expect(JSON.parse(String(client.transport.mock.calls[0]?.[1]?.body))).toEqual({});
        expect(client.transport).toHaveBeenCalledOnce();
    });

    it('reports an old Home that returns 501 as operation-scoped unsupported', async () => {
        const client = await loadClient({
            statusForPath: () => 501,
            responseForPath: () => ({ error: 'Not Implemented' }),
        });

        await expect(client.listCurrentAccountApiTokens({})).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported',
            error: 'unsupported',
        });
        expect(client.transport.mock.calls.map(([path]) => path)).toEqual(['/v1/auth/api-tokens/list']);
    });

    it('maps all four Action inputs to their scoped routes without an Account selector and preserves the one-time create bearer only in its result', async () => {
        const client = await loadClient();

        await expect(client.createCurrentAccountApiToken({ tokenId: token.tokenId, label: token.label, expiresAt: token.expiresAt }))
            .resolves.toEqual(created);
        await expect(client.listCurrentAccountApiTokens({})).resolves.toEqual({ tokens: [token] });
        await expect(client.revokeCurrentAccountApiToken({ tokenId: token.tokenId })).resolves.toEqual({ revoked: true });
        await expect(client.revokeAllCurrentAccountApiTokens({})).resolves.toEqual({ revokedCount: 1 });

        expect(client.transport.mock.calls.map(([path]) => path)).toEqual([
            '/v1/auth/api-tokens/create',
            '/v1/auth/api-tokens/list',
            '/v1/auth/api-tokens/revoke',
            '/v1/auth/api-tokens/revoke-all',
        ]);
        expect(client.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
            { tokenId: token.tokenId, label: token.label, expiresAt: token.expiresAt },
            {},
            { tokenId: token.tokenId },
            {},
        ]);
    });

    it('drops stale/currentness-invalid responses and rejects a list response that attempts to disclose a bearer', async () => {
        const retired = await loadClient({ retireBeforeRequest: true });
        await expect(retired.listCurrentAccountApiTokens({})).rejects.toThrow('account_api_tokens_unavailable');
        expect(retired.transport).not.toHaveBeenCalled();

        const malformed = await loadClient({
            responseForPath: (path) => path.endsWith('/list')
                ? { tokens: [{ ...token, token: created.token }] }
                : { tokens: [token] },
        });
        await expect(malformed.listCurrentAccountApiTokens({})).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_response',
            error: 'invalid_response',
        });
    });

    it('distinguishes pre-dispatch refusal from response loss after issuing every token mutation', async () => {
        const refused = await loadClient({ credentialsError: new Error('credential store unavailable') });
        await expect(refused.createCurrentAccountApiToken({ tokenId: token.tokenId, label: token.label })).resolves.toEqual({
            ok: false,
            errorCode: 'network_error',
            error: 'network_error',
        });
        expect(refused.transport).not.toHaveBeenCalled();

        const client = await loadClient({
            throwForPath: () => new Error('network down'),
        });

        await expect(client.listCurrentAccountApiTokens({})).resolves.toEqual({
            ok: false,
            errorCode: 'network_error',
            error: 'network_error',
        });
        await expect(client.createCurrentAccountApiToken({ tokenId: token.tokenId, label: token.label })).resolves.toEqual({
            ok: false,
            errorCode: 'outcome_unknown',
            error: 'outcome_unknown',
        });
        await expect(client.revokeCurrentAccountApiToken({ tokenId: token.tokenId })).resolves.toEqual({
            ok: false,
            errorCode: 'outcome_unknown',
            error: 'outcome_unknown',
        });
        await expect(client.revokeAllCurrentAccountApiTokens({})).resolves.toEqual({
            ok: false,
            errorCode: 'outcome_unknown',
            error: 'outcome_unknown',
        });
    });

    it.each([
        [400, 'invalid_request'],
        [403, 'present_user_required'],
        [403, 'account-disabled'],
        [409, 'api_token_id_conflict'],
    ] as const)('preserves a canonical %s non-success server response as a typed Action failure', async (status, errorCode) => {
        const client = await loadClient({
            responseForPath: () => ({ error: errorCode }),
            statusForPath: () => status,
        });

        await expect(client.createCurrentAccountApiToken({ tokenId: token.tokenId, label: token.label, expiresAt: token.expiresAt }))
            .resolves.toEqual({ ok: false, errorCode, error: errorCode });
    });
});
