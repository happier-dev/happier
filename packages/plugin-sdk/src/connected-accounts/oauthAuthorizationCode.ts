import type {
    PluginConnectedAccountAuthCompletionResult,
    PluginConnectedAccountOAuthBeginRequest,
    PluginConnectedAccountOAuthCompletion,
} from '../services/connectedAccounts.js';
import type { HttpService } from '../services/io.js';

type PublicClient = Readonly<{ clientId: string; scopes: readonly string[] }>;

/** Project the host's callback, state and S256 challenge into a provider authorization URL. */
export function buildOAuthAuthorizationCodeUrl(
    endpoint: string,
    input: PluginConnectedAccountOAuthBeginRequest,
    client: PublicClient,
    prompt?: string,
): string | null {
    const { challenge, method } = input.pkce;
    if (method !== 'S256' || typeof challenge !== 'string' || challenge.length === 0 || /\s/u.test(challenge)) return null;
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: input.callbackUrl,
        response_type: 'code',
        scope: client.scopes.join(' '),
        state: input.state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(prompt === undefined ? {} : { prompt }),
    }).toString();
    return url.href;
}

/** Project the public-client authorization-code grant. Providers own refresh and revoke parameters. */
export function buildOAuthAuthorizationCodeForm(input: PluginConnectedAccountOAuthCompletion, clientId: string): URLSearchParams {
    return new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: input.code,
        redirect_uri: input.callbackUrl,
        code_verifier: input.pkceVerifier,
    });
}

type OAuthEndpointRequest =
    | Readonly<{ token: string; form?: never }>
    | Readonly<{ form: URLSearchParams; token?: string }>;

/** Send one OAuth request to the exact provider endpoint. The adapter interprets the response. */
export async function requestOAuthEndpoint(
    http: Pick<HttpService, 'request'>,
    url: string,
    signal: AbortSignal,
    input: OAuthEndpointRequest,
) {
    signal.throwIfAborted();
    const headers: Record<string, string> = {};
    if (input.token !== undefined) headers.authorization = `Bearer ${input.token}`;
    if (input.form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    const response = await http.request({
        url,
        redirect: 'error',
        headers,
        ...(input.form === undefined
            ? { method: 'GET' as const }
            : { method: 'POST' as const, body: new TextEncoder().encode(input.form.toString()) }),
    }, { signal });
    signal.throwIfAborted();
    if (response.finalUrl !== url || (response.status >= 300 && response.status < 400)) {
        throw new Error('Unexpected OAuth redirect');
    }
    return response;
}

export function publicOAuthClientUnavailable(
    provider: string,
    code: string,
    message = `This Home does not offer Sign in with ${provider}. Connect with an access token instead.`,
): Extract<PluginConnectedAccountAuthCompletionResult, { status: 'unavailable' }> {
    return { status: 'unavailable', diagnostic: { code, severity: 'error', message } };
}
