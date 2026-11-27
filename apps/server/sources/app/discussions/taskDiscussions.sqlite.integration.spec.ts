import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import tweetnacl from 'tweetnacl';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { migrateDiscussionAccountEncryptionInTx } from './accountEncryptionMigration';
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
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-task-discussions-', initAuth: true }); }, 120_000);
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
});
