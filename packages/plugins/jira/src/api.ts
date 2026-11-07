import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
export type JiraSourceContext = Pick<PluginAccountActionContext, 'signal'> & Readonly<{
    services: Pick<PluginAccountActionContext['services'], 'http' | 'connectedAccounts'>;
}>;
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpMethod } from '@happier-dev/plugin-sdk/http';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { admitForgeRequestUrl, materializeTriageSourceAuthorizationV1, parseRetryAfterNotBeforeMsV1 } from '@happier-dev/triage-sources/runtime';
import { JIRA_ACCOUNT_PURPOSE } from './contracts.js';

export function object(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export function numericId(value: unknown): value is string {
    return typeof value === 'string' && /^\d+$/u.test(value);
}

/** API-token pilot: only the exact Connected-Accounts-owned Jira Cloud site. */
export function jiraCloudOrigin(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname.endsWith('.atlassian.net')
            && url.port === '' && url.pathname === '/' && url.username === ''
            && url.password === '' && url.search === '' && url.hash === '' ? url.origin : null;
    } catch { return null; }
}

export class JiraFailure extends Error {
    constructor(readonly failure: TriageSourceFailureV1, readonly status?: number, readonly dispatched = false) { super(failure.code); }
}
export function jiraFailure(error: unknown): TriageSourceFailureV1 {
    return error instanceof JiraFailure ? error.failure : { class: 'transient', code: 'jira/requestUnavailable' };
}
export function invalidJira(code = 'jira/responseInvalid'): JiraFailure {
    return new JiraFailure({ class: 'unsupportedContract', code });
}
export type JiraClient = ReturnType<typeof createJiraClient>;

export function jiraResponseFailure(status: number, rawHeaders: Readonly<Record<string, string>>): TriageSourceFailureV1 {
    const headers = Object.fromEntries(Object.entries(rawHeaders).map(([key, value]) => [key.toLowerCase(), value]));
    const retry = parseRetryAfterNotBeforeMsV1(headers['retry-after'] ?? null, Date.now());
    const reset = Date.parse(headers['x-ratelimit-reset'] ?? '');
    const deadline = Math.max(retry ?? 0, Number.isFinite(reset) ? reset : 0);
    return {
        class: status === 429 ? 'rateLimit' : status === 401 ? 'authentication'
            : status === 403 || status === 404 ? 'permission' : status >= 500 ? 'transient' : 'unsupportedContract',
        code: `jira/http${status}`, ...(deadline > 0 ? { retryNotBeforeMs: deadline } : {}),
    };
}

/** Reads and writes share exact-account authorization, cancellation and retry evidence. */
export function createJiraClient(context: JiraSourceContext, account: ConnectedAccountRef, origin: string) {
    return {
        origin,
        async request(path: string, method: HttpMethod = 'GET', body?: unknown): Promise<unknown> {
            context.signal.throwIfAborted();
            const url = new URL(path, origin).toString();
            if (admitForgeRequestUrl(url, origin) === null) throw invalidJira('jira/routeInvalid');
            const auth = await materializeTriageSourceAuthorizationV1({
                connectedAccounts: context.services.connectedAccounts, purpose: JIRA_ACCOUNT_PURPOSE,
                account, origin, signal: context.signal,
            });
            if (!auth.ok) throw new JiraFailure(auth.failure ?? {
                class: auth.reason === 'cancelled' ? 'transient' : 'authentication', code: `jira/${auth.reason}`,
            });
            let response: Awaited<ReturnType<typeof context.services.http.request>>;
            try { response = await context.services.http.request({
                url, method, redirect: 'error',
                headers: { Accept: 'application/json', authorization: auth.authorization,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }),
            }, { signal: context.signal }); }
            catch { throw new JiraFailure({ class: 'transient', code: context.signal.aborted ? 'jira/cancelled' : 'jira/transportUnavailable' }, undefined, true); }
            if (response.status < 200 || response.status >= 300) {
                throw new JiraFailure(jiraResponseFailure(response.status, response.headers), response.status, true);
            }
            if (response.status === 204 || response.body.length === 0) return null;
            try { return JSON.parse(new TextDecoder().decode(response.body)) as unknown; }
            catch { throw new JiraFailure({ class: 'unsupportedContract', code: 'jira/responseInvalid' }, response.status, true); }
        },
    };
}
