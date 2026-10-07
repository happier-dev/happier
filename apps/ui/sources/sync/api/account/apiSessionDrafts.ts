import { SESSION_DRAFT_ROUTE_MUTATE, SESSION_DRAFT_ROUTE_READ, SessionDraftMutateRequestV1Schema, SessionDraftReadRequestV1Schema } from '@happier-dev/protocol/drafts/sessionDrafts';
import { SESSION_DRAFT_V2_ROUTE_LIST, SESSION_DRAFT_V2_ROUTE_MUTATE, SESSION_DRAFT_V2_ROUTE_READ, SessionDraftEpochUnavailableResponseV2Schema, SessionDraftListRequestV2Schema, SessionDraftListResponseV2Schema, SessionDraftMutateRequestV2Schema, SessionDraftMutateResponseV2Schema, SessionDraftReadRequestV2Schema, SessionDraftReadResponseV2Schema, isSessionDraftAddressV1, isSessionDraftContentV1, type SessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';

import type { SessionDraftRepositoryTransport } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { SessionDraftEpochUnavailableError, isSessionDraftEpochUnavailableError } from '@/sync/ops/sessionDrafts/sessionDraftEpochError';

/** Statuses a Home without the V2 draft epoch returns for these exact paths. */
const EPOCH_UNAVAILABLE_STATUSES = new Set([404, 405, 501]);

async function postJson(params: Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
    path: string;
    body: unknown;
    epoch: 'v1' | 'v2';
}>): Promise<unknown> {
    const response = await params.request(params.path, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(params.body),
    });
    let raw: unknown;
    try {
        raw = await response.json();
    } catch {
        raw = null;
    }
    if (!response.ok) {
        // An unsupported V2 operation keeps the local draft; it is never retried
        // through V1 or coerced onto another address.
        if ((params.epoch === 'v2' && EPOCH_UNAVAILABLE_STATUSES.has(response.status))
            || (response.status === 409 && SessionDraftEpochUnavailableResponseV2Schema.safeParse(raw).success)) {
            throw new SessionDraftEpochUnavailableError();
        }
        throw new Error(`Session draft request failed (${response.status})`);
    }
    return raw;
}

/**
 * One transport over both route epochs.
 *
 * V2 is the primary read epoch for every address: its response union admits
 * the closed V1 payload produced by 0.2 and it can read V2-only rows without a
 * V1 409 probe. A V1 fallback is retained only when a V2 endpoint is absent
 * on an older Home. Writes retain their content-based epoch selection and
 * never coerce a V2 payload into V1.
 */
export function createApiSessionDraftsTransport(params: Readonly<{
    /** Exact Home/Account request captured by the canonical scoped-request owner. */
    request: (path: string, init?: RequestInit) => Promise<Response>;
}>): SessionDraftRepositoryTransport {
    const epochOf = (address: SessionDraftAddressV2): 'v1' | 'v2' => (
        isSessionDraftAddressV1(address) ? 'v1' : 'v2'
    );
    return {
        read: async (address: SessionDraftAddressV2) => {
            const v2Request = SessionDraftReadRequestV2Schema.parse({ address });
            let raw: unknown;
            try {
                raw = await postJson({
                    request: params.request,
                    path: SESSION_DRAFT_V2_ROUTE_READ,
                    body: v2Request,
                    epoch: 'v2',
                });
            } catch (error) {
                if (!isSessionDraftEpochUnavailableError(error) || !isSessionDraftAddressV1(address)) throw error;
                const v1Request = SessionDraftReadRequestV1Schema.parse({ address });
                raw = await postJson({
                    request: params.request,
                    path: SESSION_DRAFT_ROUTE_READ,
                    body: v1Request,
                    epoch: 'v1',
                });
            }
            const parsed = SessionDraftReadResponseV2Schema.safeParse(raw);
            if (!parsed.success) throw new Error('Invalid session draft response');
            return parsed.data;
        },
        list: async (request) => {
            const body = SessionDraftListRequestV2Schema.parse(request);
            const raw = await postJson({ request: params.request, path: SESSION_DRAFT_V2_ROUTE_LIST, body, epoch: 'v2' });
            const parsed = SessionDraftListResponseV2Schema.safeParse(raw);
            if (!parsed.success) throw new Error('Invalid session draft response');
            return parsed.data;
        },
        mutate: async (request) => {
            const epoch = epochOf(request.address) === 'v1' && isSessionDraftContentV1(request.content) ? 'v1' : 'v2';
            const body = epoch === 'v1'
                ? SessionDraftMutateRequestV1Schema.parse(request)
                : SessionDraftMutateRequestV2Schema.parse(request);
            let raw: unknown;
            try {
                raw = await postJson({
                    request: params.request,
                    path: epoch === 'v1' ? SESSION_DRAFT_ROUTE_MUTATE : SESSION_DRAFT_V2_ROUTE_MUTATE,
                    body,
                    epoch,
                });
            } catch (error) {
                if (epoch !== 'v1' || !isSessionDraftEpochUnavailableError(error)) throw error;
                raw = await postJson({ request: params.request, path: SESSION_DRAFT_V2_ROUTE_MUTATE, body, epoch: 'v2' });
            }
            const parsed = SessionDraftMutateResponseV2Schema.safeParse(raw);
            if (!parsed.success) throw new Error('Invalid session draft response');
            return parsed.data;
        },
    };
}
