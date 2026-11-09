import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion, renameDiscussion } from './mutations';
import { setDiscussionReadCursor } from './readState';
import { bindDiscussionParticipantSessionInTx, inviteDiscussionParticipant } from './accessService';
import { DiscussionModelParticipantLaunchV1Schema } from '@happier-dev/protocol/discussions/modelParticipantLaunch';

const authentication = createPresentUserSessionAccessAuthentication();

describe('Discussion finite mutation admission (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-admission-' });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('binds an admitted model slot without replaying its policy after the exact slot CAS', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Model admission' } },
            firstMessage: { localId: randomUUID(), mentionedAccountIds: [],
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Model source' }] } } },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionParticipant = { discussionId: created.value.discussion.id, participantSlotId: randomUUID() };
        const launch = DiscussionModelParticipantLaunchV1Schema.parse({ executionTarget: { serverId: 'home', machineId: machine.id },
            directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId: discussionParticipant.discussionId,
            request: { participant: { kind: 'model', participantSlotId: discussionParticipant.participantSlotId, launch } } })).toMatchObject({ ok: true });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
            originKind: 'discussion', originDiscussionId: discussionParticipant.discussionId,
            originDiscussionParticipantSlotId: discussionParticipant.participantSlotId } });
        const transaction = db.$transaction;
        let bound = false;
        let readmissions = 0;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(client, property, clientReceiver) {
                const delegate = Reflect.get(client, property, clientReceiver);
                if (property !== 'discussion' && property !== 'discussionParticipant') return delegate;
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const query = Reflect.get(model, method, modelReceiver);
                    if (property === 'discussionParticipant' && method === 'updateMany') return async (...values: unknown[]) => {
                        const result: unknown = await Reflect.apply(query, model, values);
                        bound = true;
                        return result;
                    };
                    if (property !== 'discussion' || method !== 'findMany') return query;
                    return (...values: unknown[]) => {
                        const input = values[0];
                        const select: unknown = input && typeof input === 'object' ? Reflect.get(input, 'select') : undefined;
                        if (bound && select && typeof select === 'object' && Reflect.has(select, 'keyEnvelopes')) readmissions++;
                        return Reflect.apply(query, model, values);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            const input = { accountId: owner.id, authentication, discussionParticipant, launch, sessionId: session.id };
            expect(await inTx(tx => bindDiscussionParticipantSessionInTx(tx, input)))
                .toMatchObject({ ok: true, value: { sessionId: session.id } });
            expect(bound).toBe(true);
            expect(readmissions).toBe(0);
            expect(await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: discussionParticipant } }))
                .toMatchObject({ sessionId: session.id });
            expect(await inTx(tx => bindDiscussionParticipantSessionInTx(tx, { ...input, sessionId: randomUUID() })))
                .toMatchObject({ ok: false, error: 'discussion_idempotency_conflict' });
        } finally { db.$transaction = transaction; }
    });

    it.each(['rename', 'read'] as const)('admits %s once and refuses the next request from another Account', async operation => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'One admission' } },
            firstMessage: { localId: randomUUID(), mentionedAccountIds: [],
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Read me' }] } } },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const transaction = db.$transaction;
        let admissions = 0;
        // Observe the real Prisma boundary; all admission, transaction, cursor
        // and publication logic executes unchanged against disposable SQLite.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(client, property, clientReceiver) {
                const delegate = Reflect.get(client, property, clientReceiver);
                if (property !== 'discussion') return delegate;
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const query = Reflect.get(model, method, modelReceiver);
                    if (method !== 'findMany') return query;
                    return (...values: unknown[]) => {
                        const input = values[0];
                        const select: unknown = input && typeof input === 'object' ? Reflect.get(input, 'select') : undefined;
                        if (select && typeof select === 'object' && Reflect.has(select, 'keyEnvelopes')) admissions++;
                        return Reflect.apply(query, model, values);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        const mutate = (actorAccountId: string) => operation === 'rename'
            ? renameDiscussion({ authentication, actorAccountId, discussionId,
                titleContent: { t: 'plain', v: { v: 1, title: 'Admitted title' } } })
            : setDiscussionReadCursor({ authentication, actorAccountId, discussionId, lastReadSeq: 1 });
        try {
            expect(await mutate(owner.id)).toMatchObject({ ok: true });
            expect(admissions).toBe(1);
            if (operation === 'rename') expect(await db.discussion.findUniqueOrThrow({ where: { id: discussionId } }))
                .toMatchObject({ titleContent: { t: 'plain', v: { title: 'Admitted title' } } });
            else expect(await db.discussionReadState.findUniqueOrThrow({ where: {
                discussionId_accountId: { discussionId, accountId: owner.id },
            } })).toMatchObject({ lastReadSeq: 1 });
            admissions = 0;
            expect(await mutate(outsider.id)).toEqual({ ok: false, error: 'discussion_not_found' });
            expect(admissions).toBe(1);
        } finally {
            db.$transaction = transaction;
        }
    });
});
