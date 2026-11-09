import { z } from 'zod/mini';
import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import type { AuthorizationServerMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { ConnectedAccountRequestAuthMaterializationV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
import {
    MCP_OAUTH_CALLBACK_URL_V1,
    MCP_OAUTH_CLIENT_METADATA_URL_V1,
    MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1,
    McpOAuthClientRegistrationV1Schema,
} from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { HostConnectedAccountAuthenticationContext, HostConnectedAccountReadContext, HostConnectedAccountRuntime } from '@/plugins/runtime/connectedAccounts/hostRuntime';
import type { HostConnectedAccountRuntimeRegistration } from '@/plugins/runtime/connectedAccounts/contributionRegistry';

export const MCP_SIGN_IN_AUTHENTICATION_MODE_ID = 'oauth';
const completionKey = 'mcpOAuthCompletion';
const scopesSchema = { type: 'array' as const, items: { type: 'string' as const, minLength: 1 } };
const registrationProperties = {
    clientId: { type: 'string' as const, minLength: 1 },
    authorizationEndpoint: { type: 'string' as const, minLength: 1 },
    tokenEndpoint: { type: 'string' as const, minLength: 1 },
    revocationEndpoint: { type: 'string' as const, minLength: 1 },
    tokenEndpointAuthMethods: scopesSchema,
    clientAuthMethod: { type: 'string' as const, enum: ['client_secret_basic', 'client_secret_post', 'none'] },
    revocationAuthMethods: scopesSchema,
};
export const MCP_SIGN_IN_CONNECTED_ACCOUNT_DESCRIPTOR = PluginConnectedAccountDescriptorContributionV2Schema.parse({
    id: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1.localId,
    title: 'MCP server sign-in',
    authentication: { defaultModeId: MCP_SIGN_IN_AUTHENTICATION_MODE_ID, modes: [{
        id: MCP_SIGN_IN_AUTHENTICATION_MODE_ID, kind: 'oauthAuthorizationCode',
        callbackUrl: MCP_OAUTH_CALLBACK_URL_V1, pkce: 'required', outcomeReconciliation: 'none',
        configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
            { id: 'serverId', title: 'Server', required: true, schema: { type: 'string', minLength: 1 } },
            { id: 'resource', title: 'Resource URL', required: true, schema: { type: 'string', minLength: 1 } },
            { id: 'stepUp', title: 'Grant more access', default: false, schema: { type: 'boolean' } },
            { id: 'grantedScopes', title: 'Granted scopes', default: [], schema: scopesSchema },
            { id: 'stepUpScopes', title: 'Requested scopes', default: [], schema: scopesSchema },
            { id: 'issuer', title: 'Authorization server', schema: { type: 'string', minLength: 1 } },
            { id: 'registrations', title: 'Client registrations', default: {}, schema: {
                type: 'object', additionalProperties: { type: 'object', additionalProperties: false,
                    properties: registrationProperties, required: ['clientId', 'authorizationEndpoint', 'tokenEndpoint', 'tokenEndpointAuthMethods'] },
            } },
            { id: 'clientSecrets', title: 'Client secrets', secret: true, schema: { type: 'string', minLength: 1 } },
            // One-shot author input stays inside the incumbent opaque configuration.
            // Successful discovery replaces it with issuer-keyed registrations.
            { id: 'clientRegistration', title: 'OAuth app replacement', secret: true, schema: { type: 'string', minLength: 1 } },
        ] },
    }] },
});

