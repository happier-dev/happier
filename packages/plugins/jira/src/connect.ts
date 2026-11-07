import type { ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { encodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import type { ConnectedAccountRuntime, ConnectedAccountAuthenticationContext, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { jiraCloudOrigin, jiraResponseFailure, object, string } from './api.js';

function authorization(email: string, token: string): string { return `Basic ${encodeBase64(new TextEncoder().encode(`${email}:${token}`))}`; }
function diagnostic(code: string) { return { code, severity: 'error' as const, message: 'Jira could not confirm this account. Check the site, account email and API token.' }; }

async function confirm(context: Pick<ConnectedAccountAuthenticationContext, 'services' | 'signal'>,
    origin: string, email: string, token: string, signal = context.signal) {
    try {
        const response = await context.services.http.request({ url: `${origin}/rest/api/3/myself`, method: 'GET', redirect: 'error',
            headers: { Accept: 'application/json', authorization: authorization(email, token) } }, { signal });
        if (response.status !== 200) {
            const failure = jiraResponseFailure(response.status, response.headers);
            return { status: response.status === 401 || response.status === 403 ? 'rejected' as const : 'unavailable' as const,
                diagnostic: diagnostic(failure.code), ...(failure.class === 'rateLimit'
                    ? { failureClass: 'rateLimit' as const, ...(failure.retryNotBeforeMs === undefined ? {} : { retryNotBeforeMs: failure.retryNotBeforeMs }) } : {}) };
        }
        const user = object(JSON.parse(new TextDecoder().decode(response.body)));
        if (!string(user.accountId)) return { status: 'unavailable' as const, diagnostic: diagnostic('jira/viewerUnavailable') };
        return { status: 'connected' as const, displayName: string(user.displayName) ?? new URL(origin).hostname, scopes: [] };
    } catch {
        return { status: 'unavailable' as const, diagnostic: diagnostic(signal.aborted ? 'jira/cancelled' : 'jira/verificationUnavailable') };
    }
}

async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
    const origin = jiraCloudOrigin(context.configuration.values.site);
    const email = (await context.credentials.get('email', options))?.trim();
    const token = (await context.credentials.get('token', options))?.trim();
    if (origin === null || !email || !token) return { status: 'unavailable' as const, diagnostic: diagnostic('jira/credentialsUnavailable') };
    const result = await confirm(context, origin, email, token, options?.signal ?? context.signal);
    return result.status === 'rejected' ? { status: 'reconnectRequired' as const, diagnostic: result.diagnostic } : result;
}

/** Host credential storage owns the API token. This runtime only verifies and materializes it. */
const materializeJiraCredentials: NonNullable<ConnectedAccountPortableRuntime['materialize']> = async (request, context, options) => {
        const origin = jiraCloudOrigin(context.configuration.values.site);
        if (request.kind !== 'httpHeaders' || origin === null || request.origin !== origin) throw new Error('Jira credential origin mismatch');
        if (!request.headerNames.some((name) => name.toLowerCase() === 'authorization')) return { kind: 'httpHeaders', headers: {} as Record<string, string> };
        const email = (await context.credentials.get('email', options))?.trim();
        const token = (await context.credentials.get('token', options))?.trim();
        if (!email || !token) throw new Error('Jira credentials are unavailable');
        return { kind: 'httpHeaders', headers: { authorization: authorization(email, token) } };
    };

export const jiraAccountRuntime: ConnectedAccountRuntime = {
    authentication: { modes: { 'api-token': { kind: 'manual', async complete(input, context, options) {
        const origin = jiraCloudOrigin(context.configuration.values.site);
        const email = input.fields.email?.trim();
        const token = input.fields.token?.trim();
        if (origin === null || !email || !token || /[:\r\n]/u.test(email)) return { status: 'rejected', diagnostic: diagnostic('jira/configurationInvalid') };
        const result = await confirm(context, origin, email, token, options?.signal ?? context.signal);
        if (result.status !== 'connected') return result;
        await context.attemptCredentials.set('email', email, options);
        await context.attemptCredentials.set('token', token, options);
        return result;
    } } } },
    refresh: health, status: health,
    async revoke() { return { status: 'remoteUnsupported' }; },
    materialize: materializeJiraCredentials,
};

export const jiraPortableAccountRuntime: ConnectedAccountPortableRuntime = {
    authentication: jiraAccountRuntime.authentication,
    materialize: materializeJiraCredentials,
};
