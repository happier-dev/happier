import { PendingLocalIdSchema } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';

/** Home Pending admission boundary; Session encryption, provenance and delivery stay real. */
export function createSessionPendingHttpBoundary(sessionId: string) {
    const enqueued = new Map<string, {
        localId: ReturnType<typeof PendingLocalIdSchema.parse>;
        requestedAction: ReturnType<typeof PendingRequestedActionV1Schema.parse>;
        content: ReturnType<typeof SessionStoredMessageContentSchema.parse>;
    }>();
    return {
        enqueued,
        handle(input: URL | RequestInfo, init?: RequestInit): Response | null {
            if (new URL(String(input)).pathname !== `/v2/sessions/${encodeURIComponent(sessionId)}/pending`
                || init?.method !== 'POST') return null;
            const body: unknown = JSON.parse(String(init.body));
            if (!body || typeof body !== 'object') throw new Error('Expected Pending enqueue request');
            const row = {
                localId: PendingLocalIdSchema.parse(Reflect.get(body, 'localId')),
                requestedAction: PendingRequestedActionV1Schema.parse(Reflect.get(body, 'requestedAction')),
                content: SessionStoredMessageContentSchema.parse(Reflect.get(body, 'content') ?? Reflect.get(body, 'ciphertext')),
            };
            const didWrite = !enqueued.has(row.localId);
            if (didWrite) enqueued.set(row.localId, row);
            return Response.json({ didWrite, pendingCount: enqueued.size, pendingVersion: enqueued.size,
                requestedAction: row.requestedAction, pending: { ...enqueued.get(row.localId),
                    status: 'queued', position: enqueued.size, createdAt: 1, updatedAt: 1,
                    discardedAt: null, discardedReason: null } });
        },
    };
}
