import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { deletePendingMessage, enqueuePendingMessage, markPendingActivationFailed, updatePendingRequestedAction } from '@/app/session/pending/pendingMessageService';
import { mapPendingActivationAuthorization } from '@/app/session/pending/pendingActivationAuthorization';
import { createSessionPersonalAttentionProjectionSelect, loadSessionViewerProjection } from './projection';
import { countSessionPersonalAttentionRowsInTx, createSessionPersonalAttentionQueryInTx } from './queries';

const authentication = createPresentUserSessionAccessAuthentication();

describe('failed pending activation attention (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'pending-activation-attention-', initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', active: false, currentStorageState: 'hosted' } });
        // The released same-owner, uninstalled Machine path is sufficient for real input admission.
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId: machine.id, data: 'test-key' } });
        const localId = randomUUID();
        expect(await enqueuePendingMessage({ actorUserId: account.id, authentication, sessionId: session.id, localId,
            targetMachineId: machine.id, requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained original input' } } } }))
            .toMatchObject({ ok: true });
        const read = () => loadSessionViewerProjection({ accountId: account.id, sessionId: session.id, authentication });
        const membership = () => inTx(async tx => {
            const query = createSessionPersonalAttentionQueryInTx(tx, { accountId: account.id });
            const rows = await tx.session.findMany({ where: { AND: [{ id: session.id }, query.candidateWhere] },
                select: createSessionPersonalAttentionProjectionSelect(account.id) });
            return (await query.admitRows(rows)).map(row => row.id);
        });
        const fail = async () => {
            const authorization = mapPendingActivationAuthorization(await db.session.findUniqueOrThrow({ where: { id: session.id } }));
            if (!authorization) throw new Error('Input admission did not arm activation');
            expect(await markPendingActivationFailed({ actorUserId: account.id, sessionId: session.id, requestId: localId,
                requestedAt: authorization.requestedAt, failureCode: 'managed_start_failed' })).toMatchObject({ ok: true, didFail: true });
        };
        return { account, session, localId, read, membership, fail };
    }

    it('admits definitely failed activation to personal attention while preserving queued input', async () => {
        const f = await fixture();
        expect((await f.read())?.attention.needsAttention).toBe(false);
        expect(await f.membership()).toEqual([]);
        await f.fail();
        expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: f.session.id, localId: f.localId } } }))
            .toMatchObject({ status: 'queued', deliveryState: null });
        expect(await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).toMatchObject({ pendingBlockedCount: 0 });
        expect((await f.read())?.attention).toMatchObject({ needsAttention: true, primary: 'pending_blocked', reasons: ['pending_blocked'] });
        expect(await f.membership()).toEqual([f.session.id]);
        expect(await inTx(tx => countSessionPersonalAttentionRowsInTx(tx, { accountId: f.account.id, where: { id: f.session.id } }))).toBe(1);
    });

    it('clears failure attention when retry rearms the same pending input and Session', async () => {
        const f = await fixture();
        await f.fail();
        expect((await f.read())?.attention.reasons).toContain('pending_blocked');
        expect(await updatePendingRequestedAction({ actorUserId: f.account.id, authentication, sessionId: f.session.id,
            localId: f.localId, requestedAction: { v: 1, kind: 'send_now' }, resumeWhenAvailable: true }))
            .toMatchObject({ ok: true });
        expect(mapPendingActivationAuthorization(await db.session.findUniqueOrThrow({ where: { id: f.session.id } })))
            .toMatchObject({ requestId: f.localId, status: 'waiting' });
        expect((await f.read())?.attention.needsAttention).toBe(false);
        expect(await f.membership()).toEqual([]);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.session.id, localId: f.localId, status: 'queued' } })).toBe(1);
    });

    it('clears failure attention when the original input is withdrawn', async () => {
        const f = await fixture();
        await f.fail();
        expect((await f.read())?.attention.reasons).toContain('pending_blocked');
        expect(await deletePendingMessage({ actorUserId: f.account.id, authentication, sessionId: f.session.id,
            localId: f.localId, withdraw: true })).toMatchObject({ ok: true });
        expect(mapPendingActivationAuthorization(await db.session.findUniqueOrThrow({ where: { id: f.session.id } }))).toBeUndefined();
        expect((await f.read())?.attention.needsAttention).toBe(false);
        expect(await f.membership()).toEqual([]);
    });
});
