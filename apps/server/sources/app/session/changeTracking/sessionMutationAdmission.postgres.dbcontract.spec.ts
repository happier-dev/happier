import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from 'privacy-kit';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { db, initDbPostgres } from '@/storage/db';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { inTx, type Tx } from '@/storage/inTx';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { deleteSessionAccessGrantInTx } from '@/app/session/access/sessionAccessGrantService';
import { setSessionResponsibility } from '@/app/session/access/sessionResponsibilityService';
import { applySessionDataKeyEnvelopes } from '@/app/session/encryption/sessionDataKeyEnvelopeService';
import { applyMembershipSessionDataKeyEnvelopes } from '@/app/session/encryption/membershipSessionDataKeyEnvelopeService';
import { setTeamMembershipStatusInTx } from '@/app/teams/memberships/membershipService';
import { markAccountChanged } from '@/app/changes/markAccountChanged';

/** Deterministic interleaving before real canonical Account/Session admission. */
async function duringSessionAudienceDiscovery<T>(effect: () => Promise<unknown>, operation: () => Promise<T>): Promise<T> {
    const originalTransaction = db.$transaction;
    let interleaved = false;
    db.$transaction = new Proxy(originalTransaction, {
        apply(target, thisArg, args) {
            const callback: unknown = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, thisArg, args);
            return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                const edges = new Proxy(tx.sessionFollowEdge, {
                    get(owner, property, receiver) {
                        const method: unknown = Reflect.get(owner, property, receiver);
                        if (property !== 'findMany' || typeof method !== 'function') return method;
                        return async (...values: unknown[]) => {
                            const rows: unknown = await Reflect.apply(method, owner, values);
                            if (!interleaved) { interleaved = true; await effect(); }
                            return rows;
                        };
                    },
                });
                return Reflect.apply(callback, undefined, [new Proxy(tx, {
                    get(owner, property, receiver) {
                        return property === 'sessionFollowEdge' ? edges : Reflect.get(owner, property, receiver);
                    },
                })]);
            }, { ...(typeof args[1] === 'object' && args[1] !== null ? args[1] : {}), isolationLevel: 'ReadCommitted' }]);
        },
    });
    try { const result = await operation(); expect(interleaved).toBe(true); return result; }
    finally { db.$transaction = originalTransaction; }
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session admission consumers under cursor contention', () => {
    const authentication = createPresentUserSessionAccessAuthentication();
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres(); await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(['discovery', 'final authorization'] as const)('orders historical envelope admission with membership revocation at %s', async phase => {
        const ownerBinding = createSignedAccountContentBinding();
        const targetBinding = createSignedAccountContentBinding();
        const owner = await db.account.create({ data: { ...ownerBinding, encryptionMode: 'e2ee' } });
        const target = await db.account.create({ data: { ...targetBinding, encryptionMode: 'e2ee' } });
        const team = await db.team.create({ data: { name: randomUUID() } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: target.id, role: 'member' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'e2ee' } });
        await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: session.id, teamId: team.id, accessLevel: 'view', effectiveAt: new Date() } });
        const seal = (key: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: key, randomBytes: tweetnacl.randomBytes }));
        await db.sessionDataKeyEnvelope.create({ data: { sessionId: session.id, recipientAccountId: owner.id, encryptedDataKey: seal(ownerBinding.contentPublicKey) } });
        const originalTransaction = db.$transaction;
        let revoke: Promise<void> | undefined;
        let revoked = false;
        let revocationWon = false;
        let revokedError: unknown;
        let revocationPid: number | undefined;
        vi.stubEnv('HAPPIER_FEATURE_TEAMS__ENABLED', '1');
        db.$transaction = new Proxy(originalTransaction, { apply(transaction, receiver, args: unknown[]) {
            const operation: unknown = args[0];
            if (typeof operation !== 'function') return Reflect.apply(transaction, receiver, args);
            return Reflect.apply(transaction, receiver, [async (tx: Tx) => operation(new Proxy(tx, { get(client, property, txReceiver) {
                if (property !== 'session') return Reflect.get(client, property, txReceiver);
                return new Proxy(client.session, { get(delegate, method, delegateReceiver) {
                    const query: unknown = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'findMany' || typeof query !== 'function') return query;
                    return async (...values: unknown[]) => {
                        const rows: unknown = await Reflect.apply(query, delegate, values);
                        const args = values[0];
                        const select: unknown = typeof args === 'object' && args !== null ? Reflect.get(args, 'select') : null;
                        const finalAuthorization = typeof select === 'object' && select !== null
                            && Object.keys(select).length === 1 && Reflect.get(select, 'id') === true;
                        if (!revoke && (phase === 'discovery' || finalAuthorization)) {
                            revoke = inTx(async peer => {
                                [{ pid: revocationPid }] = await peer.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
                                await setTeamMembershipStatusInTx(peer, { teamId: team.id, membershipId: membership.id, accountId: target.id, status: 'suspended' });
                            });
                            void revoke.then(() => { revoked = true; }, error => { revokedError = error; revoked = true; });
                            while (!revoked) {
                                const [{ waiting }] = await db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
                                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock') AS waiting", revocationPid ?? -1);
                                if (waiting) break;
                            }
                            revocationWon = revoked;
                        }
                        return rows;
                    };
                } });
            } })), { ...(typeof args[1] === 'object' && args[1] !== null ? args[1] : {}), isolationLevel: 'ReadCommitted' }]);
        } });
        try {
            const result = await applyMembershipSessionDataKeyEnvelopes({ actorAccountId: owner.id, authentication,
                subject: { kind: 'team', teamId: team.id, teamMembershipId: membership.id },
                request: { recipientAccountId: target.id, entries: [{ sessionId: session.id, encryptedDataKey: encodeBase64(seal(targetBinding.contentPublicKey)) }] } });
            expect(result.ok || result.error === 'forbidden' || result.error === 'membership_not_found').toBe(true);
            expect(revoke).toBeDefined();
            await revoke;
            expect(revokedError).toBeUndefined();
            expect(revocationWon).toBe(phase === 'discovery');
            const stored = await db.sessionDataKeyEnvelope.findUnique({ where: { sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: target.id } } });
            if (revocationWon) {
                expect(result).toEqual({ ok: false, error: 'membership_not_found' });
                expect(stored).toBeNull();
            } else {
                // Native access revocation does not erase previously prepared
                // ciphertext. A write that held admission first is legitimate.
                expect(result).toEqual({ ok: true, appliedCount: 1 });
                expect(stored).not.toBeNull();
            }
        } finally {
            db.$transaction = originalTransaction;
            await revoke;
            vi.unstubAllEnvs();
            await db.session.delete({ where: { id: session.id } });
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, target.id] } } });
        }
    });

    it.each(['hot cursor', 'revoked target'] as const)('assigns responsibility from held admission after %s', async scenario => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const target = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id, accountId: target.id, accessLevel: 'view' } });
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        try {
            const result = await duringSessionAudienceDiscovery(async () => {
                if (scenario === 'hot cursor') await inTx(tx => markAccountChanged(tx, { accountId: owner.id, kind: 'account', entityId: owner.id }));
                else expect(await inTx(tx => deleteSessionAccessGrantInTx(tx, { actorAccountId: owner.id, sessionId: session.id,
                    subject: { kind: 'account', accountId: target.id }, authentication }))).toMatchObject({ ok: true });
            }, () => setSessionResponsibility({ actorAccountId: owner.id, sessionId: session.id, responsibleAccountId: target.id, authentication }));
            if (scenario === 'hot cursor') {
                expect(result).toMatchObject({ ok: true, changed: true, responsibleAccountId: target.id });
                expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ responsibleAccountId: target.id });
            } else {
                expect(result).toEqual({ ok: false, error: 'assignee_unavailable' });
                expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ responsibleAccountId: null });
            }
        } finally {
            vi.unstubAllEnvs();
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, target.id] } } });
        }
    });

    it.each(['hot cursor', 'revoked target'] as const)('applies recipient envelopes from held admission after %s', async scenario => {
        const ownerBinding = createSignedAccountContentBinding();
        const recipientBinding = createSignedAccountContentBinding();
        const owner = await db.account.create({ data: { ...ownerBinding, encryptionMode: 'e2ee' } });
        const recipient = await db.account.create({ data: { ...recipientBinding, encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'e2ee' } });
        const envelope = (recipientPublicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey: tweetnacl.randomBytes(32), recipientPublicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const recipientEnvelope = envelope(recipientBinding.contentPublicKey);
        await db.sessionDataKeyEnvelope.create({ data: { sessionId: session.id, recipientAccountId: owner.id, encryptedDataKey: envelope(ownerBinding.contentPublicKey) } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id, accountId: recipient.id, accessLevel: 'view' } });
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        try {
            const result = await duringSessionAudienceDiscovery(async () => {
                if (scenario === 'hot cursor') await inTx(tx => markAccountChanged(tx, { accountId: owner.id, kind: 'account', entityId: owner.id }));
                else expect(await inTx(tx => deleteSessionAccessGrantInTx(tx, { actorAccountId: owner.id, sessionId: session.id,
                    subject: { kind: 'account', accountId: recipient.id }, authentication }))).toMatchObject({ ok: true });
            }, () => applySessionDataKeyEnvelopes({ actorAccountId: owner.id, sessionId: session.id,
                entries: [{ recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(recipientEnvelope) }], authentication }));
            const stored = await db.sessionDataKeyEnvelope.findUnique({ where: { sessionId_recipientAccountId: {
                sessionId: session.id, recipientAccountId: recipient.id,
            } } });
            if (scenario === 'hot cursor') {
                expect(result).toEqual({ ok: true, appliedCount: 1 });
                expect(stored?.encryptedDataKey).toEqual(recipientEnvelope);
            } else {
                expect(result).toEqual({ ok: false, error: 'recipient_changed' });
                expect(stored).toBeNull();
            }
        } finally {
            vi.unstubAllEnvs();
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
        }
    });
});
