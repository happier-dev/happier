import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionModelParticipantLaunchV1Schema } from '@happier-dev/protocol/discussions/modelParticipantLaunch';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { inviteDiscussionParticipant, setDiscussionGrant, validateDiscussionParticipantBirthInTx } from '@/app/discussions/accessService';
import { setTeamMembershipStatusInTx } from '@/app/teams/memberships/membershipService';
import { publishTeamChangedInTx } from '@/app/teams/teamChanges';
import { createDiscussion } from '@/app/discussions/mutations';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, readPostgresTransactionSqlState, type Tx } from '@/storage/inTx';
import { createOrRejoinLayout1SessionByTag } from './createOrRejoinLayout1SessionByTag';
import { prepareLayout1SessionCreate } from './prepareLayout1SessionCreate';

const authentication = createPresentUserSessionAccessAuthentication({ env: {} });

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Discussion model Session birth (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each([false, true])('finishes admitted model birth and checks Team withdrawal on the next request (surviving direct grant=%s)', async direct => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: actor.id, metadata: '{}' } });
        const team = await db.team.create({ data: { name: 'Model birth authority' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
        const transaction = db.$transaction;
        let withdrawal: Promise<void> | undefined;
        let discussionId: string | undefined;
        try {
            const discussion = await createDiscussion({ actorAccountId: owner.id, authentication,
                request: buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: randomUUID(),
                    titleContent: { t: 'plain', v: { v: 1, title: 'Model birth authority' } }, firstMessage: {
                        localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Model source' }] } },
                        mentionedAccountIds: [], authoredContent: { v: 1, parts: [{ t: 'text', text: 'Model source' }] },
                    } }) });
            if (!discussion.ok) throw new Error(discussion.error);
            discussionId = discussion.value.discussion.id;
            expect(await setDiscussionGrant({ actorAccountId: owner.id, authentication, discussionId,
                request: { principal: { kind: 'team', teamId: team.id }, accessLevel: 'admin' } })).toMatchObject({ ok: true });
            if (direct) expect(await setDiscussionGrant({ actorAccountId: owner.id, authentication, discussionId,
                request: { principal: { kind: 'account', accountId: actor.id }, accessLevel: 'admin' } })).toMatchObject({ ok: true });
            const discussionParticipant = { discussionId, participantSlotId: randomUUID() };
            const launch = DiscussionModelParticipantLaunchV1Schema.parse({ executionTarget: { serverId: 'home', machineId: machine.id },
                directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
            expect(await inviteDiscussionParticipant({ actorAccountId: actor.id, authentication, discussionId,
                request: { participant: { kind: 'model', participantSlotId: discussionParticipant.participantSlotId, launch } } }))
                .toMatchObject({ ok: true });
            const prepared = prepareLayout1SessionCreate({ accountId: actor.id, tag: randomUUID(), metadata: JSON.stringify({ v: 1 }),
                ownerMetadata: { t: 'plain', v: { v: 1 } }, agentState: null, dataEncryptionKey: null, requestedEncryptionMode: 'plain',
                requestedStorageState: undefined, organizationPlacement: undefined, accountEncryptionMode: 'plain', storagePolicy: 'optional',
                defaultAccountMode: 'plain', originKind: 'discussion', discussionParticipant, discussionParticipantLaunch: launch });
            if (!prepared.ok) throw new Error(prepared.rejection.reason);
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(client, property, clientReceiver) {
                    const delegate = Reflect.get(client, property, clientReceiver);
                    if (property !== 'discussionParticipant') return delegate;
                    return new Proxy(delegate, { get(model, method, modelReceiver) {
                        const operation = Reflect.get(model, method, modelReceiver);
                        if (method !== 'updateMany') return operation;
                        return async (...values: unknown[]) => {
                            if (!withdrawal) {
                                withdrawal = inTx(async peer => {
                                    await setTeamMembershipStatusInTx(peer, { teamId: team.id, membershipId: member.id,
                                        accountId: actor.id, status: 'suspended' });
                                    await publishTeamChangedInTx(peer, { teamId: team.id });
                                });
                                await withdrawal;
                            }
                            return Reflect.apply(operation, model, values);
                        };
                    } });
                } })), ...args.slice(1)]);
            } });
            const result = await createOrRejoinLayout1SessionByTag(prepared.prepared, authentication);
            expect(withdrawal).toBeDefined();
            expect(result.kind).toBe('created');
            if (result.kind !== 'created') throw new Error('Expected the admitted model birth to finish');
            expect(await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: discussionParticipant } }))
                .toMatchObject({ sessionId: result.session.id });
            expect((await inTx(tx => validateDiscussionParticipantBirthInTx(tx, {
                accountId: actor.id, authentication, discussionParticipant, launch,
            }))).ok).toBe(direct);
        } finally {
            db.$transaction = transaction;
            await withdrawal;
            if (discussionId) await db.discussion.delete({ where: { id: discussionId } });
            await db.session.deleteMany({ where: { accountId: actor.id } });
            await db.team.delete({ where: { id: team.id } });
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, actor.id] } } });
        }
    });

    it.each(['idle', 'publication-during-create', 'publication-during-rejoin', 'publication-before-create', 'publication-before-rejoin'])(
        'binds one recoverable ordinary Session with %s', async operation => {
            const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
            const transaction = db.$transaction;
            const publishers: Promise<unknown>[] = [];
            const failedStatements: Array<{ relation: string; sqlState: string | undefined }> = [];
            let publications = 0;
            let publisherInFlight = false;
            try {
                const discussion = await createDiscussion({ actorAccountId: owner.id, authentication,
                    request: buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: randomUUID(),
                        titleContent: { t: 'plain', v: { v: 1, title: 'Model birth regression' } }, firstMessage: {
                            localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'No prompt yet' }] } },
                            mentionedAccountIds: [], authoredContent: { v: 1, parts: [{ t: 'text', text: 'No prompt yet' }] },
                        } }) });
                if (!discussion.ok) throw new Error(discussion.error);
                const discussionParticipant = { discussionId: discussion.value.discussion.id, participantSlotId: randomUUID() };
                const launch = DiscussionModelParticipantLaunchV1Schema.parse({ executionTarget: { serverId: 'home', machineId: machine.id },
                    directory: { kind: 'path', path: '/repo' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
                expect(await inviteDiscussionParticipant({ actorAccountId: owner.id, authentication,
                    discussionId: discussionParticipant.discussionId,
                    request: { participant: { kind: 'model', participantSlotId: discussionParticipant.participantSlotId, launch } } }))
                    .toMatchObject({ ok: true, value: { modelParticipant: { sessionId: null } } });
                const prepared = prepareLayout1SessionCreate({ accountId: owner.id,
                    tag: deriveSessionCreationTagV1({ callerCreationNamespace: JSON.stringify(['discussion-participant', discussionParticipant.discussionId]),
                        creationKey: discussionParticipant.participantSlotId }),
                    metadata: JSON.stringify({ v: 1 }), ownerMetadata: { t: 'plain', v: { v: 1 } },
                    agentState: null, dataEncryptionKey: null, requestedEncryptionMode: 'plain', requestedStorageState: undefined,
                    organizationPlacement: undefined, accountEncryptionMode: 'plain', storagePolicy: 'optional', defaultAccountMode: 'plain',
                    originKind: 'discussion', discussionParticipant, discussionParticipantLaunch: launch });
                if (!prepared.ok) throw new Error(prepared.rejection.reason);
                const incumbent = operation.endsWith('rejoin')
                    ? await createOrRejoinLayout1SessionByTag(prepared.prepared, authentication) : null;
                if (incumbent?.kind === 'rejected') throw new Error(incumbent.rejection.reason);

                // Schedule only the real DB boundary. Ordinary Account cursor
                // publications may commit beside KEY SHARE admission; stronger
                // admission must let birth finish while its peer waits.
                if (operation !== 'idle') db.$transaction = new Proxy(transaction, { apply(target, receiver, args) {
                    const callback: unknown = args[0];
                    const options: unknown = args[1];
                    if (publisherInFlight || typeof callback !== 'function' || !options || typeof options !== 'object'
                        || !['Serializable', 'ReadCommitted'].includes(String(Reflect.get(options, 'isolationLevel')))) return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => {
                        let scheduled = false;
                        return callback(new Proxy(tx, { get(client, property, proxyReceiver) {
                            if (property !== '$queryRawUnsafe') return Reflect.get(client, property, proxyReceiver);
                            return (query: string, ...values: unknown[]) => observeLazyPrismaQuery(client.$queryRawUnsafe(query, ...values), () => ({
                                started() {},
                                settled(succeeded, error) {
                                    if (!succeeded) failedStatements.push({ relation: query.includes('FROM "Account"') ? 'Account' : 'other',
                                        sqlState: readPostgresTransactionSqlState(error) });
                                },
                            }), undefined, async consume => {
                                if (!scheduled && operation.startsWith('publication-before')
                                    && query.includes('FROM "Account"') && query.includes('FOR ')) {
                                    scheduled = true;
                                    await client.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
                                    publisherInFlight = true;
                                    try {
                                        await inTx(peer => markAccountChanged(peer, { accountId: owner.id, kind: 'account', entityId: 'operation-progress' }));
                                        publications++;
                                    } finally { publisherInFlight = false; }
                                    return consume();
                                }
                                const result = await consume();
                                if (scheduled || !query.includes('FROM "Account"') || !query.includes('FOR ')) return result;
                                scheduled = true;
                                let settled = false;
                                publisherInFlight = true;
                                const publisher = inTx(async peer => {
                                    await markAccountChanged(peer, { accountId: owner.id, kind: 'account', entityId: 'operation-progress' });
                                }, { transactionClass: 'discussion-model-birth.publication-peer' }).finally(() => { publisherInFlight = false; });
                                publishers.push(publisher);
                                void publisher.then(() => { settled = true; }, () => { settled = true; });
                                publications++;
                                while (!settled) {
                                    const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                            AND wait_event_type = 'Lock' AND query LIKE '%"Account"%') AS blocked
                                    `;
                                    if (blocked) break;
                                }
                                return result;
                            });
                        } }));
                    }, ...args.slice(1)]);
                } });
                const born = await createOrRejoinLayout1SessionByTag(prepared.prepared, authentication);
                expect(born.kind).toBe(incumbent ? 'rejoined' : 'created');
                if (born.kind === 'rejected') throw new Error(born.rejection.reason);
                if (incumbent) expect(born.session.id).toBe(incumbent.session.id);
                await Promise.all(publishers);
                db.$transaction = transaction;
                expect(await createOrRejoinLayout1SessionByTag(prepared.prepared, authentication))
                    .toMatchObject({ kind: 'rejoined', session: { id: born.session.id } });
                expect(await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: discussionParticipant } }))
                    .toMatchObject({ sessionId: born.session.id, removedAt: null });
                expect(await db.session.count({ where: { accountId: owner.id } })).toBe(1);
                expect(await db.sessionFollowEdge.count({ where: { sourceDiscussionId: discussionParticipant.discussionId,
                    destinationSessionId: born.session.id } })).toBe(1);
                expect(await db.sessionMessage.count({ where: { sessionId: born.session.id } })).toBe(0);
                expect(failedStatements).toEqual([]);
                if (operation !== 'idle') expect(publications).toBeGreaterThan(0);
            } finally {
                db.$transaction = transaction;
                await Promise.allSettled(publishers);
                console.info('MODEL_BIRTH_PUBLICATION', { operation, publications, failedStatements });
                await db.discussion.deleteMany({ where: { ownerAccountId: owner.id } });
                await db.session.deleteMany({ where: { accountId: owner.id } });
                await db.machine.delete({ where: { id: machine.id } });
                await db.account.delete({ where: { id: owner.id } });
            }
        },
    );
});
