/**
 * The one authenticated PostHog client for a source invocation.
 *
 * The API client owns request construction, credentials never leave the request closure,
 * and this adapter owns the host boundary that materializes them for one exact Connected
 * Account/origin pair. Keeping that pair here lets aggregate reads, mounted detail reads,
 * and a Composer reference reread use the same currentness and origin admission path.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import {
    materializeTriageSourceAuthorizationV1,
    type TriageSourceAuthorizationOutcomeV1,
} from '@happier-dev/triage-sources/runtime';

import {
    createPosthogApiClient,
    type PosthogApiClient,
    type PosthogMaterializationOutcome,
    type PosthogTransportRequest,
} from './client.js';
import type { PosthogApiOrigin } from '../connect/origin.js';
import { POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from '../posthogContracts.js';

/** Statuses whose HTTP semantics forbid a body; a response must not carry one. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

function toMaterializationOutcome(
    authorized: TriageSourceAuthorizationOutcomeV1,
): PosthogMaterializationOutcome {
    if (authorized.ok) {
        return { ok: true, authorization: authorized.authorization };
    }
    return authorized.reason === 'cancelled'
        ? { ok: false, failure: { kind: 'cancelled' } }
        : { ok: false, failure: { kind: 'unauthorized', status: 0 } };
}

/**
 * Builds the one client an invocation may use against one exact account and origin.
 *
 * Each materialization receives the invocation's composed boundary, so a source-owned
 * whole-action deadline also ends account work rather than leaving it live after the
 * source has discarded the action.
 */
export function createPosthogInvocationClient(
    context: PluginInvocationContext,
    account: ConnectedAccountRef,
    origin: PosthogApiOrigin,
): PosthogApiClient {
    return createPosthogApiClient({
        origin,
        materializeHeaders: async (request, options) => {
            const authorized = await materializeTriageSourceAuthorizationV1({
                connectedAccounts: context.services.connectedAccounts,
                purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
                account,
                origin: request.origin,
                signal: options.signal,
            });
            return toMaterializationOutcome(authorized);
        },
        transport: async (url: string, request: PosthogTransportRequest) => {
            const response = await context.services.http.request({
                url,
                method: request.method,
                headers: request.headers,
                redirect: request.redirect,
                ...(request.body === undefined
                    ? {}
                    : { body: new TextEncoder().encode(request.body) }),
            }, { signal: request.signal });
            if (!Number.isInteger(response.status)
                || response.status < 200
                || response.status > 599) {
                throw new TypeError('PostHog response carried an uninterpretable status');
            }
            return new Response(
                NULL_BODY_STATUSES.has(response.status)
                    ? null
                    : new TextDecoder().decode(response.body),
                { status: response.status, headers: new Headers(response.headers) },
            );
        },
    });
}
