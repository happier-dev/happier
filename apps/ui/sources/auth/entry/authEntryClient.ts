import {
    AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1,
    AuthEntryProjectionV1Schema,
    type AuthEntryRequestV1,
    type AuthEntryProjectionV1,
} from '@happier-dev/protocol/auth/entry';

import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createServerFetchAtEndpoint, serverFetch } from '@/sync/http/client';
import { decodeBoundedJsonResponse } from '@/sync/api/capabilities/decodeBoundedJsonResponse';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

export type AuthEntryFetchResult =
    | Readonly<{ kind: 'ready'; projection: AuthEntryProjectionV1 }>
    | Readonly<{ kind: 'unsupported' }>
    | Readonly<{ kind: 'incompatible' }>
    | Readonly<{ kind: 'unavailable' }>;

export type HomeAuthEntryFetchResult = AuthEntryFetchResult;

type AuthEntryTransportInput = Readonly<{
    endpointUrl?: string;
    runtimeOrigin?: string | null;
    homeCarrier?: HomeCarrier;
    serverId?: string;
    /**
     * Ask as this exact already-authenticated Account.
     *
     * The credential is never ambient: it is resolved by the canonical
     * server-Account request authority, which also refuses to answer if the
     * resolved Account is not the requested one. Omitting the scope — or being
     * unable to resolve that authority — asks anonymously, which is the same
     * answer the Home gives an unauthenticated visitor.
     */
    accountScope?: ServerAccountScope;
    signal?: AbortSignal;
}>;

type AuthEntryRequestInput = AuthEntryRequestV1 extends infer Request
    ? Request extends Readonly<{ v: 1 }>
        ? Omit<Request, 'v'>
        : never
    : never;

async function decodeAuthEntryResponse(response: Response): Promise<AuthEntryFetchResult> {
    if (response.status === 404 || response.status === 405 || response.status === 501) {
        return { kind: 'unsupported' };
    }
    if (!response.ok) return { kind: 'unavailable' };
    const raw = await decodeBoundedJsonResponse(response, AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1);
    if (raw === null) return { kind: 'incompatible' };
    const parsed = AuthEntryProjectionV1Schema.safeParse(raw);
    return parsed.success
        ? { kind: 'ready', projection: parsed.data }
        : { kind: 'incompatible' };
}

export async function fetchAuthEntry(
    input: AuthEntryTransportInput & AuthEntryRequestInput,
): Promise<AuthEntryFetchResult> {
    if (input.scope.kind !== 'home' && !input.endpointUrl) return { kind: 'unavailable' };
    const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            v: 1,
            scope: input.scope,
            ...(input.purpose && input.purpose !== 'home' ? { purpose: input.purpose } : {}),
        }),
        ...(input.signal ? { signal: input.signal } : {}),
    };

    if (input.accountScope) {
        try {
            return await runWithServerRequestAuthorityForServerAccountScope({
                scope: input.accountScope,
                // An entry projection is always explicitly addressed. Falling back
                // to the focused Home would ask a different Home about this Team.
                activeRequest: async () => {
                    throw new Error('Auth entry requires an explicit Home target');
                },
            }, async (authority) => await decodeAuthEntryResponse(
                await authority.request('/v1/auth/entry', init),
            ));
        } catch {
            // An exact Account request must never degrade to an anonymous
            // projection: that could present weaker, misleading admission
            // actions for the requested identity.
            return { kind: 'unavailable' };
        }
    }

    const request = input.endpointUrl
        ? createServerFetchAtEndpoint({
            endpointUrl: input.endpointUrl,
            ...(input.runtimeOrigin ? { runtimeOrigin: input.runtimeOrigin } : {}),
            ...(input.homeCarrier ? { homeCarrier: input.homeCarrier } : {}),
            ...(input.serverId ? { serverId: input.serverId } : {}),
            credentials: null,
            ...(input.signal ? { signal: input.signal } : {}),
        })
        : serverFetch;
    let response: Response;
    try {
        response = await request('/v1/auth/entry', init, { includeAuth: false, retry: 'none' });
    } catch {
        return { kind: 'unavailable' };
    }
    return await decodeAuthEntryResponse(response);
}

export async function fetchHomeAuthEntry(
    input: AuthEntryTransportInput & Omit<
        Extract<AuthEntryRequestV1, { scope: { kind: 'home' } }>,
        'v' | 'scope'
    > = {},
): Promise<HomeAuthEntryFetchResult> {
    return await fetchAuthEntry({ ...input, scope: { kind: 'home' } });
}
