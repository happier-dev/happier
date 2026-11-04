import { PatchSessionDataKeyEnvelopesResultV1Schema, SessionDataKeyEnvelopeErrorCodeV1Schema, SessionDataKeyEnvelopePageV1Schema } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { CurrentSessionDataKeyEnvelopeTransport } from '@/sync/encryption/prepareCurrentSessionDataKeyEnvelopes';
import type { ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import type { ServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { SessionAccessApiError } from './sessionAccessHttpFailure';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';

const envelopePages = createScopedResolutionSingleFlight<ReturnType<typeof SessionDataKeyEnvelopePageV1Schema.parse>>();

/** Discovery/preparation read exceptions; only explicit diagnostics read the whole audience. */
export type SessionDataKeyEnvelopeCollectionState = 'action_required' | 'all';

export type BoundEnvelopeCollection = Readonly<{
    authority: ServerAccountRequestAuthority;
    guard: ServerAccountScopeRequestGuard;
    sessionId: string;
}>;

function envelopeCollectionPath(sessionId: string): string {
    return `/v2/sessions/${encodeURIComponent(sessionId)}/data-key/envelopes`;
}

/** The Protocol/server page bound remains the only limit owner. */
function envelopePageQuery(cursor: string | null, state: SessionDataKeyEnvelopeCollectionState): string {
    const query = new URLSearchParams({ state });
    if (cursor) query.set('cursor', cursor);
    return `?${query.toString()}`;
}

async function requestEnvelopeCollection(bound: Readonly<{
    authority: Pick<ServerAccountRequestAuthority, 'request'>;
    guard: ServerAccountScopeRequestGuard;
}>,
    params: Readonly<{ path: string; init?: RequestInit }>): Promise<unknown> {
    bound.guard.check();
    const response = await bound.authority.request(params.path, { ...params.init, signal: bound.guard.signal });
    bound.guard.check();
    const payload: unknown = await response.json();
    bound.guard.check();
    return admitEnvelopeResponse(response, payload);
}

function admitEnvelopeResponse(response: Pick<Response, 'ok' | 'status'>, payload: unknown): unknown {
    if (!response.ok) {
        const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(response.status, payload);
        if (scopeDenial) throw new SessionAccessApiError(scopeDenial.errorCode, response.status);
        const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
        const code = SessionDataKeyEnvelopeErrorCodeV1Schema.safeParse(record.error);
        throw new SessionAccessApiError(code.success ? code.data : 'session_data_key_envelope_request_failed', response.status);
    }
    return payload;
}

/** One captured authority spans discovery and every mutation of a preparation pass. */
export function createEnvelopeTransport(bound: Readonly<{
    authority: Pick<ServerAccountRequestAuthority, 'request' | 'readTransport'>;
    guard: ServerAccountScopeRequestGuard;
    sessionId: string;
}>,
    state: SessionDataKeyEnvelopeCollectionState = 'action_required'): CurrentSessionDataKeyEnvelopeTransport {
    const path = envelopeCollectionPath(bound.sessionId);
    const transport = bound.authority.readTransport;
    const readScope = (key = transport?.key) => transport?.scope ?? (key ? JSON.stringify([key, bound.sessionId]) : undefined);
    return {
        fetchPage: async cursor => {
            bound.guard.check();
            const transportKey = transport?.key;
            const scope = readScope(transportKey);
            const key = JSON.stringify([transportKey ?? null, bound.sessionId, state, cursor || null]);
            try {
                return await envelopePages.run(key, async signal => {
                    const consume = async (response: Response) => SessionDataKeyEnvelopePageV1Schema.parse(
                        admitEnvelopeResponse(response, await response.json()));
                    const pagePath = `${path}${envelopePageQuery(cursor, state)}`;
                    return transport ? await transport.read(pagePath, { signal }, undefined, consume)
                        : await consume(await bound.authority.request(pagePath, { signal }));
                }, { scope, signal: bound.guard.signal, fresh: !transport });
            } finally { bound.guard.check(); }
        },
        patchPage: async request => {
            bound.guard.check();
            const scope = readScope();
            try {
                return PatchSessionDataKeyEnvelopesResultV1Schema.parse(await requestEnvelopeCollection(bound, { path, init: {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
                } }));
            } finally {
                // A settled write, including an unknown commit outcome, cannot lend its pre-write page to recovery.
                if (scope !== undefined) envelopePages.invalidate(scope);
                const currentScope = readScope();
                if (currentScope !== undefined && currentScope !== scope) envelopePages.invalidate(currentScope);
            }
        },
    };
}
