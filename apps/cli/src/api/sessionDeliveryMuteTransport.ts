import axios from '@/api/client/credentialAxios';
import { resolveSessionFollowActionRequest, parseSessionFollowActionResponse } from '@happier-dev/protocol/sessions/follow/actionTransport';
import type { FollowDeliveryMuteScopeV1, FollowReceiverRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

type SessionDeliveryMuteReadInput = Readonly<{ token: string; signal?: AbortSignal }> & (
    | Readonly<{ receiver: Extract<FollowReceiverRefV1, { kind: 'session' }>; serverHttpBaseUrl?: string;
        authorizeRequest?: (request: Readonly<{ method: 'GET'; path: string }>) => Readonly<Record<string, string>> | null }>
    | Readonly<{ receiver: Extract<FollowReceiverRefV1, { kind: 'account' }>; serverHttpBaseUrl: string;
        accountId: string; authorizeRequest?: never }>
);

/** Reads the captured Home's receiver preference. Null means unavailable, never unmuted. */
export async function readSessionDeliveryMutedScopes(input: SessionDeliveryMuteReadInput): Promise<readonly FollowDeliveryMuteScopeV1[] | null> {
    if (input.signal?.aborted) return null;
    if (input.receiver.kind === 'account' && (!input.serverHttpBaseUrl?.trim()
        || !('accountId' in input) || !input.accountId.trim()
        || readAccountIdFromToken(input.token) !== input.accountId || input.authorizeRequest)) return null;
    const actionInput = { receiver: input.receiver };
    const request = resolveSessionFollowActionRequest('session.delivery.mute.list', actionInput);
    try {
        const headers = input.authorizeRequest?.({ method: 'GET', path: request.path })
            ?? (input.authorizeRequest ? null : { Authorization: `Bearer ${input.token}` });
        if (!headers) return null;
        const response = await axios.get<unknown>(`${input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}${request.path}`, {
            headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
        });
        if (input.signal?.aborted || response.status < 200 || response.status >= 300) return null;
        return parseSessionFollowActionResponse('session.delivery.mute.list', actionInput, response.data).scopes;
    } catch {
        return null;
    }
}

/** Account reads never borrow the ambient Home or a replacement Account's credential. */
export function readAccountSessionDeliveryMutedScopes(input: Readonly<{
    serverHttpBaseUrl: string; accountId: string; token: string; signal?: AbortSignal;
}>): Promise<readonly FollowDeliveryMuteScopeV1[] | null> {
    return readSessionDeliveryMutedScopes({ ...input, receiver: { kind: 'account' } });
}
