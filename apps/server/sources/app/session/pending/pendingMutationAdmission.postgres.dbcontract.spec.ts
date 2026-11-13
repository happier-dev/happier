import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { buildSessionAccessProjectionSelect } from '@/app/session/access/sessionAccess';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { deleteSessionPublicShare, writeSessionPublicShare } from '@/app/share/storedContentPublicShare';
import {
    blockPendingDelivery, deletePendingMessage, discardPendingMessage, dismissPendingDelivery,
    markPendingDeliveryHandled, reorderPendingMessages, restorePendingMessage, sendPendingDeliveryAsNew,
    updatePendingMessage, updatePendingRequestedAction,
} from './pendingMessageService';

const authentication = createPresentUserSessionAccessAuthentication();
const content = { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Pending input' } } } as const;
type Input = { actorUserId: string; sessionId: string; localId: string; authentication: typeof authentication };
const mutations = {
    requestedAction: (input: Input) => updatePendingRequestedAction({ ...input, requestedAction: { v: 1, kind: 'enqueue' } }),
    update: (input: Input) => updatePendingMessage({ ...input, content }),
    delete: deletePendingMessage,
    block: (input: Input) => blockPendingDelivery({ ...input, reason: 'session_input_target_unavailable' }),
    blockOwner: (input: Input) => blockPendingDelivery({ ...input, authentication: undefined, reason: 'session_input_target_unavailable' }),
    sendAsNew: sendPendingDeliveryAsNew,
    handled: markPendingDeliveryHandled,
    dismiss: dismissPendingDelivery,
    discard: discardPendingMessage,
    restore: restorePendingMessage,
    reorder: (input: Input) => reorderPendingMessages({ ...input, orderedLocalIds: [input.localId] }),
    shareWrite: (input: Input) => writeSessionPublicShare({ userId: input.actorUserId, sessionId: input.sessionId,
        authentication: input.authentication, lookupId: randomUUID() }),
    shareDelete: (input: Input) => deleteSessionPublicShare({ userId: input.actorUserId, sessionId: input.sessionId,
        authentication: input.authentication }),
} satisfies Record<string, (input: Input) => Promise<unknown>>;
type Mutation = keyof typeof mutations;

/** Observe the real Prisma transport, including transaction clients; domain logic and SQL stay real. */
async function observeAdmission<T>(actorAccountId: string, run: () => Promise<T>, beforeLock?: () => Promise<void>) {
    const accessReads: boolean[] = [];
    let lockQueries = 0;
    let interleaved = false;
    const accessKeys = Object.keys(buildSessionAccessProjectionSelect(actorAccountId));
    const originalTransaction = db.$transaction;
    const originalSession = db.session;
    const originalFind = originalSession.findUnique;
    const observeFind = (args: Parameters<typeof originalFind>[0], held: boolean) => {
        if (args.select && accessKeys.every(key => Object.hasOwn(args.select!, key))) accessReads.push(held);
    };
    Reflect.set(db, 'session', new Proxy(originalSession, { get(model, method, receiver) {
        if (method !== 'findUnique') return Reflect.get(model, method, receiver);
        return (args: Parameters<typeof originalFind>[0]) => {
            observeFind(args, false);
            return model.findUnique(args);
        };
    } }));
    db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
        const operation = args[0];
        if (typeof operation !== 'function') return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [(tx: Tx) => {
            let held = false;
            return operation(new Proxy(tx, { get(client, property, txReceiver) {
                if (property === 'session') return new Proxy(client.session, { get(model, method, modelReceiver) {
                    if (method !== 'findUnique') return Reflect.get(model, method, modelReceiver);
                    return (query: Parameters<typeof originalFind>[0]) => {
                        observeFind(query, held);
                        return model.findUnique(query);
                    };
                } });
                if (property !== '$queryRawUnsafe') return Reflect.get(client, property, txReceiver);
                return async (query: string, ...values: unknown[]) => {
                    if (/FROM "(?:Account|Session)".*FOR (?:NO KEY UPDATE|KEY SHARE|UPDATE)/s.test(query)) {
                        if (!interleaved && beforeLock) { interleaved = true; await beforeLock(); }
                        lockQueries++;
                        const result = await client.$queryRawUnsafe(query, ...values);
                        held = true;
                        return result;
                    }
                    return client.$queryRawUnsafe(query, ...values);
                };
            } }));
        }, ...args.slice(1)]);
    } });
    try { return { result: await run(), accessReads, lockQueries, interleaved }; }
    finally { db.$transaction = originalTransaction; Reflect.set(db, 'session', originalSession); }
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Pending and public-share admission once (real PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST', 'none');
        vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', 'https://home.example.test');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN', 'preview.example.test');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER', '1');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    async function fixture(operation: Mutation) {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const uncertain = operation === 'sendAsNew' || operation === 'handled' || operation === 'dismiss';
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
            metadata: '{"v":1}', metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: {} })),
            pendingCount: operation === 'restore' ? 0 : 1, pendingBlockedCount: uncertain ? 1 : 0 } });
        const localId = randomUUID();
        await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId, position: 1, content,
            messageRole: 'user', authorAccountId: owner.id, requestedAction: { v: 1, kind: 'enqueue' },
            ...(operation === 'restore' ? { status: 'discarded', discardedAt: new Date() } : {}),
            ...(uncertain ? { deliveryState: 'blocked', deliveryBlockedReason: 'delivery_outcome_uncertain' } : {}) } });
        if (operation === 'shareDelete') await db.publicSessionShare.create({ data: { sessionId: session.id,
            createdByUserId: owner.id, tokenHash: new Uint8Array(32) } });
        return { owner, other, session, localId, async cleanup() {
            await db.sessionMessage.deleteMany({ where: { sessionId: session.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
        } };
    }

    it.each(Object.keys(mutations) as Mutation[])('resolves %s once before locking and preserves two-Account refusal', async operation => {
        const f = await fixture(operation);
        try {
            const input = { actorUserId: f.other.id, sessionId: f.session.id, localId: f.localId, authentication };
            const refused = await observeAdmission<unknown>(f.other.id, () => mutations[operation](input));
            expect(refused.result).toEqual(operation.startsWith('share') ? { type: 'forbidden' } : { ok: false, error: 'session-not-found' });
            expect(refused.accessReads).toEqual([false]);
            expect(refused.lockQueries).toBe(0);
            const admitted = await observeAdmission<unknown>(f.owner.id, () => mutations[operation]({ ...input, actorUserId: f.owner.id }));
            expect(admitted.result).toMatchObject(operation.startsWith('share') ? { type: 'ok' } : { ok: true });
            expect(admitted.lockQueries).toBeGreaterThan(0);
            expect(admitted.accessReads).toEqual([false]);
            if (operation.startsWith('share')) expect(await db.publicSessionShare.count({ where: { sessionId: f.session.id } }))
                .toBe(operation === 'shareWrite' ? 1 : 0);
        } finally { await f.cleanup(); }
    });

    it('finishes an admitted shared mutation and observes revocation on the next request', async () => {
        const f = await fixture('discard');
        try {
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: f.session.id, createdByAccountId: f.owner.id,
                accountId: f.other.id, accessLevel: 'edit' } });
            const input = { actorUserId: f.other.id, sessionId: f.session.id, localId: f.localId, authentication };
            const admitted = await observeAdmission(f.other.id, () => discardPendingMessage(input), async () => {
                await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: f.session.id, accountId: f.other.id } });
            });
            expect(admitted.interleaved).toBe(true);
            expect(admitted.result).toMatchObject({ ok: true });
            expect(admitted.accessReads).toEqual([false]);
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: {
                sessionId_localId: { sessionId: f.session.id, localId: f.localId },
            } })).toMatchObject({ status: 'discarded' });
            const refused = await observeAdmission(f.other.id, () => restorePendingMessage(input));
            expect(refused.result).toEqual({ ok: false, error: 'session-not-found' });
            expect(refused.lockQueries).toBe(0);
        } finally { await f.cleanup(); }
    });
});
