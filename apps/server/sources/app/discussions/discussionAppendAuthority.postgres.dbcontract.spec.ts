import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, type DiscussionCreateRequestV1 } from '@happier-dev/protocol';
import { DISCUSSION_AGENT_POST_EVENT_V1, DISCUSSION_HTTP_PATHS_V1, DiscussionAgentPostResponseV1Schema, DiscussionAgentPublisherResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { homeDomainActionPathForMethod } from '@/app/api/routes/actions/homeDomainActionRoute';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { registerTeamMemberRoutes } from '@/app/teams/memberships/registerTeamMemberRoutes';
import { registerTeamGroupRoutes } from '@/app/teams/groups/registerTeamGroupRoutes';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { createArtifact, deleteArtifact } from '@/app/artifacts/artifactWriteService';
import { removeArtifactAccessGrantInTx, setArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createDiscussion, renameDiscussion } from './mutations';
import { setDiscussionReadCursor } from './readState';
import { inviteDiscussionParticipant, setDiscussionGrant } from './accessService';

const authentication = createPresentUserSessionAccessAuthentication();
const request = () => ({ localId: randomUUID(), content: { t: 'plain' as const,
    v: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Current authority only' }] } }, mentionedAccountIds: [] });
const headers = (accountId: string) => ({ 'x-test-user-id': accountId, 'x-happier-account-stored-content-protocol': '4' });
function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

/** Only the native Prisma scheduling boundary is observed; domain owners stay real. */
function beforeMutationQuery(matches: (delegate: string, method: string, args: readonly unknown[]) => boolean,
    before: () => Promise<void>, phase: 'before' | 'after' = 'before') {
    const original = db.$transaction;
    let observed = false;
    db.$transaction = new Proxy(original, { apply(target, receiver, args) {
        const operation: unknown = args[0];
        const options: unknown = args[1];
        if (typeof operation !== 'function'
            || options && typeof options === 'object' && Reflect.get(options, 'isolationLevel') === 'RepeatableRead') {
            return Reflect.apply(target, receiver, args);
        }
        return Reflect.apply(target, receiver, [async (tx: Tx) => Reflect.apply(operation, undefined, [new Proxy(tx, {
            get(owner, property, proxyReceiver) {
                const delegate: unknown = Reflect.get(owner, property, proxyReceiver);
                if (property === '$queryRawUnsafe' && typeof delegate === 'function') return (...queryArgs: unknown[]) => {
                    const query: unknown = Reflect.apply(delegate, owner, queryArgs);
                    if (observed || !matches(property, '', queryArgs)) return query;
                    if (phase === 'after') {
                        observed = true;
                        return Promise.resolve(query).then(async value => { await before(); return value; });
                    }
                    return observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), async () => {
                        if (observed) return;
                        observed = true;
                        await before();
                    });
                };
                if (!delegate || typeof delegate !== 'object' || typeof property !== 'string' || property.startsWith('_')) return delegate;
                return new Proxy(delegate, { get(model, method) {
                    const execute: unknown = Reflect.get(model, method);
                    if (typeof execute !== 'function' || typeof method !== 'string') return execute;
                    return (...queryArgs: unknown[]) => {
                        const query: unknown = Reflect.apply(execute, model, queryArgs);
                        if (observed || !matches(property, method, queryArgs)) return query;
                        if (phase === 'after') {
                            observed = true;
                            return Promise.resolve(query).then(async value => { await before(); return value; });
                        }
                        return observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), async () => {
                            if (observed) return;
                            observed = true;
                            await before();
                        });
                    };
                } });
            },
        })]), ...args.slice(1)]);
    } });
    return () => { db.$transaction = original; };
}
const allocation = (delegate: string, method: string) => delegate === 'discussion' && method === 'update';
const discussionAccess = (delegate: string, method: string, args: readonly unknown[]) => delegate === 'discussion' && method === 'findMany'
    && args[0] !== null && typeof args[0] === 'object' && Reflect.get(args[0], 'select') !== null
    && typeof Reflect.get(args[0], 'select') === 'object' && Reflect.has(Reflect.get(args[0], 'select'), 'keyEnvelopes');

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Discussion append authority (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_TEAMS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST', 'none');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { vi.unstubAllEnvs(); await shutdownDbClient(); });

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const app: Fastify = createAuthenticatedTestApp();
        registerDiscussionRoutes(app);
        registerTeamMemberRoutes(app);
        registerTeamGroupRoutes(app);
        machinesRoutes(app);
        await app.ready();
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Authority contention' } }, firstMessage: request(),
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        return { owner, app, discussionId, append: (actor: string, payload = request()) => app.inject({ method: 'POST',
            url: DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', discussionId), headers: headers(actor), payload }),
        publicationState: async () => ({
            account: await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } }),
            discussion: await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
                accountId: owner.id, kind: 'discussion', entityId: discussionId,
            } } }),
        }),
        assertMessages: async (localId: string, accepted: boolean) => {
            expect(await db.discussion.findUniqueOrThrow({ where: { id: discussionId } })).toMatchObject({ messageSeq: accepted ? 2 : 1 });
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(accepted ? 2 : 1);
            expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(accepted ? 1 : 0);
            expect(await db.discussionMessage.findUniqueOrThrow({ where: { id: created.value.firstMessage.id } }))
                .toMatchObject({ seq: 1, addressingV1: { throughSeq: 1, participantSessionIds: [] } });
            if (accepted) expect(await db.discussionMessage.findUniqueOrThrow({ where: { discussionId_localId: { discussionId, localId } } }))
                .toMatchObject({ seq: 2, addressingV1: { participantSessionIds: [], throughSeq: 2 } });
        }, close: async () => {
            await app.close();
            await db.accessKey.deleteMany({ where: { accountId: owner.id } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.machine.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        } };
    }

    // If the fixed reader already owns authority, the competing writer must
    // wait. Release append rather than awaiting that writer inside the pause.
    async function writerCommittedOrBlocked(writer: Promise<unknown>) {
        let finished = false;
        void writer.then(() => { finished = true; }, () => { finished = true; });
        while (!finished) {
            const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                    AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting
            `;
            if (row.waiting) return false;
        }
        return true;
    }

    for (const { kind, direct } of [{ kind: 'team', direct: false }, { kind: 'group', direct: false }, { kind: 'team', direct: true }] as const) {
        async function collectiveFixture() {
            const current = await fixture();
            const actor = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
            const team = await db.team.create({ data: { name: 'Append authority' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: current.owner.id, role: 'owner' } });
            const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
            const group = kind === 'group' ? await db.teamGroup.create({ data: { teamId: team.id, name: 'Append readers', nameKey: 'append-readers' } }) : null;
            if (group) await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: member.id, nativeContribution: true } });
            expect(await setDiscussionGrant({ authentication, actorAccountId: current.owner.id, discussionId: current.discussionId,
                request: { principal: group ? { kind: 'group', teamId: team.id, groupId: group.id } : { kind: 'team', teamId: team.id }, accessLevel: 'edit' } }))
                .toMatchObject({ ok: true });
            if (direct) expect(await setDiscussionGrant({ authentication, actorAccountId: current.owner.id, discussionId: current.discussionId,
                request: { principal: { kind: 'account', accountId: actor.id }, accessLevel: 'edit' } })).toMatchObject({ ok: true });
            return { ...current, actor, principal: group ? { kind: 'group' as const, teamId: team.id, groupId: group.id }
                : { kind: 'team' as const, teamId: team.id }, add: () => current.app.inject({ method: 'POST', headers: headers(current.owner.id),
                url: homeDomainActionPathForMethod('teams.members.add', 'POST'),
                payload: { v: 1, teamId: team.id, accountId: actor.id, role: 'member', historyAccess: 'from_membership' },
            }).then(response => { expect(response.statusCode, response.body).toBe(200); return response; }), revoke: async () => {
                const target = await db.teamMembership.findUniqueOrThrow({ where: { teamId_accountId: { teamId: team.id, accountId: actor.id } } });
                return current.app.inject({ method: 'POST', headers: headers(current.owner.id),
                url: homeDomainActionPathForMethod(group ? 'teams.groups.members.remove' : 'teams.members.remove', 'POST'),
                payload: group ? { v: 1, teamId: team.id, groupId: group.id, accountId: actor.id } : { v: 1, teamId: team.id, membershipId: target.id },
            }).then(response => { expect(response.statusCode, response.body).toBe(200); return response; }); }, close: async () => {
                await db.team.delete({ where: { id: team.id } });
                await current.close();
                await db.account.delete({ where: { id: actor.id } });
            } };
        }

        it(`orders ${kind} withdrawal against an admitted HTTP append (surviving direct grant: ${direct})`, async () => {
            const current = await collectiveFixture();
            const paused = signal(); const resume = signal();
            const restore = beforeMutationQuery(allocation, async () => { paused.resolve(); await resume.promise; });
            const payload = request();
            const posting = current.append(current.actor.id, payload).then(result => result);
            let revoking: ReturnType<typeof current.revoke> | undefined;
            try {
                await Promise.race([paused.promise, posting.then(() => { throw new Error('Append ended before authority pause'); })]);
                revoking = current.revoke();
                const revokedFirst = await writerCommittedOrBlocked(revoking);
                const withdrawn = revokedFirst ? await current.publicationState() : null;
                resume.resolve();
                const [posted] = await Promise.all([posting, revoking]);
                const accepted = direct || !revokedFirst;
                expect(posted.statusCode, posted.body).toBe(accepted ? 200 : 403);
                await current.assertMessages(payload.localId, accepted);
                if (!accepted) expect(await current.publicationState()).toEqual(withdrawn);
            } finally { resume.resolve(); await Promise.allSettled([posting, revoking]); restore(); await current.close(); }
        });

        it.each(['rename', 'read'] as const)(`finishes admitted %s and checks ${kind} withdrawal on the next request (surviving direct grant: ${direct})`, async operation => {
            const current = await collectiveFixture();
            if (operation === 'rename') expect(await setDiscussionGrant({ authentication, actorAccountId: current.owner.id,
                discussionId: current.discussionId, request: { principal: current.principal, accessLevel: 'admin' } })).toMatchObject({ ok: true });
            if (direct && operation === 'rename') expect(await setDiscussionGrant({ authentication, actorAccountId: current.owner.id,
                discussionId: current.discussionId, request: { principal: { kind: 'account', accountId: current.actor.id }, accessLevel: 'admin' } }))
                .toMatchObject({ ok: true });
            await db.discussionReadState.update({ where: { discussionId_accountId: {
                discussionId: current.discussionId, accountId: current.actor.id,
            } }, data: { lastReadSeq: 0 } });
            const paused = signal(); const resume = signal();
            const restore = beforeMutationQuery((delegate, method) => operation === 'rename'
                ? delegate === 'discussion' && method === 'update' : delegate === 'discussionReadState' && method === 'updateMany',
            async () => { paused.resolve(); await resume.promise; });
            const input = { authentication, actorAccountId: current.actor.id, discussionId: current.discussionId };
            const mutation = operation === 'rename'
                ? renameDiscussion({ ...input, titleContent: { t: 'plain', v: { v: 1, title: 'New title' } } })
                : setDiscussionReadCursor({ ...input, lastReadSeq: 1 });
            let revoking: ReturnType<typeof current.revoke> | undefined;
            try {
                await Promise.race([paused.promise, mutation.then(() => { throw new Error('Mutation ended before authority pause'); })]);
                revoking = current.revoke();
                const revokedFirst = await writerCommittedOrBlocked(revoking);
                expect(revokedFirst).toBe(true);
                resume.resolve();
                const [result] = await Promise.all([mutation, revoking]);
                expect(result.ok).toBe(true);
                if (operation === 'rename') expect(await db.discussion.findUniqueOrThrow({ where: { id: current.discussionId } }))
                    .toMatchObject({ titleContent: { t: 'plain', v: { title: 'New title' } } });
                const next = operation === 'rename'
                    ? await renameDiscussion({ ...input, titleContent: { t: 'plain', v: { v: 1, title: 'Next title' } } })
                    : await setDiscussionReadCursor({ ...input, lastReadSeq: 1 });
                expect(next.ok).toBe(direct);
            } finally { resume.resolve(); await Promise.allSettled([mutation, revoking]); restore(); await current.close(); }
        });

        it(`rechecks ${kind} withdrawal committed before the locking access read (surviving direct grant: ${direct})`, async () => {
            const current = await collectiveFixture();
            let withdrawn: Awaited<ReturnType<typeof current.publicationState>> | undefined;
            const restore = beforeMutationQuery(discussionAccess, async () => { await current.revoke(); withdrawn = await current.publicationState(); }, 'after');
            const payload = request();
            try {
                const posted = await current.append(current.actor.id, payload);
                await current.assertMessages(payload.localId, direct);
                if (!direct) expect(await current.publicationState()).toEqual(withdrawn);
                expect(posted.statusCode, posted.body).toBe(direct ? 200 : 400);
                if (!direct) expect(posted.json()).toEqual({ error: 'discussion_publication_context_unavailable' });
            } finally { restore(); await current.close(); }
        });

        if (kind === 'team' && !direct) it('refuses withdrawn authority before allocation and admits restored membership on the next request', async () => {
            const current = await collectiveFixture();
            const paused = signal(); const resume = signal();
            let authorityState: Awaited<ReturnType<typeof current.publicationState>> | undefined;
            const afterCapture = beforeMutationQuery(discussionAccess, async () => {
                await current.revoke(); authorityState = await current.publicationState();
            }, 'after');
            const beforeAllocation = beforeMutationQuery(allocation, async () => { paused.resolve(); await resume.promise; });
            const payload = request(); const posting = current.append(current.actor.id, payload).then(result => result);
            let revoking: ReturnType<typeof current.revoke> | undefined;
            try {
                const early = await Promise.race([paused.promise.then(() => null), posting]);
                if (early) {
                    // An admission refusal has no allocation phase to pause.
                    // It must leave no publication or cursor effect to recover.
                    await current.assertMessages(payload.localId, false);
                    expect(authorityState).toBeDefined();
                    expect(await current.publicationState()).toEqual(authorityState);
                    expect(early.statusCode, early.body).toBe(400);
                    expect(early.json()).toEqual({ error: 'discussion_publication_context_unavailable' });
                    // Restore only after the refused transaction releases its
                    // locks; rejoining inside its SQL callback deadlocks it.
                    beforeAllocation();
                    await current.add();
                    const restored = await current.append(current.actor.id);
                    expect(restored.statusCode, restored.body).toBe(200);
                    return;
                }
                revoking = current.revoke();
                const revokedFirst = await writerCommittedOrBlocked(revoking);
                resume.resolve();
                const [posted] = await Promise.all([posting, revoking]);
                expect(posted.statusCode, posted.body).toBe(revokedFirst ? 403 : 200);
                await current.assertMessages(payload.localId, !revokedFirst);
            } finally {
                resume.resolve(); await Promise.allSettled([posting, revoking]);
                beforeAllocation(); afterCapture(); await current.close();
            }
        });
    }

    async function publisherFixture() {
        const current = await fixture();
        const session = await db.session.create({ data: { accountId: current.owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: current.owner.id, discussionId: current.discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: current.owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'test', platform: 'linux', happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.accessKey.create({ data: { accountId: current.owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(current.owner.id, socket as never, { connectionType: 'session-scoped', socket, userId: current.owner.id, sessionId: session.id } as never,
            { presence: createSessionPublisherPresence(), binding: { accountId: current.owner.id, machineId: machine.id, sessionId: session.id } });
        let snapshot: unknown;
        await getSocketHandler(socket, 'session-runtime-activity-snapshot')({ sessionId: session.id, mutationId: randomUUID(),
            snapshot: { state: 'idle', activeCount: 0 } }, (value: unknown) => { snapshot = value; });
        expect(snapshot).toMatchObject({ status: expect.stringMatching(/^(applied|unchanged)$/) });
        const binding = { accountId: current.owner.id, machineId: machine.id, sessionId: session.id };
        return { ...current, binding, publish: async (payload = request()) => {
            let response: unknown;
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({ v: 1, sessionId: session.id, discussionId: current.discussionId, request: payload },
                (value: unknown) => { response = value; });
            return DiscussionAgentPostResponseV1Schema.parse(response);
        }, create: async (creationLocalId: string, payload: DiscussionCreateRequestV1['firstMessage'] = request(),
            participants?: DiscussionCreateRequestV1['participants']) => {
            let response: unknown;
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({ v: 1, operation: 'create', sessionId: session.id,
                request: { creationLocalId, titleContent: { t: 'plain', v: { v: 1, title: 'Trusted creation' } }, firstMessage: payload, participants } },
            (value: unknown) => { response = value; });
            return DiscussionAgentPublisherResponseV1Schema.parse(response);
        }, revoke: () => current.app.inject({ method: 'POST', url: `/v1/machines/${machine.id}/revoke`, headers: headers(current.owner.id) })
            .then(response => { expect(response.statusCode, response.body).toBe(200); return response; }) };
    }

    for (const transport of ['http', 'socket'] as const) {
        for (const withdrawal of ['creator-grant', 'reader-grant', 'team', 'team-suspend', 'group', 'team-with-direct', 'delete'] as const) {
            it(`orders ${withdrawal} Doc-source withdrawal after admission against ${transport} creation with an Account-only roster`, async () => {
                const current = transport === 'socket' ? await publisherFixture() : await fixture();
                const sourceOwner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
                const reader = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
                await makeShareEligibleForTest(sourceOwner.id, [current.owner.id, reader.id]);
                await makeShareEligibleForTest(current.owner.id, reader.id);
                const artifactId = randomUUID();
                const artifact = await createArtifact({ actorUserId: sourceOwner.id, artifactId,
                    header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'markdown', title: 'Source authority' })),
                    body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Source passage' })),
                    dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
                expect(artifact).toMatchObject({ ok: true });
                const collective = withdrawal === 'team' || withdrawal === 'team-suspend' || withdrawal === 'group' || withdrawal === 'team-with-direct';
                const team = collective ? await db.team.create({ data: { name: 'Source-only authority' } }) : null;
                let groupId: string | undefined;
                if (team) {
                    await db.teamMembership.create({ data: { teamId: team.id, accountId: sourceOwner.id, role: 'owner' } });
                    const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: 'member' } });
                    if (withdrawal === 'group') {
                        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Source readers', nameKey: 'source-readers' } });
                        groupId = group.id;
                        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
                            teamMembershipId: member.id, nativeContribution: true } });
                    }
                    expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: sourceOwner.id, artifactId,
                        principal: groupId ? { kind: 'group', teamId: team.id, groupId } : { kind: 'team', teamId: team.id }, accessLevel: 'view' })))
                        .toMatchObject({ ok: true });
                }
                for (const accountId of [current.owner.id, ...(!collective || withdrawal === 'team-with-direct' ? [reader.id] : [])]) {
                    expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: sourceOwner.id, artifactId,
                        principal: { kind: 'account', accountId }, accessLevel: 'view' }))).toMatchObject({ ok: true });
                }
                const doc = { ref: { kind: 'doc' as const, artifactId, serverId: 'home' }, revision: { headerVersion: 1, bodyVersion: 1 } };
                const payload: DiscussionCreateRequestV1['firstMessage'] = { localId: randomUUID(), mentionedAccountIds: [],
                    content: { t: 'plain', v: { kind: 'doc_passage_comment', passage: { ...doc, range: { start: 0, end: 6 }, quote: 'Source' },
                        content: { v: 1, parts: [{ t: 'text', text: 'Admitted first message' }] } } }, replyTarget: { kind: 'doc_passage', doc } };
                const creationLocalId = randomUUID();
                const participants = [{ kind: 'account' as const, accountId: reader.id }];
                const publicationState = async () => ({
                    accounts: await db.account.findMany({ where: { id: { in: [current.owner.id, sourceOwner.id, reader.id] } },
                        select: { id: true, seq: true }, orderBy: { id: 'asc' } }),
                    changes: await db.accountChange.findMany({ where: { accountId: { in: [current.owner.id, sourceOwner.id, reader.id] } },
                        orderBy: [{ accountId: 'asc' }, { kind: 'asc' }, { entityId: 'asc' }] }),
                    grants: await db.discussionAccountGrant.findMany({ where: { discussion: { createdByAccountId: current.owner.id } },
                        orderBy: [{ discussionId: 'asc' }, { accountId: 'asc' }] }),
                });
                const revoke = async () => {
                    if (withdrawal === 'delete') {
                        expect(await deleteArtifact({ actorUserId: sourceOwner.id, artifactId })).toMatchObject({ ok: true });
                    } else if (team) {
                        const member = await db.teamMembership.findUniqueOrThrow({ where: { teamId_accountId: { teamId: team.id, accountId: reader.id } } });
                        const response = await current.app.inject({ method: 'POST', headers: headers(sourceOwner.id),
                            url: homeDomainActionPathForMethod(groupId ? 'teams.groups.members.remove'
                                : withdrawal === 'team-suspend' ? 'teams.members.suspend' : 'teams.members.remove', 'POST'),
                            payload: groupId ? { v: 1, teamId: team.id, groupId, accountId: reader.id }
                                : { v: 1, teamId: team.id, membershipId: member.id } });
                        expect(response.statusCode, response.body).toBe(200);
                    } else {
                        expect(await inTx(tx => removeArtifactAccessGrantInTx(tx, { actorAccountId: sourceOwner.id, artifactId,
                            principal: { kind: 'account', accountId: withdrawal === 'creator-grant' ? current.owner.id : reader.id } })))
                            .toMatchObject({ ok: true, value: { changed: true } });
                    }
                };
                const paused = signal(); const resume = signal();
                const restore = beforeMutationQuery((delegate, method) => delegate === 'discussion' && method === 'create',
                    async () => { paused.resolve(); await resume.promise; });
                const creating = 'create' in current && typeof current.create === 'function' ? current.create(creationLocalId, payload, participants) : current.app.inject({ method: 'POST',
                    url: DISCUSSION_HTTP_PATHS_V1.collection, headers: headers(current.owner.id), payload: { creationLocalId, participants,
                        titleContent: { t: 'plain', v: { v: 1, title: 'Source authority' } }, firstMessage: payload } })
                    .then(response => ({ ok: response.statusCode === 200, value: response.json() }));
                let revoking: Promise<void> | undefined;
                try {
                    await Promise.race([paused.promise, creating.then(() => { throw new Error('Creation ended before source-admission pause'); })]);
                    revoking = revoke();
                    const revokedFirst = await writerCommittedOrBlocked(revoking);
                    const withdrawn = revokedFirst ? await publicationState() : null;
                    resume.resolve();
                    const [created] = await Promise.all([creating, revoking]);
                    const accepted = withdrawal === 'team-with-direct' || !revokedFirst;
                    expect(created.ok).toBe(accepted);
                    expect(await db.discussion.count({ where: { createdByAccountId: current.owner.id, creationLocalId } })).toBe(accepted ? 1 : 0);
                    expect(await db.discussionMessage.count({ where: { localId: payload.localId } })).toBe(accepted ? 1 : 0);
                    if (accepted) expect(created).toMatchObject({ value: { firstMessage: { content: payload.content, seq: 1 } } });
                    else expect(await publicationState()).toEqual(withdrawn);
                } finally {
                    resume.resolve(); await Promise.allSettled([creating, revoking]); restore();
                    if (team) await db.team.delete({ where: { id: team.id } });
                    await current.close();
                    await db.artifact.deleteMany({ where: { id: artifactId } });
                    await db.account.deleteMany({ where: { id: { in: [sourceOwner.id, reader.id] } } });
                }
            });
        }
    }

    it('orders real Machine revoke against an admitted trusted socket append', async () => {
        const current = await publisherFixture();
        const paused = signal(); const resume = signal();
        const restore = beforeMutationQuery(allocation, async () => { paused.resolve(); await resume.promise; });
        const payload = request(); const posting = current.publish(payload);
        let revoking: ReturnType<typeof current.revoke> | undefined;
        try {
            await Promise.race([paused.promise, posting.then(() => { throw new Error('Publisher ended before authority pause'); })]);
            revoking = current.revoke();
            const revokedFirst = await writerCommittedOrBlocked(revoking);
            const withdrawn = revokedFirst ? await current.publicationState() : null;
            resume.resolve();
            const [posted] = await Promise.all([posting, revoking]);
            expect(posted.ok).toBe(!revokedFirst);
            if (revokedFirst) expect(posted).toMatchObject({ ok: false, error: 'discussion_post_denied' });
            await current.assertMessages(payload.localId, !revokedFirst);
            if (revokedFirst) expect(await current.publicationState()).toEqual(withdrawn);
        } finally { resume.resolve(); await Promise.allSettled([posting, revoking]); restore(); await current.close(); }
    });

    it('refuses trusted socket append when Machine revoke commits before the locking publisher read', async () => {
        const current = await publisherFixture();
        let withdrawn: Awaited<ReturnType<typeof current.publicationState>> | undefined;
        const restore = beforeMutationQuery((delegate, _method, args) => delegate === '$queryRawUnsafe'
            && /FROM "Machine".*FOR SHARE/.test(String(args[0])), async () => { await current.revoke(); withdrawn = await current.publicationState(); });
        const payload = request();
        try {
            expect(await current.publish(payload)).toMatchObject({ ok: false, error: 'discussion_post_denied' });
            await current.assertMessages(payload.localId, false);
            expect(await current.publicationState()).toEqual(withdrawn);
        } finally { restore(); await current.close(); }
    });

    it('orders real Machine revoke against an admitted trusted socket creation', async () => {
        const current = await publisherFixture();
        const paused = signal(); const resume = signal();
        const restore = beforeMutationQuery((delegate, method) => delegate === 'discussion' && method === 'create',
            async () => { paused.resolve(); await resume.promise; });
        const creationLocalId = randomUUID();
        const creating = current.create(creationLocalId);
        let revoking: ReturnType<typeof current.revoke> | undefined;
        try {
            await Promise.race([paused.promise, creating.then(() => { throw new Error('Creation ended before authority pause'); })]);
            revoking = current.revoke();
            const revokedFirst = await writerCommittedOrBlocked(revoking);
            resume.resolve();
            const [created] = await Promise.all([creating, revoking]);
            expect(created.ok).toBe(!revokedFirst);
            expect(await db.discussion.count({ where: { createdByAccountId: current.owner.id, creationLocalId } })).toBe(revokedFirst ? 0 : 1);
        } finally { resume.resolve(); await Promise.allSettled([creating, revoking]); restore(); await current.close(); }
    });

    it('creates through the trusted socket when a peer cursor commits after admission without needing recovery', async () => {
        const current = await publisherFixture();
        const retries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        let advanced = false;
        const restore = beforeMutationQuery((delegate, _method, args) => delegate === '$queryRawUnsafe'
            && /FROM "Account".*FOR NO KEY UPDATE/.test(String(args[0])), async () => {
                await db.account.update({ where: { id: current.owner.id }, data: { seq: { increment: 1 } } });
                advanced = true;
            });
        const creationLocalId = randomUUID();
        try {
            expect(await current.create(creationLocalId)).toMatchObject({ ok: true,
                value: { firstMessage: { seq: 1, producerV1: { kind: 'agent', sessionId: current.binding.sessionId } } } });
            expect(advanced).toBe(true);
            expect(await db.discussion.count({ where: { createdByAccountId: current.owner.id, creationLocalId } })).toBe(1);
        } finally {
            restore();
            if (retries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = retries;
            await current.close();
        }
    });

    it('does not borrow an AccessKey created after the exact locking lookup missed', async () => {
        const current = await publisherFixture();
        // Initial fixture state: the registered publisher has lost its tuple.
        await db.accessKey.deleteMany({ where: current.binding });
        const restore = beforeMutationQuery((delegate, _method, args) => delegate === '$queryRawUnsafe'
            && /FROM "AccessKey".*FOR SHARE/.test(String(args[0])), async () => {
                expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { ...current.binding, data: 'replacement' })))
                    .toMatchObject({ ok: true, created: true });
            }, 'after');
        const payload = request();
        try {
            expect(await current.publish(payload)).toMatchObject({ ok: false, error: 'discussion_post_denied' });
            await current.assertMessages(payload.localId, false);
        } finally { restore(); await current.close(); }
    });
});
