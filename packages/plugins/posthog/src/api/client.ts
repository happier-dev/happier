/**
 * The sole PostHog request, credential, private-deadline, and throttle-classification
 * path.
 *
 * Everything the source sends to PostHog goes through here, so this is the one place
 * that reads a credential, decides what a failure means, and decides whether a
 * follow-up URL is still the materialized origin. It performs no retry, no backoff, no
 * local quota accounting, and no waiting: PostHog's published limits apply to the whole
 * customer organization, so a client-side schedule could neither enforce them nor be
 * derived from evidence. A throttle response becomes one typed failure that a later
 * view-driven refresh may consult.
 */

import { admitForgeRequestUrl } from '@happier-dev/triage-sources/runtime';

import type { PosthogApiOrigin } from '../connect/origin.js';
import { classifyPosthogResponseStatus, type PosthogFailure } from './errors.js';

export type PosthogMaterializationRequest = Readonly<{
    origin: string;
}>;

/**
 * What one credential materialization settled as.
 *
 * It is a result rather than a bare header bag because the four ways a
 * materialization can fail are not one condition: a withdrawn call is a
 * cancellation, a materialization of the wrong kind is a contract refusal, and a
 * host rejection is an account failure. `@happier-dev/triage-sources` owns that
 * distinction for every first-party source — including which header name this
 * source asks for — so nothing here re-derives it from a `catch`.
 */
export type PosthogMaterializationOutcome =
    | Readonly<{ ok: true; authorization: string }>
    | Readonly<{ ok: false; failure: PosthogFailure }>;

/**
 * The Connected-Accounts-owned credential seam. The source never stores, logs, or
 * inspects the value; it reaches only the outbound authorization header.
 *
 * The signal it receives is the request's own composed boundary — caller
 * cancellation OR this path's private deadline — so a materialization that outlives
 * the request this source already abandoned is ended rather than left running
 * against the account.
 */
export type PosthogHeaderMaterializer = (
    request: PosthogMaterializationRequest,
    options: Readonly<{ signal: AbortSignal }>,
) => Promise<PosthogMaterializationOutcome>;

export type PosthogTransportRequest = Readonly<{
    method: 'GET' | 'POST';
    headers: Readonly<Record<string, string>>;
    body?: string;
    signal: AbortSignal;
    redirect: 'manual';
}>;

/** The genuine system boundary: one HTTP round trip. */
export type PosthogTransport = (
    url: string,
    request: PosthogTransportRequest,
) => Promise<Response>;

export type PosthogJsonRequest = Readonly<{
    method: 'GET' | 'POST';
    path: string;
    query?: Readonly<Record<string, string>>;
    body?: unknown;
}>;

export type PosthogRequestOptions = Readonly<{
    /**
     * The caller's cancellation/deadline signal. Aggregate-driven operations pass the
     * aggregate signal unchanged and supply no private deadline, so no second timer is
     * layered over them.
     */
    signal?: AbortSignal;
    /**
     * A positive private deadline for a path that has no aggregate deadline of its own
     * (configuration browsing, capability read, mounted detail, Activity, code-variable
     * reveal, Composer reread).
     */
    privateDeadlineMs?: number;
}>;

export type PosthogResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; failure: PosthogFailure }>;

/** Strict parse of one already-decoded JSON body; `null` rejects the response. */
export type PosthogBodyParser<T> = (body: unknown) => T | null;

export interface PosthogApiClient {
    requestJson<T>(
        request: PosthogJsonRequest,
        parse: PosthogBodyParser<T>,
        options: PosthogRequestOptions,
    ): Promise<PosthogResult<T>>;
    /**
     * Issues a request against a provider-returned absolute URL. The URL must still
     * normalize to the exact materialized origin; otherwise no credential is
     * materialized and no request is made.
     */
    followJson<T>(
        absoluteUrl: string,
        parse: PosthogBodyParser<T>,
        options: PosthogRequestOptions,
    ): Promise<PosthogResult<T>>;
}

export type PosthogApiClientDependencies = Readonly<{
    origin: PosthogApiOrigin;
    materializeHeaders: PosthogHeaderMaterializer;
    transport: PosthogTransport;
    now?: () => number;
}>;

type Settlement =
    | Readonly<{ kind: 'timeout' }>
    | Readonly<{ kind: 'cancelled' }>;

function buildUrl(
    origin: PosthogApiOrigin,
    path: string,
    query: Readonly<Record<string, string>> | undefined,
): string {
    const url = new URL(path, origin as string);
    if (query !== undefined) {
        for (const [key, value] of Object.entries(query)) {
            url.searchParams.set(key, value);
        }
    }
    return url.toString();
}

