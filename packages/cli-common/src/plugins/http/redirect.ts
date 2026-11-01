import { PluginError } from '../errors.js';
import type { HttpRequest, HttpResponse } from './contracts.js';
import { resolveCredentialRequestRedirect, CredentialRequestRedirectError } from '../../homeTarget/index.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Moved from the SDK's unused internal constant: the redirect owner enforces it.
export const MAX_PLUGIN_FETCH_REDIRECTS = 10;

export { isCredentialRequestHeader as isPluginHttpCredentialHeader } from '../../homeTarget/index.js';

/** The public plugin boundary retains the shared refusal without transport data. */
export function toPluginHttpRedirectFailure(error: unknown): unknown {
    if (!(error instanceof CredentialRequestRedirectError)) return error;
    return Object.assign(new PluginError({
        code: error.code, retryable: error.retryable, message: error.message,
        details: { status: error.status },
    }), { status: error.status, response: Object.freeze({ status: error.status }) });
}

/** Applies each redirect's method/body semantics and strips cross-origin credentials. */
export function nextPluginHttpRedirect(
    request: HttpRequest,
    response: Pick<HttpResponse, 'status' | 'headers' | 'finalUrl'>,
    privateCredentialHeaderNames: ReadonlySet<string>,
    hasSecretBody: boolean,
    containsRegisteredSecret?: (value: string) => boolean,
): HttpRequest | undefined {
    if (!REDIRECT_STATUSES.has(response.status) || request.redirect === 'manual') return;
    if (request.redirect === 'error') {
        throw new PluginError({ code: 'plugin_fetch_redirect_refused', message: 'HTTP redirect mode forbids following this response' });
    }
    const location = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'location')?.[1];
    if (location === undefined) return;
    const next = resolveCredentialRequestRedirect({ status: response.status, requestUrl: request.url,
        location, method: request.method ?? 'GET', headers: request.headers ?? {},
        hasSecretBody, privateCredentialHeaderNames, containsRegisteredSecret });
    if (!next) return;
    const headers = Object.freeze(next.headers);
    if (next.dropBody) {
        const { body: _body, ...rest } = request;
        return Object.freeze({ ...rest, url: next.url, method: 'GET', headers });
    }
    return Object.freeze({ ...request, url: next.url, headers });
}
