import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import tweetnacl from 'tweetnacl';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { admitTeamMemberInTx } from '@/app/teams/memberships/membershipService';
import { deleteTaskResource } from '@/app/todos/taskResourceService';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { migrateDiscussionAccountEncryptionInTx, readDiscussionAccountEncryptionInventoryInTx } from './accountEncryptionMigration';
import { createDiscussion } from './mutations';
import { getDiscussion, listDiscussions } from './queries';
import { setDiscussionGrant } from './accessService';

const authentication = createPresentUserSessionAccessAuthentication();

function requestFor(anchor?: { kind: 'task'; entry: ReturnType<typeof internalTaskLocalRefV1> & { source: typeof INTERNAL_TASK_SOURCE_V1 } },
    mentionedAccountId?: string) {
    const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Private comment' },
        ...(mentionedAccountId ? [{ t: 'mention' as const, participant: { kind: 'account' as const, accountId: mentionedAccountId } }] : [])] };
    return buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
        titleContent: { t: 'plain', v: { v: 1, title: 'Private task' } }, anchor,
        firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: content }, authoredContent: content,
            mentionedAccountIds: mentionedAccountId ? [mentionedAccountId] : [] } });
}

describe('Task Discussion first comment', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-task-discussions-', initAuth: true,
            env: {
                HAPPIER_FEATURE_SESSIONS__ENABLED: '1',
                HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1',
                HAPPIER_FEATURE_TEAMS__ENABLED: '1',
            },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('holds an ungranted mention and creates one thread for a shared Task', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const create = (request: ReturnType<typeof requestFor>, actorAccountId = owner.id) => createDiscussion({ actorAccountId, authentication, request });
        expect(await create(requestFor())).toMatchObject({ ok: true });

        const taskId = crypto.randomUUID();
        const task = await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`,
            value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { id: taskId, title: 'Private task' } })) } });
        await db.taskGrant.create({ data: { taskId: task.id, principalKind: 'account', accountId: member.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        const anchor = { kind: 'task' as const, entry: { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(taskId, owner.id) } };

        expect(await create(requestFor(anchor, outsider.id))).toEqual({ ok: false, error: 'discussion_task_share_required' });
        expect(await listDiscussions({ anchorTask: anchor.entry, actorAccountId: owner.id, authentication })).toEqual({ ok: true,
            value: { discussions: [], nextCursor: null } });
        const first = await create(requestFor(anchor, member.id));
        expect(first).toMatchObject({ ok: true, value: { discussion: { ownerAccountId: owner.id, messageSeq: 1 } } });
        if (!first.ok) throw new Error(first.error);
        const discussionId = first.value.discussion.id;
        expect(await create(requestFor(anchor), member.id)).toEqual({ ok: false, error: 'discussion_task_thread_exists' });
        expect(await getDiscussion({ discussionId, actorAccountId: member.id, authentication })).toMatchObject({ ok: true });
        expect(await getDiscussion({ discussionId, actorAccountId: outsider.id, authentication })).toEqual({ ok: false, error: 'discussion_not_found' });
        expect(await listDiscussions({ actorAccountId: member.id, authentication })).toEqual({ ok: true,
            value: { discussions: [], nextCursor: null } });
        expect(await listDiscussions({ anchorKinds: ['task'], actorAccountId: member.id, authentication })).toMatchObject({ ok: true,
            value: { discussions: [{ id: discussionId }], nextCursor: null } });
        expect(await listDiscussions({ anchorTask: anchor.entry, actorAccountId: outsider.id, authentication })).toEqual({ ok: true,
            value: { discussions: [], nextCursor: null } });
        expect(await setDiscussionGrant({ discussionId, actorAccountId: owner.id, authentication,
            request: { accessLevel: 'view', principal: { kind: 'account', accountId: outsider.id } } })).toEqual({ ok: false,
            error: 'discussion_access_forbidden' });
        expect(await db.discussionGrant.count({ where: { discussionId } })).toBe(0);
        expect(await db.discussionKeyEnvelope.count({ where: { discussionId } })).toBe(0);
        await db.taskGrant.deleteMany({ where: { taskId: task.id } });
        expect(await getDiscussion({ discussionId, actorAccountId: member.id, authentication })).toEqual({ ok: false, error: 'discussion_not_found' });
    });

    it('requires restricted Team authentication to read or post to a Task Discussion', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Restricted Task Discussion', authenticationPolicy: {
            v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        } } });
        await inTx(async tx => {
            for (const [accountId, role] of [[owner.id, 'owner'], [member.id, 'member']] as const) {
                const admission = await admitTeamMemberInTx(tx, { teamId: team.id, accountId, role, historyAccess: 'all_existing' });
                if (!admission.ok) throw new Error('Team fixture admission failed');
            }
        });
        const taskId = crypto.randomUUID();
        const task = await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`,
            value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { id: taskId, title: 'Restricted thread' } })) } });
        await db.taskGrant.create({ data: { taskId: task.id, principalKind: 'team', teamId: team.id, accessLevel: 'edit',
            createdByAccountId: owner.id } });
        const request = requestFor({ kind: 'task', entry: { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(taskId, owner.id) } });
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request });
        if (!created.ok) throw new Error(created.error);
        const url = `/v1/discussions/${created.value.discussion.id}`;
        const credential = await createAccountTokenForTests(member.id, { kind: 'terminal', authority: 'account_automation' });
        const headers = { authorization: `Bearer ${credential}` };
        await withAuthenticatedTestApp(registerDiscussionRoutes, async app => {
            const read = await app.inject({ method: 'GET', url, headers });
            expect(read.statusCode).toBe(403);
            expect(read.json()).toEqual({ error: 'team_authentication_required' });

            const payload = { ...request.firstMessage, localId: crypto.randomUUID() };
            const post = await app.inject({ method: 'POST', url: `${url}/messages`, headers, payload });
            expect(post.statusCode).toBe(403);
            expect(post.json()).toEqual({ error: 'team_authentication_required' });
        }, { authentication: 'real' });
    });

    it('keeps Internal threads separate for two Accounts viewing the same external entry', async () => {
        const first = await db.account.create({ data: { encryptionMode: 'plain' } });
        const second = await db.account.create({ data: { encryptionMode: 'plain' } });
        const entry = { source: { pluginId: 'happier.github', localId: 'issues' }, kindId: 'issue', collisionScope: '1234', entryId: '4567' };
        const anchor = { kind: 'task' as const, entry };
        const create = (actorAccountId: string) => createDiscussion({ actorAccountId, authentication, request: requestFor(anchor) });
        const a = await create(first.id);
        const b = await create(second.id);
        if (!a.ok || !b.ok) throw new Error('External Discussion creation did not succeed');
        expect(a.value.discussion.id).not.toBe(b.value.discussion.id);
        expect(await listDiscussions({ anchorTask: entry, actorAccountId: second.id, authentication })).toMatchObject({ ok: true,
            value: { discussions: [{ id: b.value.discussion.id }], nextCursor: null } });
        expect(await getDiscussion({ discussionId: a.value.discussion.id, actorAccountId: second.id, authentication }))
            .toEqual({ ok: false, error: 'discussion_not_found' });
    });

    it('refuses an independent encryption conversion for a Task-key-owned thread', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const taskId = crypto.randomUUID();
        await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`,
            value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { id: taskId, title: 'Private task' } })) } });
        const request = requestFor({ kind: 'task', entry: { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(taskId, owner.id) } });
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request });
        if (!created.ok) throw new Error(created.error);
        const { discussion, firstMessage } = created.value;
        const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
            recipientPublicKey: tweetnacl.box.keyPair().publicKey, randomBytes: tweetnacl.randomBytes }));
        const result = await inTx(tx => migrateDiscussionAccountEncryptionInTx(tx, {
            accountId: owner.id, fromMode: 'plain', toMode: 'e2ee', directive: { items: [{ discussionId: discussion.id,
                expectedDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, dataEncryptionKey,
                expectedTitleContent: request.titleContent, titleContent: { t: 'encrypted', c: 'opaque-title' },
                messages: [{ id: firstMessage.id, expectedContent: request.firstMessage.content,
                    content: { t: 'encrypted', c: 'opaque-comment' } }], recipientKeyEnvelopes: [],
            }] },
        }));
        expect(result).toEqual({ status: 'migration_incomplete' });
        expect(await getDiscussion({ discussionId: discussion.id, actorAccountId: owner.id, authentication })).toMatchObject({ ok: true });
    });

    it('atomically deletes the Task-anchored Discussion thread when deleting a Task', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const taskId = crypto.randomUUID();
        const task = await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`,
            value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { id: taskId, title: 'Deletable task' } })) } });
        await db.taskGrant.create({ data: { taskId: task.id, principalKind: 'account', accountId: member.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        const anchor = { kind: 'task' as const, entry: { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(taskId, owner.id) } };

        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: requestFor(anchor, member.id) });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;

        expect(await getDiscussion({ discussionId, actorAccountId: owner.id, authentication })).toMatchObject({ ok: true });
        expect(await getDiscussion({ discussionId, actorAccountId: member.id, authentication })).toMatchObject({ ok: true });
        expect(await listDiscussions({ anchorTask: anchor.entry, actorAccountId: owner.id, authentication })).toMatchObject({ ok: true,
            value: { discussions: [{ id: discussionId }], nextCursor: null } });
        expect(await db.discussion.count({ where: { id: discussionId } })).toBe(1);
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);

        expect(await deleteTaskResource({ ownerAccountId: owner.id, taskId, actorAccountId: owner.id, authentication })).toEqual({
            ok: true, value: { deleted: true },
        });

        expect(await getDiscussion({ discussionId, actorAccountId: owner.id, authentication })).toEqual({ ok: false, error: 'discussion_not_found' });
        expect(await getDiscussion({ discussionId, actorAccountId: member.id, authentication })).toEqual({ ok: false, error: 'discussion_not_found' });
        expect(await listDiscussions({ anchorTask: anchor.entry, actorAccountId: owner.id, authentication })).toEqual({ ok: true,
            value: { discussions: [], nextCursor: null } });
        expect(await listDiscussions({ anchorKinds: ['task'], actorAccountId: owner.id, authentication })).toEqual({ ok: true,
            value: { discussions: [], nextCursor: null } });
        expect(await listDiscussions({ anchorKinds: ['task'], actorAccountId: member.id, authentication })).toEqual({ ok: true,
            value: { discussions: [], nextCursor: null } });

        const ownerToken = await createAccountTokenForTests(owner.id, { kind: 'terminal', authority: 'account_automation' });
        await withAuthenticatedTestApp(registerDiscussionRoutes, async app => {
            const response = await app.inject({ method: 'GET', url: `/v1/discussions/${discussionId}`, headers: { authorization: `Bearer ${ownerToken}` } });
            expect(response.statusCode).toBe(404);
        }, { authentication: 'real' });

        expect(await db.discussion.count({ where: { id: discussionId } })).toBe(0);
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(0);
        expect(await db.discussionReadState.count({ where: { discussionId } })).toBe(0);
        expect(await db.discussionGrant.count({ where: { discussionId } })).toBe(0);
        expect(await db.discussionKeyEnvelope.count({ where: { discussionId } })).toBe(0);
        expect(await db.discussionParticipant.count({ where: { discussionId } })).toBe(0);
        expect(await db.taskGrant.count({ where: { taskId: task.id } })).toBe(0);
        expect(await db.taskKeyEnvelope.count({ where: { taskId: task.id } })).toBe(0);
        expect(await inTx(tx => readDiscussionAccountEncryptionInventoryInTx(tx, { accountId: owner.id, authentication }))).toEqual({ items: [] });
        expect(await db.accountChange.count({ where: { accountId: owner.id, kind: 'discussion', entityId: discussionId } })).toBe(1);
        expect(await db.accountChange.count({ where: { accountId: member.id, kind: 'discussion', entityId: discussionId } })).toBe(1);

        const withoutDiscussionTaskId = crypto.randomUUID();
        await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${withoutDiscussionTaskId}`,
            value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { id: withoutDiscussionTaskId, title: 'No comments' } })) } });
        expect(await deleteTaskResource({ ownerAccountId: owner.id, taskId: withoutDiscussionTaskId, actorAccountId: owner.id, authentication })).toEqual({
            ok: true, value: { deleted: true },
        });
    });
});