const RegistrationSchema = z.strictObject({
    clientId: z.string().check(z.minLength(1)), authorizationEndpoint: z.string().check(z.url()), tokenEndpoint: z.string().check(z.url()),
    revocationEndpoint: z.optional(z.string().check(z.url())), tokenEndpointAuthMethods: z.array(z.string()),
    clientAuthMethod: z.optional(z.enum(['client_secret_basic', 'client_secret_post', 'none'])),
    revocationAuthMethods: z.optional(z.array(z.string())),
});
type Registration = z.infer<typeof RegistrationSchema>;
const ConfigurationSchema = z.object({
    serverId: z.string().check(z.minLength(1)), resource: z.string().check(z.url()), stepUp: z._default(z.boolean(), false),
    grantedScopes: z._default(z.array(z.string()), []), stepUpScopes: z._default(z.array(z.string()), []),
    issuer: z.optional(z.string()), registrations: z._default(z.record(z.string(), RegistrationSchema), {}),
});
const CompletionSchema = z.object({
    issuer: z.string().check(z.url()), resource: z.string().check(z.url()), serverId: z.string(),
    registration: RegistrationSchema, clientSecret: z.optional(z.string()), scopes: z.array(z.string()),
});
const SecretsSchema = z.record(z.string(), z.string());

function resourceUrl(value: string): URL {
    return new URL(canonicalMcpOAuthResourceUrlV1(value));
}
function resourceCanBeMaterialized(resource: URL): boolean {
    return ConnectedAccountRequestAuthMaterializationV1Schema.safeParse({
        kind: 'httpHeaders', origin: resource.origin, headerNames: ['authorization'],
    }).success;
}
function resourceRefused() {
    return { status: 'rejected' as const, diagnostic: diagnostic('mcp_oauth_resource_requires_https') };
}
function metadata(issuer: string, registration: Registration): AuthorizationServerMetadata {
    return { issuer, authorization_endpoint: registration.authorizationEndpoint,
        token_endpoint: registration.tokenEndpoint, response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: registration.tokenEndpointAuthMethods };
}
function diagnostic(code: string) { return { code, severity: 'error' as const }; }

// The SDK error module loads on demand like the SDK client: daemon startup
// registers this runtime and must not evaluate the MCP SDK before an operation.
async function isInvalidClientError(cause: unknown): Promise<boolean> {
    const { InvalidClientError } = await import('@modelcontextprotocol/sdk/server/auth/errors.js');
    return cause instanceof InvalidClientError;
}
class McpOAuthEndpointRequiresHttpsError extends Error {}
function requireHttpsEndpoint(input: Parameters<FetchLike>[0]): URL {
    const endpoint = input instanceof URL ? input : new URL(input);
    // MCP 2025-11-25 requires HTTPS for every AS endpoint. Its localhost
    // exception applies to redirect URIs, not authorization-server requests.
    if (endpoint.protocol !== 'https:') throw new McpOAuthEndpointRequiresHttpsError('MCP OAuth endpoints require HTTPS');
    return endpoint;
}
async function secrets(context: Pick<HostConnectedAccountReadContext, 'configuration'>) {
    const value = await context.configuration.getSecret('clientSecrets');
    return value ? SecretsSchema.parse(JSON.parse(value)) : {};
}
async function established(context: HostConnectedAccountReadContext) {
    const configuration = ConfigurationSchema.parse(context.configuration.values);
    const issuer = configuration.issuer;
    const registration = issuer && configuration.registrations[issuer];
    if (!issuer || !registration) throw new Error('Missing MCP registration');
    return { configuration, issuer, registration, clientSecret: (await secrets(context))[issuer] };
}
function client(registration: Registration, clientSecret?: string) {
    return { client_id: registration.clientId, ...(clientSecret ? { client_secret: clientSecret } : {}),
        ...(registration.clientAuthMethod ? { token_endpoint_auth_method: registration.clientAuthMethod } : {}) };
}
async function saveTokens(store: HostConnectedAccountAuthenticationContext['attemptCredentials'], tokens: OAuthTokens, now: number, requestedScopes: readonly string[]) {
    if (tokens.token_type.toLowerCase() !== 'bearer') throw new Error('Unsupported MCP token scheme');
    await store.set('accessToken', tokens.access_token);
    if (tokens.refresh_token) await store.set('refreshToken', tokens.refresh_token);
    else await store.delete('refreshToken');
    if (tokens.expires_in !== undefined) await store.set('expiresAtMs', String(now + tokens.expires_in * 1000));
    else await store.delete('expiresAtMs');
    const scopes = tokens.scope === undefined ? [...requestedScopes] : tokens.scope.split(/\s+/).filter(Boolean);
    await store.set('scopes', JSON.stringify(scopes));
    return scopes;
}

