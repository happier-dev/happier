import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { enqueuePendingMessage, updatePendingMessage } from './pendingMessageService';
import { createSessionMessageFromPending } from './pendingMessageTranscriptCommit';

describe('Pending Usage timing follows its protected message', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'pending-usage-timing-',
        initAuth: false, initEncrypt: false, initFiles: false,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('carries %s input coverage through edits and transcript materialization', async encryptionMode => {
        const account = await db.account.create({ data: { encryptionMode } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode, metadata: '{}' } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const seal = (text: string) => encryptionMode === 'plain'
            ? { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text } } }
            : { t: 'encrypted' as const, c: text };
        const bounds = { v: 1 as const, minMs: 10, maxMs: 20 };
        const identity = { actorUserId: account.id, sessionId: session.id, localId: 'input', authentication };
        const initial = { ...identity, content: seal('first'), messageRole: 'user',
            requestedAction: { v: 1 as const, kind: 'enqueue' as const }, usageTimingV1: bounds };
        expect(await enqueuePendingMessage(initial)).toMatchObject({ ok: true });
        const read = () => db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: 'input' } } });
        expect(await read()).toMatchObject({ usageTimingV1: bounds });
        expect(await updatePendingMessage({ ...identity, content: seal('first'), messageRole: 'user' })).toMatchObject({ ok: true });
        expect(await read()).toMatchObject({ usageTimingV1: bounds });
        expect(await updatePendingMessage({ ...identity, content: seal('old writer edit'), messageRole: 'user' })).toMatchObject({ ok: true });
        expect(await read()).toMatchObject({ usageTimingV1: null });
        const replacement = { ...identity, content: seal('new writer edit'), messageRole: 'user', usageTimingV1: bounds };
        expect(await updatePendingMessage(replacement)).toMatchObject({ ok: true });
        const pending = await read();
        expect(pending).toMatchObject({ usageTimingV1: bounds });
        const commit = { sessionId: session.id, localId: 'input', sessionEncryptionMode: encryptionMode,
            storagePolicy: 'optional' as const, content: pending.content, messageRole: 'user' as const,
            usageTimingV1: bounds };
        expect(await inTx(tx => createSessionMessageFromPending(tx, commit))).toMatchObject({ ok: true, didWrite: true });
        expect(await db.sessionMessage.findFirstOrThrow({ where: { sessionId: session.id, localId: 'input' } }))
            .toMatchObject({ usageTimingV1: bounds });
    });

    it.each(['known', 'unknown', 'old-acceptor'] as const)('merges acceptance without certifying unknown history: %s', async coverage => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'e2ee', metadata: '{}' } });
        const bounds = { v: 1 as const, minMs: 10, maxMs: 20 };
        const message = await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, localId: 'accepted', messageRole: 'user',
            content: { t: 'encrypted', c: 'original' }, ...(coverage === 'unknown' ? {} : { usageTimingV1: bounds }) } });
        const commit = { sessionId: session.id, localId: 'accepted', sessionEncryptionMode: 'e2ee' as const,
            storagePolicy: 'optional' as const, content: { t: 'encrypted' as const, c: 'original' }, messageRole: 'user' as const,
            deliveryResolution: { v: 1 as const, kind: 'provider_accepted' as const, content: { t: 'encrypted' as const, c: 'receipt' } },
            ...(coverage === 'old-acceptor' ? {} : { deliveryUsageTimingV1: { v: 1 as const, minMs: 250, maxMs: 250 } }) };
        expect(await inTx(tx => createSessionMessageFromPending(tx, commit))).toMatchObject({ ok: true, didUpdate: true });
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({
            usageTimingV1: coverage === 'known' ? { v: 1, minMs: 10, maxMs: 250 } : null,
        });
        // Pending retains the original content proof; it must not replace the
        // already-settled receipt proof when the same settlement is repeated.
        expect(await inTx(tx => createSessionMessageFromPending(tx, { ...commit, usageTimingV1: bounds })))
            .toMatchObject({ ok: true, didUpdate: false });
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({
            usageTimingV1: coverage === 'known' ? { v: 1, minMs: 10, maxMs: 250 } : null,
        });
    });
});
