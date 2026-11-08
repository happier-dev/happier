import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';

import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ConnectedAccountHostRuntimeLease } from '@/plugins/runtime/connectedAccounts/contributionRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

const cleanups: Array<() => Promise<void>> = [];
const networkFetch = globalThis.fetch;
afterEach(async () => {
    try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
    finally { vi.restoreAllMocks(); }
});

export async function authorizationServer(options: Readonly<{
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
    resource?: string;
    tool?: 'public' | 'oauth';
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
            if (options.tool && (options.tool === 'public' || request.headers.authorization === `Bearer access-${tokenCount}` && tokenCount > 0)) {
                if (request.method !== 'POST') { response.writeHead(405); response.end('{}'); return; }
                const message = JSON.parse(body);
                if (message.id === undefined) { response.writeHead(202); response.end(); return; }
                const result = message.method === 'initialize'
                    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'harmless-read', version: '1' } }
                    : message.method === 'tools/list'
                        ? { tools: [{ name: 'read_status', description: 'Read fixture status', inputSchema: { type: 'object', properties: {} } }] }
                        : { content: [{ type: 'text', text: 'fixture status: ready' }] };
                response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
                return;
            }
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
    resource = options.resource ?? (options.httpResource ? `${physicalBase}/mcp` : `https://resource-${address.port}.fixture.test/mcp`);
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

export async function registeredRegistry(): Promise<ResolvedExecutablePluginRuntimeRegistry> {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p7a-mcp-oauth-'));
    cleanups.push(() => rm(happyHomeDir, { recursive: true, force: true }));
    const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes: createResolvedContributionRegistry({}) });
    cleanups.push(async () => { await registry.dispose(); });
    return registry;
}

export async function registeredRuntime(): Promise<ConnectedAccountHostRuntimeLease> {
    const registry = await registeredRegistry();
    const lease = await registry.resolveConnectedAccountRuntime?.(HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1);
    expect(lease, 'Built-in MCP sign-in must be reachable through the executable registry').not.toBeNull();
    if (!lease || lease.owner !== 'host') throw new Error('Missing built-in MCP sign-in runtime');
    return lease;
}

export function registerMcpOAuthFixtureCleanup(cleanup: () => Promise<void>): void {
    cleanups.push(cleanup);
}