export function createPosthogApiClient(
    dependencies: PosthogApiClientDependencies,
): PosthogApiClient {
    const { origin, materializeHeaders, transport } = dependencies;
    const now = dependencies.now ?? Date.now;

    async function send<T>(
        url: string,
        request: PosthogJsonRequest,
        parse: PosthogBodyParser<T>,
        options: PosthogRequestOptions,
    ): Promise<PosthogResult<T>> {
        const { privateDeadlineMs } = options;
        if (privateDeadlineMs !== undefined
            && (!Number.isFinite(privateDeadlineMs) || privateDeadlineMs <= 0)) {
            return { ok: false, failure: { kind: 'requestInvalid', at: 'privateDeadlineMs' } };
        }
        if (options.signal?.aborted === true) {
            return { ok: false, failure: { kind: 'cancelled' } };
        }

        const controller = new AbortController();
        let settlement: Settlement | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const onCallerAbort = (): void => {
            if (settlement === null) {
                settlement = { kind: 'cancelled' };
            }
            controller.abort();
        };
        options.signal?.addEventListener('abort', onCallerAbort, { once: true });

        const boundary = new Promise<Settlement>((resolve) => {
            if (privateDeadlineMs !== undefined) {
                timer = setTimeout(() => {
                    if (settlement === null) {
                        settlement = { kind: 'timeout' };
                    }
                    controller.abort();
                    resolve(settlement);
                }, privateDeadlineMs);
            }
            options.signal?.addEventListener('abort', () => {
                resolve({ kind: 'cancelled' });
            }, { once: true });
        });

        const release = (): void => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            options.signal?.removeEventListener('abort', onCallerAbort);
        };

        try {
            let materialized: PosthogMaterializationOutcome;
            try {
                materialized = await Promise.race([
                    materializeHeaders(
                        { origin: origin as string },
                        { signal: controller.signal },
                    ),
                    boundary.then((reached): never => {
                        throw reached;
                    }),
                ]);
            } catch (error) {
                if (settlement !== null) {
                    return { ok: false, failure: settlement };
                }
                if (error !== null && typeof error === 'object' && 'kind' in error) {
                    return { ok: false, failure: error as Settlement };
                }
                // The materializer settles its own failures, so reaching here means it
                // threw outside its contract. That is still the account boundary rather
                // than a transport fault.
                return { ok: false, failure: { kind: 'unauthorized', status: 0 } };
            }
            if (settlement !== null) {
                return { ok: false, failure: settlement };
            }
            if (!materialized.ok) {
                return { ok: false, failure: materialized.failure };
            }
            const authorization = materialized.authorization;

            const requestHeaders: Record<string, string> = {
                authorization,
                accept: 'application/json',
            };
            let body: string | undefined;
            if (request.method === 'POST') {
                requestHeaders['content-type'] = 'application/json';
                body = JSON.stringify(request.body ?? {});
            }

            let response: Response;
            try {
                response = await Promise.race([
                    transport(url, {
                        method: request.method,
                        headers: requestHeaders,
                        // A 3xx is never followed: PostHog can point an issue read at a
                        // different issue, and following it silently would return the
                        // wrong entity under the requested id.
                        redirect: 'manual',
                        signal: controller.signal,
                        ...(body === undefined ? {} : { body }),
                    }),
                    boundary.then((reached): never => {
                        throw reached;
                    }),
                ]);
            } catch {
                if (settlement !== null) {
                    return { ok: false, failure: settlement };
                }
                return { ok: false, failure: { kind: 'transport' } };
            }

            if (settlement !== null) {
                return { ok: false, failure: settlement };
            }

            const failure = classifyPosthogResponseStatus(response.status, response.headers, now());
            if (failure !== null) {
                return { ok: false, failure };
            }

            let decoded: unknown;
            try {
                decoded = await response.json();
            } catch {
                if (settlement !== null) {
                    return { ok: false, failure: settlement };
                }
                return { ok: false, failure: { kind: 'malformedResponse', at: 'body' } };
            }

            const value = parse(decoded);
            if (value === null) {
                return { ok: false, failure: { kind: 'malformedResponse', at: 'schema' } };
            }
            return { ok: true, value };
        } finally {
            release();
        }
    }

    return {
        async requestJson(request, parse, options) {
            return await send(
                buildUrl(origin, request.path, request.query),
                request,
                parse,
                options,
            );
        },
        async followJson(absoluteUrl, parse, options) {
            // The admission rule for a URL a source did not build is identical on
            // every forge, so it has one owner. PostHog's own origin comparison was
            // a weaker second copy of it: it admitted userinfo and a fragment,
            // because `URL.origin` carries neither.
            const admitted = admitForgeRequestUrl(absoluteUrl, origin as string);
            if (admitted === null) {
                return { ok: false, failure: { kind: 'originMismatch' } };
            }
            return await send(
                admitted,
                { method: 'GET', path: admitted },
                parse,
                options,
            );
        },
    };
}
