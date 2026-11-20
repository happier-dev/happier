import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { updateSessionMessageAtCurrentRevisionInTx } from '@/app/session/sessionMessageRevisionWrite';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('message revisions retain their parent Session recency', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'session-message-recency-', initAuth: false });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('clears the previous part on content corrections and preserves terminal expiry', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}', seq: 2,
        } });
        const original = { t: 'plain' as const, v: { role: 'agent', text: 'initial shell' } };
        const replacement = { t: 'plain' as const, v: { role: 'agent', text: 'replacement' } };
        const available = await db.sessionMessage.create({ data: {
            sessionId: session.id, seq: 1, localId: 'available', content: original,
            toolOutputBytes: new TextEncoder().encode('fixture detached bytes'),
        } });
        const expired = await db.sessionMessage.create({ data: {
            sessionId: session.id, seq: 2, localId: 'expired', content: original, toolOutputExpiredAfterDays: 30,
        } });
        const metadataOnly = await inTx(tx => updateSessionMessageAtCurrentRevisionInTx({
            tx, id: available.id, rowRevision: available.rowRevision,
            data: { messageRole: 'agent', rowRevision: { increment: 1n } },
        }));
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: available.id } })).toolOutputBytes)
            .toEqual(available.toolOutputBytes);
        await inTx(tx => updateSessionMessageAtCurrentRevisionInTx({
            tx, id: available.id, rowRevision: metadataOnly.rowRevision,
            data: { content: replacement, rowRevision: { increment: 1n } },
        }));
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { id: available.id } }))
            .toMatchObject({ toolOutputBytes: null, toolOutputExpiredAfterDays: null });
        await expect(inTx(tx => updateSessionMessageAtCurrentRevisionInTx({
            tx, id: expired.id, rowRevision: expired.rowRevision,
            data: { content: replacement, rowRevision: { increment: 1n } },
        }))).rejects.toMatchObject({ code: 'session_tool_output_already_expired' });
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { id: expired.id } })).toEqual(expired);
    });

    it('advances Session.updatedAt for a content correction', async () => {
        const before = new Date('2020-01-01T00:00:00Z');
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
            updatedAt: before, lastActiveAt: before,
        } });
        const content = { t: 'plain' as const, v: { role: 'agent', text: 'original' } };
        const message = await db.sessionMessage.create({ data: {
            sessionId: session.id, seq: 1, localId: randomUUID(), messageRole: 'agent', content,
        } });
        await inTx(tx => updateSessionMessageAtCurrentRevisionInTx({ tx, id: message.id,
            rowRevision: message.rowRevision, data: {
                content: { t: 'plain', v: { role: 'agent', text: 'corrected' } },
                rowRevision: { increment: BigInt(1) },
            } }));
        const current = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        expect(current.updatedAt.getTime()).toBeGreaterThan(before.getTime());
        expect(current.lastActiveAt).toEqual(before);
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(1);
    });
});
