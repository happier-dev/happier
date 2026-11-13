import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { resolveEffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import { deleteSessionTree } from '@/app/session/delete/deleteSessionTree';
import { setSessionManager } from '../follow/sessionManagerService';

const authentication = createPresentUserSessionAccessAuthentication({ env: {} });

describe('manager never grants Session authority (SQLite integration)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-reports-nongrant-' }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('keeps read, input, approvals, permissions and key recipients unchanged', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const create = () => db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const [child, lead] = await Promise.all([create(), create()]);
        const snapshot = () => inTx(async (tx) => ({
            ownerChild: await resolveEffectiveSessionAccess(tx, { accountId: owner.id, sessionId: child.id, authentication }),
            ownerLead: await resolveEffectiveSessionAccess(tx, { accountId: owner.id, sessionId: lead.id, authentication }),
            outsiderChild: await resolveEffectiveSessionAccess(tx, { accountId: outsider.id, sessionId: child.id, authentication }),
            outsiderLead: await resolveEffectiveSessionAccess(tx, { accountId: outsider.id, sessionId: lead.id, authentication }),
            keys: await tx.sessionDataKeyEnvelope.findMany({ where: { sessionId: { in: [child.id, lead.id] } } }),
            grants: await tx.sessionGrant.findMany({ where: { principalKind: 'account', sessionId: { in: [child.id, lead.id] } } }),
            teamGrants: await tx.sessionGrant.findMany({ where: { principalKind: 'team', sessionId: { in: [child.id, lead.id] } } }),
            groupGrants: await tx.sessionGrant.findMany({ where: { principalKind: 'group', sessionId: { in: [child.id, lead.id] } } }),
        }));
        const before = await snapshot();
        expect(await setSessionManager({ accountId: owner.id, sessionId: child.id, managerSessionId: lead.id,
            expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        expect(await snapshot()).toEqual(before);
    });

    it('deleting the lead leaves its running child as an ordinary root', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const create = () => db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: true,
            latestTurnId: randomUUID(), latestTurnStatus: 'in_progress',
        } });
        const [child, lead] = await Promise.all([create(), create()]);
        expect((await setSessionManager({ accountId: owner.id, sessionId: child.id, managerSessionId: lead.id,
            expectedManagerSessionId: null, authentication })).ok).toBe(true);
        await inTx((tx) => deleteSessionTree(tx, {
            sessionId: lead.id, sessionUpdatedAt: lead.updatedAt, actorAccountId: owner.id, reason: 'user_request',
        }));
        expect(await db.session.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({
            active: true, latestTurnId: child.latestTurnId, latestTurnStatus: 'in_progress',
        });
        expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toBeNull();
    });
});
