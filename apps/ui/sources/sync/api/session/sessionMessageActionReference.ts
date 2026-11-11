import { resolveMessageActionSnapshotFromCurrentMessageV1 } from '@happier-dev/session-core/messages';
import { fetchSessionMessagesPage, openSessionStoredContent, type SessionStoredContentContext } from '@happier-dev/sync-client';
import { MessageActionDurableResolutionV1Schema, type MessageActionReferenceV1, type MessageActionResolutionV1 } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { serverFetch } from '@/sync/http/client';

/** Account placement uses the same server admission and pure snapshot resolver as Machine placement. */
export async function resolveAccountMessageActionReference(input: Readonly<{
    scope: ServerAccountScope; reference: MessageActionReferenceV1; signal: AbortSignal; isCurrent: () => boolean;
}>): Promise<MessageActionResolutionV1> {
    const unavailable = { status: 'unavailable' } as const;
    try {
        return await runWithServerAccountScopeRequestGuard({ ...input,
            staleError: () => new Error('Message Action scope retired'),
        }, async guard => runWithServerRequestAuthorityForServerAccountScope({ scope: input.scope,
            activeRequest: serverFetch,
        }, async authority => {
            const { reference } = input;
            const response = await authority.request(`/v1/sessions/${encodeURIComponent(reference.sessionId)}/messages/action-reference/resolve`,
                { method: 'POST', body: JSON.stringify(reference), headers: { 'Content-Type': 'application/json' }, signal: guard.signal }, { retry: 'none' });
            guard.check();
            if (!response.ok) return unavailable;
            const durable = MessageActionDurableResolutionV1Schema.safeParse(await response.json());
            if (!durable.success) return unavailable;
            if (durable.data.status !== 'available') return durable.data;
            const { session } = await readSessionSnapshotForAuthority({ authority, sessionId: reference.sessionId,
                includeTurns: false, signal: guard.signal, isCurrent: guard.isCurrent });
            guard.check();
            const encryption = authority.context.encryption?.getSessionEncryption(reference.sessionId) ?? null;
            const context: SessionStoredContentContext = session.encryptionMode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', encryption };
            const page = await fetchSessionMessagesPage({ sessionId: reference.sessionId, messageId: reference.messageId, scope: 'all',
                signal: guard.signal, requestJson: async (path, signal) => {
                    const reply = await authority.request(path, { signal }, { retry: 'none' });
                    if (!reply.ok) throw new Error('Message Action row unavailable');
                    return reply.json();
                } });
            guard.check();
            const row = page.messages.length === 1 ? page.messages[0] : undefined;
            if (!row?.messageActionReference || row.id !== reference.messageId) return unavailable;
            const opened = await openSessionStoredContent(context, row.content);
            guard.check();
            if (opened.status !== 'ready') return unavailable;
            return resolveMessageActionSnapshotFromCurrentMessageV1({ reference, durableResolution: durable.data,
                currentMessage: { sessionId: row.messageActionReference.sessionId, messageId: row.id,
                    observedRevision: row.messageActionReference.observedRevision, seq: row.seq,
                    messageRole: row.messageRole ?? null, decryptedContent: opened.value } });
        }));
    } catch { return unavailable; }
}