export function createMcpSignInRuntime(): HostConnectedAccountRuntime {
    function transport(signal: AbortSignal) {
        let lastStatus: number | undefined;
        let issRequired = false;
        let clientMetadataSupported = false;
        let revocationAuthMethods: string[] | undefined;
        const request = async (url: Parameters<FetchLike>[0], init: Parameters<FetchLike>[1], readMetadata: boolean) => {
            signal.throwIfAborted();
            requireHttpsEndpoint(url);
            // Prevent a 307/308 from forwarding authorization codes, verifiers,
            // refresh tokens or DCR secrets to another endpoint.
            const response = await fetchWithCredentialRedirectRefusal(url, { ...init, signal });
            lastStatus = response.status;
            if (readMetadata && response.ok && (!init?.method || init.method === 'GET')) {
                const raw: unknown = await response.clone().json().catch(() => null);
                if (raw && typeof raw === 'object') {
                    const flags = raw as Readonly<Record<string, unknown>>;
                    // SDK 1.25.3's OIDC parser strips these extension fields.
                    issRequired = z.optional(z.boolean()).parse(flags.authorization_response_iss_parameter_supported) === true;
                    clientMetadataSupported = z.optional(z.boolean()).parse(flags.client_id_metadata_document_supported) === true;
                    revocationAuthMethods = z.optional(z.array(z.string())).parse(flags.revocation_endpoint_auth_methods_supported);
                }
            }
            return response;
        };
        const send: FetchLike = (url, init) => request(url, init, true);
        return { send, probe: (url: URL) => request(url, undefined, false),
            status: () => lastStatus, flags: () => ({ issRequired, clientMetadataSupported, revocationAuthMethods }) };
    }
    function failure(signal: AbortSignal, status: number | undefined, code: string) {
        signal.throwIfAborted();
        return status === undefined || status === 429 || status >= 500
            ? { status: 'outcomeUnknown' as const, diagnostic: diagnostic(code) }
            : { status: 'rejected' as const, diagnostic: diagnostic(code) };
    }
    return {
        authentication: { modes: { [MCP_SIGN_IN_AUTHENTICATION_MODE_ID]: {
            kind: 'oauthAuthorizationCode',
            async begin(input, context) {
                const network = transport(context.signal);
                try {
                    const { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata, extractWWWAuthenticateParams, registerClient, selectClientAuthMethod } = await import('@modelcontextprotocol/sdk/client/auth.js');
                    const configuration = ConfigurationSchema.parse(context.configuration.values);
                    const resource = resourceUrl(configuration.resource);
                    // A successful grant must be usable through the incumbent
                    // request-auth seam; do not stage one that seam cannot admit.
                    if (!resourceCanBeMaterialized(resource)) return resourceRefused();
                    const response = await network.probe(resource);
                    const challenge = extractWWWAuthenticateParams(response);
                    await response.body?.cancel();
                    const prm = await discoverOAuthProtectedResourceMetadata(resource, { resourceMetadataUrl: challenge.resourceMetadataUrl }, network.send)
                        .catch(async error => {
                            // An explicit metadata URL has no fallback in SDK 1.25.3.
                            // Only its absence permits the SDK's normal path/root discovery.
                            if (!challenge.resourceMetadataUrl || ![404, 410].includes(network.status() ?? 0)) throw error;
                            return discoverOAuthProtectedResourceMetadata(resource, {}, network.send);
                        });
                    // RFC 9728 §3.3: a discovery location never widens the
                    // resource authority established by the configured full URL.
                    if (prm.resource !== resource.href) return { status: 'rejected', diagnostic: diagnostic('mcp_oauth_resource_mismatch') };
                    const issuer = prm.authorization_servers?.[0];
                    if (!issuer) return { status: 'rejected', diagnostic: diagnostic('mcp_oauth_issuer_missing') };
                    const discovered = await discoverAuthorizationServerMetadata(issuer, { fetchFn: network.send });
                    // RFC 8414 §3.3: metadata from a different issuer MUST NOT be used.
                    if (!discovered || discovered.issuer !== issuer) return { status: 'rejected', diagnostic: diagnostic('mcp_oauth_issuer_mismatch') };
                    if (!discovered.code_challenge_methods_supported?.includes('S256')) return { status: 'rejected', diagnostic: diagnostic('mcp_oauth_pkce_required') };
                    if (input.callbackUrl !== MCP_OAUTH_CALLBACK_URL_V1) return { status: 'rejected', diagnostic: diagnostic('mcp_oauth_callback_invalid') };
                    const authorization = requireHttpsEndpoint(discovered.authorization_endpoint);
                    const clientSecrets = await secrets(context);
                    const suppliedRaw = await context.configuration.getSecret('clientRegistration');
                    const supplied = suppliedRaw === null ? undefined : McpOAuthClientRegistrationV1Schema.parse(JSON.parse(suppliedRaw));
                    let registration: Registration | undefined = configuration.registrations[issuer];
                    if (supplied === null) { registration = undefined; delete clientSecrets[issuer]; }
                    const flags = network.flags();
                    let clientId: string;
                    let clientAuthMethod = registration?.clientAuthMethod;
                    if (flags.clientMetadataSupported) {
                        clientId = MCP_OAUTH_CLIENT_METADATA_URL_V1;
                        clientAuthMethod = 'none';
                        delete clientSecrets[issuer];
                    } else if (supplied) {
                        clientId = supplied.clientId;
                        if (supplied.clientSecret) clientSecrets[issuer] = supplied.clientSecret;
                        else delete clientSecrets[issuer];
                        clientAuthMethod = selectClientAuthMethod({ client_id: clientId,
                            ...(supplied.clientSecret ? { client_secret: supplied.clientSecret } : {}),
                            ...(registration?.clientId === clientId && registration.clientAuthMethod
                                && (registration.clientAuthMethod === 'none') === !supplied.clientSecret
                                ? { token_endpoint_auth_method: registration.clientAuthMethod } : {}) },
                        discovered.token_endpoint_auth_methods_supported ?? ['client_secret_basic']);
                    } else if (registration) {
                        clientId = registration.clientId;
                    } else if (discovered.registration_endpoint) {
                        const clientMetadata = {
                            client_name: 'Happier', application_type: 'native', redirect_uris: [MCP_OAUTH_CALLBACK_URL_V1],
                            grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
                        };
                        const registered = await registerClient(issuer, { metadata: discovered, clientMetadata, fetchFn: network.send });
                        clientId = registered.client_id;
                        clientAuthMethod = RegistrationSchema.shape.clientAuthMethod.parse(registered.token_endpoint_auth_method);
                        if (registered.client_secret) clientSecrets[issuer] = registered.client_secret;
                    } else return { status: 'rejected', diagnostic: diagnostic('client_refused') };
                    registration = RegistrationSchema.parse({ clientId, authorizationEndpoint: discovered.authorization_endpoint,
                        tokenEndpoint: discovered.token_endpoint,
                        ...('revocation_endpoint' in discovered && discovered.revocation_endpoint ? { revocationEndpoint: discovered.revocation_endpoint } : {}),
                        ...(clientAuthMethod ? { clientAuthMethod } : {}),
                        ...(flags.revocationAuthMethods ? { revocationAuthMethods: flags.revocationAuthMethods } : {}),
                        tokenEndpointAuthMethods: discovered.token_endpoint_auth_methods_supported ?? ['client_secret_basic'] });
                    const scopes = [...new Set([
                        ...(challenge.scope !== undefined ? challenge.scope.split(/\s+/).filter(Boolean) : prm.scopes_supported ?? []),
                        ...(configuration.stepUp ? [...configuration.grantedScopes, ...configuration.stepUpScopes] : []),
                    ])];
                    const values: Record<string, JsonValue> = { ...configuration, resource: resource.href, issuer, stepUp: false, stepUpScopes: [],
                        registrations: { ...configuration.registrations, [issuer]: registration } };
                    // An explicit empty dictionary clears a previous DCR secret
                    // when this issuer switches to a public CIMD client.
                    await context.stageAccountConfiguration({ values, secretValues: { clientSecrets: JSON.stringify(clientSecrets) } });
                    await context.attemptCredentials.set(completionKey, JSON.stringify({ issuer, resource: resource.href,
                        serverId: configuration.serverId, registration, clientSecret: clientSecrets[issuer], scopes }));
                    const query = { response_type: 'code', client_id: clientId, redirect_uri: input.callbackUrl, state: input.state,
                        code_challenge: input.pkce.challenge, code_challenge_method: 'S256', resource: resource.href };
                    for (const [key, value] of Object.entries(query)) authorization.searchParams.set(key, value);
                    if (scopes.length) authorization.searchParams.set('scope', scopes.join(' '));
                    return { status: 'awaitingOAuthRedirect', authorizationUrl: authorization.href, issuer,
                        issuerResponseParameterRequired: flags.issRequired };
                } catch (cause) {
                    if (cause instanceof CredentialRequestRedirectError) throw cause;
                    context.signal.throwIfAborted();
                    return { status: 'rejected', diagnostic: diagnostic(cause instanceof McpOAuthEndpointRequiresHttpsError
                        ? 'mcp_oauth_endpoints_require_https' : await isInvalidClientError(cause) ? 'invalid_client' : 'mcp_oauth_discovery_failed') };
                }
            },
            async complete(input, context) {
                const network = transport(context.signal);
                try {
                    const { exchangeAuthorization } = await import('@modelcontextprotocol/sdk/client/auth.js');
                    const configuredResource = resourceUrl(ConfigurationSchema.parse(context.configuration.values).resource);
                    if (!resourceCanBeMaterialized(configuredResource)) return resourceRefused();
                    const raw = await context.attemptCredentials.get(completionKey);
                    if (!raw) return { status: 'rejected', diagnostic: diagnostic('mcp_oauth_attempt_missing') };
                    const sealed = CompletionSchema.parse(JSON.parse(raw));
                    const tokens = await exchangeAuthorization(sealed.issuer, { metadata: metadata(sealed.issuer, sealed.registration),
                        clientInformation: client(sealed.registration, sealed.clientSecret), authorizationCode: input.code,
                        codeVerifier: input.pkceVerifier, redirectUri: input.callbackUrl, resource: resourceUrl(sealed.resource), fetchFn: network.send });
                    const scopes = await saveTokens(context.attemptCredentials, tokens, Date.now(), sealed.scopes);
                    await context.attemptCredentials.delete(completionKey);
                    return { status: 'connected', accountId: sealed.serverId, displayName: sealed.serverId, scopes };
                } catch (cause) {
                    if (cause instanceof CredentialRequestRedirectError) throw cause;
                    context.signal.throwIfAborted();
                    return await isInvalidClientError(cause)
                        ? { status: 'rejected', diagnostic: diagnostic('invalid_client') }
                        : cause instanceof McpOAuthEndpointRequiresHttpsError
                        ? { status: 'rejected', diagnostic: diagnostic('mcp_oauth_endpoints_require_https') }
                        : failure(context.signal, network.status(), 'mcp_oauth_exchange_failed');
                }
            },
            async cancel(context) { await context.attemptCredentials.delete(completionKey); },
        } } },
        async refresh(context) {
            const network = transport(context.signal);
            try {
                const { refreshAuthorization } = await import('@modelcontextprotocol/sdk/client/auth.js');
                const { configuration, issuer, registration, clientSecret } = await established(context);
                const refreshToken = await context.credentials.get('refreshToken');
                if (!refreshToken) return { status: 'reconnectRequired', diagnostic: diagnostic('mcp_oauth_refresh_missing') };
                const tokens = await refreshAuthorization(issuer, { metadata: metadata(issuer, registration),
                    clientInformation: client(registration, clientSecret), refreshToken, resource: resourceUrl(configuration.resource), fetchFn: network.send });
                const previousScopes = await context.credentials.get('scopes');
                const scopes = await saveTokens(context.stagedCredentials, tokens, Date.now(), previousScopes ? z.array(z.string()).parse(JSON.parse(previousScopes)) : []);
                return { status: 'connected', scopes };
            } catch (cause) {
                if (cause instanceof CredentialRequestRedirectError) throw cause;
                context.signal.throwIfAborted();
                if (cause instanceof McpOAuthEndpointRequiresHttpsError) return { status: 'reconnectRequired', diagnostic: diagnostic('mcp_oauth_endpoints_require_https') };
                const result = failure(context.signal, network.status(), 'mcp_oauth_refresh_failed');
                return result.status === 'rejected' ? { ...result, status: 'reconnectRequired' } : result;
            }
        },
        async revoke(context) {
            const network = transport(context.signal);
            try {
                const { selectClientAuthMethod } = await import('@modelcontextprotocol/sdk/client/auth.js');
                const { registration, clientSecret } = await established(context);
                if (!registration.revocationEndpoint) return { status: 'remoteUnsupported' };
                const token = await context.credentials.get('refreshToken') ?? await context.credentials.get('accessToken');
                if (!token) return { status: 'remoteUnsupported' };
                const body = new URLSearchParams({ token });
                const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
                const method = selectClientAuthMethod(client(registration, clientSecret), registration.revocationAuthMethods ?? registration.tokenEndpointAuthMethods);
                if (method === 'client_secret_basic' && clientSecret) headers.set('authorization', `Basic ${Buffer.from(`${encodeURIComponent(registration.clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`);
                else { body.set('client_id', registration.clientId); if (method === 'client_secret_post' && clientSecret) body.set('client_secret', clientSecret); }
                const response = await network.send(registration.revocationEndpoint, { method: 'POST', headers, body });
                await response.body?.cancel();
                return response.ok ? { status: 'remoteRevoked' } : { status: 'outcomeUnknown', diagnostic: diagnostic('mcp_oauth_revoke_failed') };
            } catch (cause) {
                if (cause instanceof CredentialRequestRedirectError) throw cause;
                context.signal.throwIfAborted();
                return { status: 'outcomeUnknown', diagnostic: diagnostic(cause instanceof McpOAuthEndpointRequiresHttpsError
                    ? 'mcp_oauth_endpoints_require_https' : 'mcp_oauth_revoke_failed') };
            }
        },
        async status(context) {
            const accessToken = await context.credentials.get('accessToken');
            const expiresAt = await context.credentials.get('expiresAtMs');
            if (!accessToken) return { status: 'reconnectRequired' };
            if (expiresAt !== null && Number(expiresAt) <= Date.now()) {
                return { status: await context.credentials.get('refreshToken') ? 'expired' : 'reconnectRequired' };
            }
            return { status: 'connected' };
        },
        async materialize(request, context) {
            const configuration = ConfigurationSchema.parse(context.configuration.values);
            if (request.kind !== 'httpHeaders' || request.origin !== resourceUrl(configuration.resource).origin
                || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw new Error('MCP resource audience mismatch');
            const accessToken = await context.credentials.get('accessToken');
            if (!accessToken) throw new Error('MCP sign-in required');
            return { kind: 'httpHeaders', headers: { authorization: `Bearer ${accessToken}` } };
        },
    };
}

export function createMcpSignInConnectedAccountRegistration(): HostConnectedAccountRuntimeRegistration {
    return { ref: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1, descriptor: MCP_SIGN_IN_CONNECTED_ACCOUNT_DESCRIPTOR, runtime: createMcpSignInRuntime() };
}
