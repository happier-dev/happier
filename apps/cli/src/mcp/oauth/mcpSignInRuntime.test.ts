import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { ConnectedAccountRequestAuthMaterializationV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
import type { HostConnectedAccountAuthenticationContext } from '@/plugins/runtime/connectedAccounts/hostRuntime';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createConnectedAccountConfigurationOwner, type ConnectedAccountConfigurationRecord } from '@happier-dev/cli-common/connectedAccounts';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

const cleanups: Array<() => Promise<void>> = [];
const networkFetch = globalThis.fetch;
afterEach(async () => {
    try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
    finally { vi.restoreAllMocks(); }
});

async function authorizationServer(options: Readonly<{
    metadata?: Readonly<Record<string, unknown>>;
    challenge?: string;
    oauthMissing?: boolean;
    oidcPath?: string;
    tokenStatus?: number;
    tokenError?: string;
    tokenOverrides?: Readonly<Record<string, unknown>>;
    tokenRedirect?: string;
    headerPrmStatus?: number;
    pathPrmStatus?: number;
    assignedClientAuthMethod?: string;
    prmResource?: string;
    tokenHold?: boolean;
    resourceSuffix?: string;
    probeSse?: boolean;
    onRequest?: (path: string) => void;
    httpResource?: boolean;
    insecureEndpoint?: 'metadata' | 'issuer' | 'authorization' | 'token' | 'registration' | 'revocation';
}> = {}) {
    const requests: Array<{ path: string; body: string; authorization: string | undefined }> = [];
    const fetches: string[] = [];
    let base = '';
    let physicalBase = '';
    let insecureBase = '';
    let resource = '';
    let tokenCount = 0;
    let tokenOverrides = options.tokenOverrides;
    let metadataOverrides = options.metadata;
    let tokenStatus = options.tokenStatus;
    const endpoint = (path: string, kind: typeof options.insecureEndpoint) => `${options.insecureEndpoint === kind ? insecureBase : base}${path}`;
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        const path = request.url ?? '';
        requests.push({ path, body, authorization: request.headers.authorization });
        options.onRequest?.(path);
        response.setHeader('content-type', 'application/json');
        if (path === '/mcp') {
            if (options.probeSse) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': keepalive\n\n'); return; }
            response.writeHead(401, { 'www-authenticate': options.challenge ?? `Bearer resource_metadata="${options.insecureEndpoint === 'metadata' ? `${insecureBase}/prm` : new URL('/prm', resource).href}", scope="read"` });
            response.end('{}');
        } else if (path === '/prm' || path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource') {
            const status = path === '/prm' ? options.headerPrmStatus : path === '/.well-known/oauth-protected-resource/mcp' ? options.pathPrmStatus : undefined;
            if (status) { response.writeHead(status); response.end('{}'); return; }
            response.end(JSON.stringify({ resource: options.prmResource ?? resource, authorization_servers: [endpoint('/issuer', 'issuer')], scopes_supported: ['ignored'] }));
        } else if (path === '/.well-known/oauth-authorization-server/issuer' && !options.oauthMissing || path === options.oidcPath) {
            response.end(JSON.stringify({ issuer: endpoint('/issuer', 'issuer'), authorization_endpoint: endpoint('/authorize', 'authorization'), token_endpoint: endpoint('/token', 'token'), registration_endpoint: endpoint('/register', 'registration'), revocation_endpoint: endpoint('/revoke', 'revocation'), response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'], authorization_response_iss_parameter_supported: true, jwks_uri: `${base}/jwks`, subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], ...metadataOverrides }));
        } else if (path === '/register') {
            response.end(JSON.stringify({ ...JSON.parse(body), client_id: 'fixture-client', client_secret: 'registration-secret', ...(options.assignedClientAuthMethod ? { token_endpoint_auth_method: options.assignedClientAuthMethod } : {}) }));
        } else if (path === '/token') {
            if (options.tokenHold) return;
            if (options.tokenRedirect) { response.writeHead(307, { location: options.tokenRedirect }); response.end('{}'); return; }
            if (tokenStatus) { response.writeHead(tokenStatus); response.end(JSON.stringify({ error: options.tokenError ?? 'invalid_grant', error_description: 'private authorization-code registration-secret' })); return; }
            tokenCount += 1;
            response.end(JSON.stringify({ access_token: `access-${tokenCount}`, refresh_token: `refresh-${tokenCount}`, token_type: 'Bearer', expires_in: 3600, scope: 'read', ...tokenOverrides }));
        } else if (path === '/revoke') {
            response.end('{}');
        } else {
            response.writeHead(404); response.end('{}');
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    physicalBase = `http://127.0.0.1:${address.port}`;
    base = `https://authorization-${address.port}.fixture.test`;
    insecureBase = `http://authorization-${address.port}.fixture.test`;
    resource = options.httpResource ? `${physicalBase}/mcp` : `https://resource-${address.port}.fixture.test/mcp`;
    const resourceOrigin = new URL(resource).origin;
    // The fixture's network boundary maps logical HTTPS audiences and AS
    // endpoints to its real local HTTP server. This is not a production TLS
    // exemption; actual HTTPS bridge transport has its separate TLS fixture.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const requested = typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url);
        fetches.push(requested.href);
        if (requested.origin === base || requested.origin === insecureBase || !options.httpResource && requested.origin === resourceOrigin) {
            return networkFetch(new URL(`${requested.pathname}${requested.search}`, physicalBase), init);
        }
        return networkFetch(input, init);
    });
    cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    return { base, insecureBase, resource, resourceOrigin, requests, fetches,
        setTokenOverrides(value: Readonly<Record<string, unknown>>) { tokenOverrides = value; },
        setMetadataOverrides(value: Readonly<Record<string, unknown>>) { metadataOverrides = value; },
        setTokenStatus(value?: number) { tokenStatus = value; },
    };
}

async function registeredRuntime() {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p7a-mcp-oauth-'));
    cleanups.push(() => rm(happyHomeDir, { recursive: true, force: true }));
    const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes: createResolvedContributionRegistry({}) });
    cleanups.push(async () => { await registry.dispose(); });
    const lease = await registry.resolveConnectedAccountRuntime?.(HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1);
    expect(lease, 'Built-in MCP sign-in must be reachable through the executable registry').not.toBeNull();
    if (!lease || lease.owner !== 'host') throw new Error('Missing built-in MCP sign-in runtime');
    return lease;
}

