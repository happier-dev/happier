import {
    AccountPlanResponseV1Schema,
    AccountSupporterResponseV1Schema,
    SupporterLookupResponseV1Schema,
    type AccountPlanResponseV1,
    type AccountSupporterPutRequestV1,
    type AccountSupporterResponseV1,
    type SupporterRecordFactsV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { HAPPIER_CLOUD_SERVER_URL } from '@/sync/domains/server/serverProfiles';
import { serverFetch } from '@/sync/http/client';

/**
 * HTTP adapters for the Plans & Supporter surfaces (plans 01, 03).
 *
 * Every function maps a route's documented outcomes to a typed result and throws only for an
 * unexpected status or a malformed body, so callers never read a failed request as "Free".
 */

export type AccountPlanReadResult =
    | Readonly<{ kind: 'ok'; plan: AccountPlanResponseV1 }>
    /** 404: neither `plans` nor `supporter` is on for this server. */
    | Readonly<{ kind: 'unavailable' }>;

export class PlanSurfaceRequestError extends Error {
    readonly status: number;
    readonly code: string | null;

    constructor(path: string, status: number, code: string | null) {
        super(`${path} answered ${status}${code ? ` (${code})` : ''}`);
        this.name = 'PlanSurfaceRequestError';
        this.status = status;
        this.code = code;
    }
}

async function readErrorCode(response: Response): Promise<string | null> {
    try {
        const body: unknown = await response.json();
        if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
            return (body as { error: string }).error;
        }
    } catch {
        // A non-JSON error body carries no code.
    }
    return null;
}

export async function fetchAccountPlan(signal?: AbortSignal): Promise<AccountPlanReadResult> {
    const path = '/v1/account/plan';
    const response = await serverFetch(path, { method: 'GET', signal, responseSizeBounded: true });
    if (response.status === 404) return { kind: 'unavailable' };
    if (!response.ok) throw new PlanSurfaceRequestError(path, response.status, await readErrorCode(response));
    return { kind: 'ok', plan: AccountPlanResponseV1Schema.parse(await response.json()) };
}

/** Behind Check again on Cloud: re-reads the provider and writes only a real change. */
export async function postBillingRefresh(): Promise<void> {
    const path = '/v1/billing/refresh';
    const response = await serverFetch(path, { method: 'POST' });
    if (!response.ok) throw new PlanSurfaceRequestError(path, response.status, await readErrorCode(response));
}

export async function postSupporterAskClose(ask: 'star' | 'supporter_prompt'): Promise<void> {
    const path = '/v1/account/asks/close';
    const response = await serverFetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ask }),
    });
    if (!response.ok) throw new PlanSurfaceRequestError(path, response.status, await readErrorCode(response));
}

export async function putSupporterRing(visible: boolean): Promise<boolean> {
    const path = '/v1/account/supporter/ring';
    const response = await serverFetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visible }),
    });
    if (!response.ok) throw new PlanSurfaceRequestError(path, response.status, await readErrorCode(response));
    const body: unknown = await response.json();
    return Boolean(body && typeof body === 'object' && (body as { visible?: unknown }).visible === true);
}

/** The session's own supporter record, including its code. Never an Action: the code is a bearer. */
export async function fetchAccountSupporter(): Promise<AccountSupporterResponseV1> {
    const path = '/v1/account/supporter';
    const response = await serverFetch(path, { method: 'GET', responseSizeBounded: true });
    if (!response.ok) throw new PlanSurfaceRequestError(path, response.status, await readErrorCode(response));
    return AccountSupporterResponseV1Schema.parse(await response.json());
}

/** Authenticated starts use the active account. Code-based starts go to Cloud without Home credentials. */
export async function postSupporterLinkStart(provider: 'discord' | 'github', code?: string): Promise<string | null> {
    const route = `/v1/supporter/${provider}/start`;
    const includeAuth = code === undefined;
    const response = await serverFetch(includeAuth ? route : `${HAPPIER_CLOUD_SERVER_URL}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        redirect: 'error',
    }, { includeAuth });
    if (!response.ok) return null;
    const hostname = provider === 'discord' ? /^discord\.com$/ : /^github\.com$/;
    return z.object({ url: z.url({ protocol: /^https$/, hostname }) }).parse(await response.json()).url;
}

/** Self-hosted only; Cloud answers 403 `billing_configured`. */
export async function putAccountSupporter(request: AccountSupporterPutRequestV1): Promise<void> {
    const path = '/v1/account/supporter';
    const response = await serverFetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    });
    if (!response.ok) throw new PlanSurfaceRequestError(path, response.status, await readErrorCode(response));
}

/**
 * Asks Happier Cloud about a supporter code (self-hosted settle path, plan 03 F6). The code goes in
 * the body, never the URL, and no credential is sent: this is a public route on another origin.
 */
export async function postSupporterLookup(cloudServerUrl: string, code: string): Promise<SupporterRecordFactsV1 | null> {
    const url = `${cloudServerUrl.replace(/\/+$/, '')}/v1/supporter/lookup`;
    const response = await serverFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
    }, { includeAuth: false });
    if (response.status === 404) return null;
    if (!response.ok) throw new PlanSurfaceRequestError('/v1/supporter/lookup', response.status, await readErrorCode(response));
    return SupporterLookupResponseV1Schema.parse(await response.json());
}
