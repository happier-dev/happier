import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { isStoredJsonContentEnvelopeModeCompatible } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { db } from '@/storage/db';
import type { HomeSearchCanonicalPageReader } from './homeSearchIndexer';

/**
 * Canonical SessionMessage reader feeding Home search reconciliation.
 * Transcript rows remain the only source of truth; this reader never mutates them.
 */
export const readCanonicalSessionMessagesPage: HomeSearchCanonicalPageReader = async ({ sessionIds, afterId, limit }) => {
    if (sessionIds.length === 0) return { messages: [] };
    const rows = await db.sessionMessage.findMany({
        where: { sessionId: { in: [...sessionIds] }, ...(afterId ? { id: { gt: afterId } } : {}) },
        select: {
            id: true,
            sessionId: true,
            seq: true,
            messageRole: true,
            content: true,
            createdAt: true,
            updatedAt: true,
            session: { select: { encryptionMode: true } },
        },
        orderBy: { id: 'asc' },
        take: Math.max(1, Math.min(500, Math.trunc(limit))),
    });
    const messages = rows.flatMap((row) => {
        const content = SessionStoredMessageContentSchema.safeParse(row.content);
        const sessionMode = row.session.encryptionMode;
        if (
            !content.success
            || (sessionMode !== 'plain' && sessionMode !== 'e2ee')
            || !isStoredJsonContentEnvelopeModeCompatible(sessionMode, content.data)
        ) {
            return [];
        }
        return [{
            id: row.id,
            sessionId: row.sessionId,
            seq: row.seq,
            createdAtMs: row.createdAt.getTime(),
            updatedAtMs: row.updatedAt.getTime(),
            role: row.messageRole,
            content: content.data,
        }];
    });
    const nextAfterId = rows.length === limit ? rows.at(-1)?.id : undefined;
    return { messages, ...(nextAfterId ? { nextAfterId } : {}) };
};