describe('MCP server sign-in runtime', () => {
    async function begin(options: Parameters<typeof authorizationServer>[0] = {}, values: Readonly<Record<string, JsonValue>> = {}, controller = new AbortController(), secretValues: Readonly<Record<string, string>> = {}, existingFixture?: Awaited<ReturnType<typeof authorizationServer>>) {
        const fixture = existingFixture ?? await authorizationServer(options);
        const lease = await registeredRuntime();
        const mode = lease.runtime.authentication.modes.oauth;
        if (mode.kind !== 'oauthAuthorizationCode') throw new Error('Missing OAuth implementation');
        const entries = new Map<string, string>();
        const descriptor = lease.descriptor.authentication.modes.find(candidate => candidate.id === 'oauth');
        if (!descriptor) throw new Error('Missing OAuth descriptor');
        const record = { revision: 'r1', values: { serverId: 'server-a', resource: `${fixture.resource}${options?.resourceSuffix ?? ''}`, ...values }, secretRefs: {}, secretValues };
        const configurationOwner = createConnectedAccountConfigurationOwner({
            read: async () => record,
            replace: async () => { throw new Error('Staging must not write before settlement'); },
            destroyAttempt: async () => {},
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            isRuntimeCurrent: () => lease.isCurrent(),
        });
        const admission = await configurationOwner.admit({ intent: 'connect', service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1,
            mode: descriptor, attemptId: 'attempt-failure', occurrenceId: lease.occurrenceId, sourceCustody: lease.sourceCustody });
        if (admission.status !== 'ready') throw new Error('Missing admitted OAuth configuration');
        const staged: { content: Omit<ConnectedAccountConfigurationRecord, 'revision'> | null } = { content: null };
        const context: HostConnectedAccountAuthenticationContext = {
            service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, attempt: { kind: 'connect', attemptId: 'attempt-failure' },
            configuration: admission.snapshot,
            attemptCredentials: { get: async key => entries.get(key) ?? null, set: async (key, value) => { entries.set(key, value); }, delete: async key => { entries.delete(key); } },
            signal: controller.signal, invokedAtMs: Date.now(), stageAccountConfiguration: async replacement => {
                staged.content = await configurationOwner.stageAccountConfiguration({ snapshot: admission.snapshot, replacement });
            },
        };
        const result = await mode.begin({ callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', state: 'attempt-failure.state', pkce: { challenge: 'canonical-challenge', method: 'S256' } }, context);
        return { fixture, lease, mode, context, result, entries, controller, staged };
    }

    it('prefers client metadata and unions challenge, granted and step-up scopes', async () => {
        const { result, fixture, staged, mode, context } = await begin({ metadata: { client_id_metadata_document_supported: true }, tokenOverrides: { scope: undefined } }, { stepUp: true, grantedScopes: ['existing', 'read'], stepUpScopes: ['write'] });
        if (result.status !== 'awaitingOAuthRedirect') throw new Error('Authorization unavailable');
        const url = new URL(result.authorizationUrl);
        expect(url.searchParams.get('client_id')).toBe('https://app.happier.dev/oauth/mcp/client-metadata.json');
        expect(new Set(url.searchParams.get('scope')!.split(' '))).toEqual(new Set(['read', 'existing', 'write']));
        expect(fixture.requests.some(request => request.path === '/register')).toBe(false);
        expect(staged.content?.values).toMatchObject({ stepUp: false, stepUpScopes: [] });
        await expect(mode.complete({ code: 'code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', state: 'attempt-failure.state', pkceVerifier: 'verifier' }, context))
            .resolves.toMatchObject({ status: 'connected', scopes: ['read', 'existing', 'write'] });
    });

    it.each(['none', 'client_secret_basic', 'client_secret_post'] as const)('accepts a supplied app without CIMD or DCR using %s', async method => {
        const confidential = method !== 'none';
        const clientSecret = confidential ? randomBytes(24).toString('base64url') : undefined;
        const supplied = { clientId: 'person-app', ...(clientSecret ? { clientSecret } : {}) };
        const options = { metadata: {
            registration_endpoint: undefined, token_endpoint_auth_methods_supported: [method],
        } };
        const refused = await begin(options);
        expect(refused.result).toMatchObject({ status: 'rejected', diagnostic: { code: 'client_refused' } });
        const { fixture, mode, context, result, staged } = await begin(options, {}, new AbortController(),
            { clientRegistration: JSON.stringify(supplied) }, refused.fixture);
        expect(result.status).toBe('awaitingOAuthRedirect');
        if (result.status !== 'awaitingOAuthRedirect') return;
        expect(new URL(result.authorizationUrl).searchParams.get('client_id')).toBe(supplied.clientId);
        expect(fixture.requests.some(request => request.path === '/register')).toBe(false);
        expect(staged.content?.values.registrations).toMatchObject({ [fixture.base + '/issuer']: {
            clientId: supplied.clientId, clientAuthMethod: method,
        } });
        expect('clientRegistration' in (staged.content?.secretValues ?? {})).toBe(false);
        expect(JSON.parse(staged.content?.secretValues?.clientSecrets ?? '{}')[fixture.base + '/issuer'] === clientSecret).toBe(true);
        const completion = await mode.complete({ code: 'code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback',
            state: 'attempt-failure.state', pkceVerifier: 'verifier' }, context);
        expect(completion.status).toBe('connected');
        const request = fixture.requests.find(candidate => candidate.path === '/token');
        expect(request !== undefined).toBe(true);
        const body = new URLSearchParams(request?.body);
        expect(method === 'client_secret_basic'
            ? request?.authorization === `Basic ${Buffer.from(`${supplied.clientId}:${clientSecret}`).toString('base64')}`
            : body.get('client_id') === supplied.clientId && body.get('client_secret') === (clientSecret ?? null)).toBe(true);
    });

    it('uses CIMD instead of a supplied confidential app', async () => {
        const clientSecret = randomBytes(24).toString('base64url');
        const { result, staged } = await begin({ metadata: { client_id_metadata_document_supported: true } }, {},
            new AbortController(), { clientRegistration: JSON.stringify({ clientId: 'unused-app', clientSecret }) });
        expect(result.status).toBe('awaitingOAuthRedirect');
        if (result.status !== 'awaitingOAuthRedirect') return;
        expect(new URL(result.authorizationUrl).searchParams.get('client_id')).toBe('https://app.happier.dev/oauth/mcp/client-metadata.json');
        expect(JSON.stringify(staged.content).includes(clientSecret)).toBe(false);
    });

    it.each([false, true])('replaces a saved app without retaining its previous authentication kind (confidential=%s)', async confidential => {
        const options = { metadata: { registration_endpoint: undefined, token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'] } };
        const initial = { clientId: 'person-app', ...(!confidential ? { clientSecret: randomBytes(24).toString('base64url') } : {}) };
        const first = await begin(options, {}, new AbortController(), { clientRegistration: JSON.stringify(initial) });
        if (!first.staged.content) throw new Error('No staged app configuration');
        const replacement = { clientId: initial.clientId, ...(confidential ? { clientSecret: randomBytes(24).toString('base64url') } : {}) };
        const next = await begin(options, first.staged.content.values, new AbortController(),
            { ...first.staged.content.secretValues, clientRegistration: JSON.stringify(replacement) }, first.fixture);
        expect(next.result.status).toBe('awaitingOAuthRedirect');
        expect(next.staged.content?.values.registrations).toMatchObject({ [first.fixture.base + '/issuer']: {
            clientAuthMethod: confidential ? 'client_secret_basic' : 'none',
        } });
        const savedSecrets = JSON.parse(next.staged.content?.secretValues?.clientSecrets ?? '{}');
        expect(savedSecrets[first.fixture.base + '/issuer'] === replacement.clientSecret).toBe(true);
    });

    it('reports invalid_client without exposing the authorization-server error', async () => {
        const { mode, context } = await begin({ tokenStatus: 401, tokenError: 'invalid_client' });
        const result = await mode.complete({ code: 'code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback',
            state: 'attempt-failure.state', pkceVerifier: 'verifier' }, context);
        expect(result).toEqual({ status: 'rejected', diagnostic: { code: 'invalid_client', severity: 'error' } });
    });

    it('refuses an unusable HTTP OAuth resource before probing, registering or staging', async () => {
        const { result, fixture, staged, entries, mode, context } = await begin({ httpResource: true });
        const completion = await mode.complete({ code: 'http-code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback',
            state: 'attempt-failure.state', pkceVerifier: 'http-verifier' }, context);
        expect(result).toMatchObject({ status: 'rejected', diagnostic: { code: 'mcp_oauth_resource_requires_https' } });
        expect(completion).toMatchObject({ status: 'rejected', diagnostic: { code: 'mcp_oauth_resource_requires_https' } });
        expect(fixture.requests).toEqual([]);
        expect(staged.content).toBeNull();
        expect(entries.size).toBe(0);
    });

    it.each(['metadata', 'issuer', 'authorization', 'registration'] as const)('refuses a non-loopback HTTP %s endpoint before fetching it, registering, staging or publishing a browser URL', async insecureEndpoint => {
        const { result, fixture, staged, entries } = await begin({ insecureEndpoint });
        expect(result).toMatchObject({ status: 'rejected', diagnostic: { code: 'mcp_oauth_endpoints_require_https' } });
        expect(fixture.fetches.some(url => url.startsWith(fixture.insecureBase))).toBe(false);
        expect(fixture.requests.some(request => request.path === '/register')).toBe(false);
        expect(staged.content).toBeNull();
        expect(entries.size).toBe(0);
    });

    it('refuses a non-loopback HTTP token endpoint before transmitting code, verifier or client secret', async () => {
        const { result, fixture, mode, context, entries } = await begin({ insecureEndpoint: 'token' });
        expect(result.status).toBe('awaitingOAuthRedirect');
        const completion = await mode.complete({ code: 'private-code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback',
            state: 'attempt-failure.state', pkceVerifier: 'private-verifier' }, context);
        expect(completion).toMatchObject({ status: 'rejected', diagnostic: { code: 'mcp_oauth_endpoints_require_https' } });
        expect(fixture.fetches.some(url => url.startsWith(fixture.insecureBase))).toBe(false);
        expect(fixture.requests.some(request => request.path === '/token')).toBe(false);
        expect(entries.has('accessToken')).toBe(false);
        expect(JSON.stringify(completion)).not.toMatch(/private-code|private-verifier|registration-secret/);
    });

    it('refuses stored non-loopback HTTP refresh and revocation endpoints before disclosing or changing credentials', async () => {
        const { result, fixture, mode, context, entries, staged, lease } = await begin();
        expect(result.status).toBe('awaitingOAuthRedirect');
        await expect(mode.complete({ code: 'code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback',
            state: 'attempt-failure.state', pkceVerifier: 'verifier' }, context)).resolves.toMatchObject({ status: 'connected' });
        const priorCredentials = [...entries];
        const priorFetches = [...fixture.fetches];
        const issuer = `${fixture.base}/issuer`;
        const configuration = { ...context.configuration, values: { ...staged.content!.values,
            registrations: { [issuer]: { clientId: 'fixture-client', authorizationEndpoint: `${fixture.base}/authorize`,
                tokenEndpoint: `${fixture.insecureBase}/token`, revocationEndpoint: `${fixture.insecureBase}/revoke`,
                tokenEndpointAuthMethods: ['client_secret_post'] } } },
            getSecret: async (key: string) => staged.content!.secretValues?.[key] ?? null };
        const established = { account: { service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, accountId: 'server-a' },
            configuration, credentials: context.attemptCredentials, signal: context.signal, invokedAtMs: context.invokedAtMs };
        await expect(lease.runtime.refresh({ ...established, stagedCredentials: context.attemptCredentials,
            operation: { operationId: 'refresh-http', configurationRevision: configuration.revision } }))
            .resolves.toMatchObject({ status: 'reconnectRequired', diagnostic: { code: 'mcp_oauth_endpoints_require_https' } });
        await expect(lease.runtime.revoke(established))
            .resolves.toMatchObject({ status: 'outcomeUnknown', diagnostic: { code: 'mcp_oauth_endpoints_require_https' } });
        expect(fixture.fetches).toEqual(priorFetches);
        expect([...entries]).toEqual(priorCredentials);
    });

    it.each([
        { metadata: { code_challenge_methods_supported: undefined } },
        { metadata: { code_challenge_methods_supported: ['plain'] } },
        { metadata: { issuer: 'https://different-issuer.example' } },
        { metadata: { registration_endpoint: undefined } },
        { metadata: { authorization_response_iss_parameter_supported: 'true' } },
    ])('refuses unsafe or unregistrable discovery before any registration or token exchange: %j', async options => {
        const { result, fixture } = await begin(options);
        expect(result.status).toBe('rejected');
        expect(fixture.requests.filter(request => request.path === '/token' || request.path === '/register')).toEqual([]);
    });

    it.each(['/.well-known/openid-configuration/issuer', '/issuer/.well-known/openid-configuration'])('uses SDK OIDC fallback and retains its raw RFC9207 flag: %s', async oidcPath => {
        const { result } = await begin({ oauthMissing: true, oidcPath, challenge: 'Bearer scope="read"' });
        expect(result).toMatchObject({ status: 'awaitingOAuthRedirect', issuerResponseParameterRequired: true });
    });

    it.each([429, 503])('preserves uncertain exchange outcome without exposing OAuth secrets on HTTP %i', async tokenStatus => {
        const { mode, context, result } = await begin({ tokenStatus });
        expect(result.status).toBe('awaitingOAuthRedirect');
        const completion = await mode.complete({ code: 'authorization-code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', state: 'attempt-failure.state', pkceVerifier: 'verifier' }, context);
        expect(completion.status).toBe('outcomeUnknown');
        expect(JSON.stringify(completion)).not.toMatch(/authorization-code|registration-secret/);
    });

    it('erases canceled attempt metadata and cannot exchange the canceled authorization code', async () => {
        const { mode, context, fixture } = await begin();
        await mode.cancel(context);
        await expect(mode.complete({ code: 'authorization-code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', state: 'attempt-failure.state', pkceVerifier: 'verifier' }, context)).resolves.toMatchObject({ status: 'rejected' });
        expect(fixture.requests.some(request => request.path === '/token')).toBe(false);
    });

    it('does not forward exchange credentials across a redirect', async () => {
        const destination = await authorizationServer();
        const { mode, context } = await begin({ tokenRedirect: `${destination.base}/token` });
        await expect(mode.complete({ code: 'authorization-code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', state: 'attempt-failure.state', pkceVerifier: 'verifier' }, context)).resolves.toMatchObject({ status: 'outcomeUnknown' });
        expect(destination.requests).toEqual([]);
    });

    it('aborts an in-flight exchange without publishing partial credentials', async () => {
        const { mode, context, fixture, controller, entries } = await begin({ tokenHold: true });
        const completion = mode.complete({ code: 'authorization-code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', state: 'attempt-failure.state', pkceVerifier: 'verifier' }, context);
        const rejection = expect(completion).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(fixture.requests.some(request => request.path === '/token')).toBe(true));
        controller.abort();
        await rejection;
        expect(entries.has('accessToken')).toBe(false);
    });

    it('refuses an unsupported token scheme before publishing grant credentials', async () => {
        const { mode, context, entries } = await begin({ tokenOverrides: { token_type: 'DPoP' } });
        await expect(mode.complete({ code: 'code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', state: 'attempt-failure.state', pkceVerifier: 'verifier' }, context))
            .resolves.toMatchObject({ status: 'rejected' });
        expect(entries.has('accessToken')).toBe(false);
    });

    it('continues metadata discovery without consuming a successful streaming resource probe', async () => {
        const observed: string[] = [];
        const controller = new AbortController();
        const outcome = begin({ probeSse: true, onRequest: path => observed.push(path) }, {}, controller).catch(error => ({ error }));
        try {
            await vi.waitFor(() => expect(observed).toContain('/.well-known/oauth-protected-resource/mcp'));
            await expect(outcome).resolves.toMatchObject({ result: { status: 'awaitingOAuthRedirect' } });
        } finally { controller.abort(); await outcome; }
    });

    it.each(['#different', '?api_key=private-key'])('rejects unsafe resource identity before probing the server: %s', async resourceSuffix => {
        const { result, fixture } = await begin({ resourceSuffix });
        expect(result.status).toBe('rejected');
        expect(fixture.requests).toEqual([]);
    });

    it('falls back from absent header metadata through path-inserted metadata to root metadata', async () => {
        const { result, fixture } = await begin({ headerPrmStatus: 404, pathPrmStatus: 404 });
        expect(result.status).toBe('awaitingOAuthRedirect');
        expect(fixture.requests.filter(request => request.path.includes('protected-resource') || request.path === '/prm').map(request => request.path))
            .toEqual(['/prm', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']);
    });

    it('does not fall back around unavailable header metadata authority', async () => {
        const { result, fixture } = await begin({ headerPrmStatus: 503 });
        expect(result.status).not.toBe('awaitingOAuthRedirect');
        expect(fixture.requests.some(request => request.path.includes('well-known'))).toBe(false);
    });

    it('honors the DCR-assigned client authentication method when the server advertises several', async () => {
        const { mode, context, fixture } = await begin({ assignedClientAuthMethod: 'client_secret_post', metadata: { token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] } });
        await expect(mode.complete({ code: 'authorization-code', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', state: 'attempt-failure.state', pkceVerifier: 'verifier' }, context)).resolves.toMatchObject({ status: 'connected' });
        expect(Object.fromEntries(new URLSearchParams(fixture.requests.find(request => request.path === '/token')!.body))).toMatchObject({ client_id: 'fixture-client', client_secret: 'registration-secret' });
    });

    it('rejects protected resource metadata naming a different resource before using its issuer', async () => {
        const { result, fixture } = await begin({ prmResource: 'https://another-resource.example/mcp' });
        expect(result.status).toBe('rejected');
        expect(fixture.requests.some(request => request.path.includes('authorization-server') || request.path === '/register')).toBe(false);
    });

    it('registers, exchanges, refreshes and revokes through the admitted host runtime without publishing tokens in configuration', async () => {
        const fixture = await authorizationServer({ assignedClientAuthMethod: 'client_secret_post', metadata: {
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
        } });
        const lease = await registeredRuntime();
        const mode = lease.descriptor.authentication.modes.find(candidate => candidate.kind === 'oauthAuthorizationCode');
        if (!mode) throw new Error('Missing OAuth descriptor');
        const nativeMode = lease.runtime.authentication.modes[mode.id];
        if (nativeMode.kind !== 'oauthAuthorizationCode') throw new Error('Missing OAuth implementation');
        const service = HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1;
        const target = { kind: 'attempt' as const, service, attemptId: 'attempt-mcp', modeId: mode.id };
        const configurationStorage: { record: ConnectedAccountConfigurationRecord | null } = { record: null };
        const staged: { content: Omit<ConnectedAccountConfigurationRecord, 'revision'> | null } = { content: null };
        const configurationOwner = createConnectedAccountConfigurationOwner({
            read: async () => configurationStorage.record,
            replace: async (input) => {
                configurationStorage.record = { ...input.replacement, revision: 'configuration-1' };
                return { status: 'committed', record: configurationStorage.record };
            },
            destroyAttempt: async () => {},
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            isRuntimeCurrent: () => lease.isCurrent(),
        });
        await configurationOwner.replace({ target, mode, expectedRevision: null,
            replacement: { values: { serverId: 'server-a', resource: fixture.resource }, secretRefs: {} },
            occurrenceId: lease.occurrenceId, sourceCustody: lease.sourceCustody });
        const admitted = await configurationOwner.admit({ intent: 'connect', service, mode, attemptId: target.attemptId,
            occurrenceId: lease.occurrenceId, sourceCustody: lease.sourceCustody });
        if (admitted.status !== 'ready') throw new Error('Missing admitted configuration');
        const credentials = new Map<string, string>();
        const store = {
            get: async (key: string) => credentials.get(key) ?? null,
            set: async (key: string, value: string) => { credentials.set(key, value); },
            delete: async (key: string) => { credentials.delete(key); },
        };
        const context: HostConnectedAccountAuthenticationContext = {
            service, attempt: { kind: 'connect', attemptId: target.attemptId },
            configuration: admitted.snapshot, attemptCredentials: store, signal: new AbortController().signal,
            invokedAtMs: Date.now(),
            async stageAccountConfiguration(replacement) {
                staged.content = await configurationOwner.stageAccountConfiguration({ snapshot: admitted.snapshot, replacement });
            },
        };
        const started = await nativeMode.begin({ callbackUrl: mode.callbackUrl!, state: 'attempt-mcp.state', pkce: { challenge: 'sealed-challenge', method: 'S256' } }, context);
        expect(started).toMatchObject({ status: 'awaitingOAuthRedirect', issuer: `${fixture.base}/issuer`, issuerResponseParameterRequired: true });
        if (started.status !== 'awaitingOAuthRedirect') throw new Error('Authorization was not started');
        const url = new URL(started.authorizationUrl);
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'fixture-client', resource: fixture.resource, code_challenge: 'sealed-challenge', scope: 'read', state: 'attempt-mcp.state' });
        expect(JSON.parse(fixture.requests.find(request => request.path === '/register')!.body)).toMatchObject({ application_type: 'native', redirect_uris: ['https://app.happier.dev/oauth/mcp/callback'] });
        expect(JSON.stringify(staged.content?.values)).not.toContain('registration-secret');
        expect(staged.content?.secretValues).toBeDefined();
        await expect(nativeMode.complete({ code: 'authorization-code', callbackUrl: mode.callbackUrl!, state: 'attempt-mcp.state', pkceVerifier: 'sealed-verifier' }, context))
            .resolves.toMatchObject({ status: 'connected', accountId: 'server-a', scopes: ['read'] });
        expect(credentials.get('accessToken')).toBe('access-1');
        expect(credentials.get('refreshToken')).toBe('refresh-1');
        expect([...credentials.values()].some(value => value.includes('fixture-client'))).toBe(false);
        const configuration = { ...admitted.snapshot, values: staged.content!.values,
            getSecret: async (key: string) => staged.content!.secretValues?.[key] ?? null };
        const established = { account: { service, accountId: 'server-a' }, configuration,
            credentials: store, signal: context.signal, invokedAtMs: Date.now() };
        const initialExpiry = credentials.get('expiresAtMs')!;
        credentials.set('expiresAtMs', '0');
        await expect(lease.runtime.status(established)).resolves.toMatchObject({ status: 'expired' });
        credentials.delete('refreshToken');
        await expect(lease.runtime.status(established)).resolves.toMatchObject({ status: 'reconnectRequired' });
        credentials.set('refreshToken', 'refresh-1');
        credentials.set('expiresAtMs', initialExpiry);
        fixture.setTokenOverrides({ refresh_token: undefined, scope: undefined });
        await expect(lease.runtime.refresh({ ...established, operation: { operationId: 'refresh-1', configurationRevision: configuration.revision }, stagedCredentials: store }))
            .resolves.toMatchObject({ status: 'connected' });
        expect(credentials.get('accessToken')).toBe('access-2');
        expect(credentials.get('refreshToken')).toBe('refresh-1');
        expect(JSON.parse(credentials.get('scopes')!)).toEqual(['read']);
        await expect(lease.runtime.refresh({ ...established, operation: { operationId: 'refresh-2', configurationRevision: configuration.revision }, stagedCredentials: store }))
            .resolves.toMatchObject({ status: 'connected', scopes: ['read'] });
        expect(credentials.get('refreshToken')).toBe('refresh-1');
        expect(fixture.requests.filter(request => request.path === '/prm')).toHaveLength(1);
        const tokenRequests = fixture.requests.filter(request => request.path === '/token').map(request => Object.fromEntries(new URLSearchParams(request.body)));
        expect(tokenRequests).toEqual([
            expect.objectContaining({ resource: fixture.resource, code_verifier: 'sealed-verifier' }),
            expect.objectContaining({ resource: fixture.resource, refresh_token: 'refresh-1' }),
            expect.objectContaining({ resource: fixture.resource, refresh_token: 'refresh-1' }),
        ]);
        const requestAuthMaterialization = ConnectedAccountRequestAuthMaterializationV1Schema.parse({ kind: 'httpHeaders', origin: fixture.resourceOrigin, headerNames: ['authorization'] });
        await expect(lease.runtime.materialize(requestAuthMaterialization, established))
            .resolves.toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer access-3' } });
        await expect(lease.runtime.materialize({ kind: 'httpHeaders', origin: 'https://another.example', headerNames: ['authorization'] }, established)).rejects.toThrow();
        fixture.setTokenStatus(503);
        const uncertainRefresh = await lease.runtime.refresh({ ...established,
            operation: { operationId: 'refresh-uncertain', configurationRevision: configuration.revision }, stagedCredentials: store });
        expect(uncertainRefresh.status).toBe('outcomeUnknown');
        expect(JSON.stringify(uncertainRefresh)).not.toContain('registration-secret');
        expect(credentials.get('accessToken')).toBe('access-3');
        fixture.setTokenStatus(400);
        await expect(lease.runtime.refresh({ ...established,
            operation: { operationId: 'refresh-rejected', configurationRevision: configuration.revision }, stagedCredentials: store }))
            .resolves.toMatchObject({ status: 'reconnectRequired' });
        expect(credentials.get('accessToken')).toBe('access-3');
        fixture.setTokenStatus();
        await expect(lease.runtime.revoke(established)).resolves.toMatchObject({ status: 'remoteRevoked' });
        expect(fixture.requests.some(request => request.path === '/revoke')).toBe(true);
        expect(fixture.requests.find(request => request.path === '/revoke')?.authorization)
            .toBe(`Basic ${Buffer.from('fixture-client:registration-secret').toString('base64')}`);

        // The real DCR result becomes existing account configuration at the
        // storage boundary; reconnect then discovers CIMD on the same issuer.
        const accountTarget = { kind: 'account' as const, account: established.account, modeId: mode.id };
        await configurationOwner.replace({ target: accountTarget, mode, expectedRevision: configurationStorage.record?.revision ?? null,
            replacement: staged.content!, occurrenceId: lease.occurrenceId, sourceCustody: lease.sourceCustody });
        const reconnect = await configurationOwner.admit({ intent: 'reconnect', service, account: established.account, mode,
            occurrenceId: lease.occurrenceId, sourceCustody: lease.sourceCustody });
        if (reconnect.status !== 'ready') throw new Error('Missing reconnect configuration');
        fixture.setMetadataOverrides({ client_id_metadata_document_supported: true });
        fixture.setTokenOverrides({ scope: undefined });
        const reconnectEntries = new Map<string, string>();
        const reconnectStore = { get: async (key: string) => reconnectEntries.get(key) ?? null,
            set: async (key: string, value: string) => { reconnectEntries.set(key, value); },
            delete: async (key: string) => { reconnectEntries.delete(key); } };
        const reconnectContext: HostConnectedAccountAuthenticationContext = { ...context,
            attempt: { kind: 'reconnect', attemptId: 'attempt-cimd', account: established.account },
            configuration: reconnect.snapshot, attemptCredentials: reconnectStore,
            stageAccountConfiguration: async replacement => {
                staged.content = await configurationOwner.stageAccountConfiguration({ snapshot: reconnect.snapshot, replacement });
            } };
        await expect(nativeMode.begin({ callbackUrl: mode.callbackUrl!, state: 'attempt-cimd.state', pkce: { challenge: 'challenge', method: 'S256' } }, reconnectContext))
            .resolves.toMatchObject({ status: 'awaitingOAuthRedirect' });
        expect(staged.content?.secretValues?.clientSecrets).toBe('{}');
        await expect(nativeMode.complete({ code: 'cimd-code', callbackUrl: mode.callbackUrl!, state: 'attempt-cimd.state', pkceVerifier: 'cimd-verifier' }, reconnectContext))
            .resolves.toMatchObject({ status: 'connected' });
        const cimdConfiguration = { ...reconnect.snapshot, values: staged.content!.values,
            getSecret: async (key: string) => staged.content!.secretValues?.[key] ?? configurationStorage.record?.secretValues?.[key] ?? null };
        await expect(lease.runtime.refresh({ ...established, configuration: cimdConfiguration, credentials: reconnectStore,
            operation: { operationId: 'refresh-cimd', configurationRevision: cimdConfiguration.revision }, stagedCredentials: reconnectStore }))
            .resolves.toMatchObject({ status: 'connected' });
        const cimdRequests = fixture.requests.filter(request => request.path === '/token').slice(-2);
        expect(cimdRequests.every(request => !request.authorization && !new URLSearchParams(request.body).has('client_secret'))).toBe(true);
    });
});
