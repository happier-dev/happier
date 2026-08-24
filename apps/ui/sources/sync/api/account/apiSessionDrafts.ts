import {
    SESSION_DRAFT_ROUTE_LIST,
    SESSION_DRAFT_ROUTE_MUTATE,
    SESSION_DRAFT_ROUTE_READ,
    SessionDraftListRequestV1Schema,
    SessionDraftListResponseV1Schema,
    SessionDraftMutateRequestV1Schema,
    SessionDraftMutateResponseV1Schema,
    SessionDraftReadRequestV1Schema,
    SessionDraftReadResponseV1Schema,
    type SessionDraftAddressV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import type { SessionDraftRepositoryTransport } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

async function postJson(params: Readonly<{
    credentials: AuthCredentials;
    path: string;
    body: unknown;
}>): Promise<unknown> {
    const response = await serverFetch(params.path, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.credentials.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(params.body),
    }, { includeAuth: false });
    let raw: unknown;
    try {
        raw = await response.json();
    } catch {
        raw = null;
    }
    if (!response.ok) throw new Error(`Session draft request failed (${response.status})`);
    return raw;
}

export function createApiSessionDraftsTransport(params: Readonly<{
    credentials: AuthCredentials;
}>): SessionDraftRepositoryTransport {
    return {
        read: async (address: SessionDraftAddressV1) => {
            const request = SessionDraftReadRequestV1Schema.parse({ address });
            const parsed = SessionDraftReadResponseV1Schema.safeParse(await postJson({
                credentials: params.credentials,
                path: SESSION_DRAFT_ROUTE_READ,
                body: request,
            }));
            if (!parsed.success) throw new Error('Invalid session draft response');
            return parsed.data;
        },
        list: async (request) => {
            const body = SessionDraftListRequestV1Schema.parse(request);
            const parsed = SessionDraftListResponseV1Schema.safeParse(await postJson({
                credentials: params.credentials,
                path: SESSION_DRAFT_ROUTE_LIST,
                body,
            }));
            if (!parsed.success) throw new Error('Invalid session draft response');
            return parsed.data;
        },
        mutate: async (request) => {
            const body = SessionDraftMutateRequestV1Schema.parse(request);
            const parsed = SessionDraftMutateResponseV1Schema.safeParse(await postJson({
                credentials: params.credentials,
                path: SESSION_DRAFT_ROUTE_MUTATE,
                body,
            }));
            if (!parsed.success) throw new Error('Invalid session draft response');
            return parsed.data;
        },
    };
}
