import type { ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionByIdHttp } from '@/sync/engine/sessions/sessionByIdHttp';

import type { ServedSessionKeyRow } from '@/sync/encryption/readTransferableSessionDataKey';

/** Standalone key refresh when no admitted Session detail is already available. */
export async function readServedSessionKeyRow(params: Readonly<{
    authority: ServerAccountRequestAuthority;
    sessionId: string;
    check(): void;
}>): Promise<ServedSessionKeyRow | null> {
    const token = params.authority.context.credentials?.token;
    if (!token) return null;
    const read = await readSessionByIdHttp({ sessionId: params.sessionId, serverId: params.authority.scope.serverId,
        token, request: params.authority.request, projection: 'detail' });
    params.check();
    const session = read.ok && read.body && typeof read.body === 'object'
        ? (read.body as Readonly<{ session?: unknown }>).session : null;
    return session && typeof session === 'object' && (session as Readonly<{ id?: unknown }>).id === params.sessionId
        ? session as Readonly<Record<string, unknown>> : null;
}
