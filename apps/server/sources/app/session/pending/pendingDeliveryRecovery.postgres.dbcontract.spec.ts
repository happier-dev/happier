import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionMessageReplyProgressV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { listPendingMessages } from './pendingMessageService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Pending recovery projection (real PostgreSQL)', () => {
    let connected = false;
    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error('Use the task-owned disposable PostgreSQL harness');
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it('selects reply custody for plain and reply-bearing originals without disclosing it', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        try {
            const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
            const reply = SessionMessageReplyProgressV1Schema.parse({ v: 1, mode: 'wait', disposition: 'observing' });
            for (const [position, replyProgress] of [null, reply].entries()) {
                await db.sessionPendingMessage.create({ data: {
                    sessionId: session.id, localId: `original-${position}`, position, status: 'queued', messageRole: 'user',
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'uncertain input' } } },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    deliveryState: 'blocked', deliveryBlockedReason: 'delivery_outcome_uncertain',
                    ...(replyProgress ? { replyProgress } : {}),
                } });
            }
            const result = await listPendingMessages({ actorUserId: account.id, sessionId: session.id,
                authentication: createPresentUserSessionAccessAuthentication() });
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.error);
            expect(result.pending.map(row => ({ localId: row.localId, recovery: row.recovery }))).toEqual([
                { localId: 'original-0', recovery: { canSendAsNew: true } },
                { localId: 'original-1', recovery: { canSendAsNew: false } },
            ]);
            expect(result.pending.every(row => !('replyProgress' in row))).toBe(true);
        } finally {
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
