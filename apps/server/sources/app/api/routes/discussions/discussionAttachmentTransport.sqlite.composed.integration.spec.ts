import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { buildDiscussionMutationRequestBodyV1, DiscussionPostResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionDetailsResultV1Schema, DiscussionReadResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { prepareAttachmentPayloads } from '../../../../../../ui/sources/sync/domains/attachments/prepareAttachmentPayloads';
import { prepareDiscussionAttachmentUpload, requestDiscussionAttachmentUpload } from '../../../../../../ui/sources/sync/api/discussions/discussionAttachmentTransport';
import { createDiscussionActionAdapter } from '../../../../../../ui/sources/sync/api/discussions/discussionActions';
import { publishMountedDiscussionChanges } from '../../../../../../ui/sources/sync/domains/discussions/discussionChangeWatch';
import { createDiscussionRepository } from '../../../../../../ui/sources/sync/ops/discussions/discussionRepository';
import { client } from '../../../../../../ui/sources/sync/ops/discussions/discussionRepository.testkit';
import { createAttachmentApp } from './discussionAttachments.testkit';

vi.mock('react-native', async () => (await import('../../../../../../ui/sources/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

// The existing UI→server lane owns native/Expo boundaries; transfer and storage stay real.
describe('UI-prepared Discussion attachment transport (SQLite composition)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-ui-files-', initAuth: false, initEncrypt: true, initFiles: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('streams two UI files and replays an older attachment removal to an open participant', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const { app, restoreEnvironment } = createAttachmentApp(() => owner.id);
        const participant = createAttachmentApp(() => reader.id);
        changesRoutes(participant.app);
        try {
            const created = await app.inject({ method: 'POST', url: '/v1/discussions', payload: {
                creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Two selected files' } },
                participants: [{ kind: 'account', accountId: reader.id }], firstMessage: {
                    localId: randomUUID(), mentionedAccountIds: [],
                    content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Existing Discussion' }] } },
                },
            } });
            expect(created.statusCode, created.body).toBe(200);
            const discussionId: string = created.json().discussion.id;
            const prepareFiles = async () => {
                // Match the live regression's uneven file lengths; bytes remain opaque to the server.
                const leaves = [
                    { blobId: randomUUID(), name: 'attachment-garden.png', mime: 'image/png', bytes: Uint8Array.from({ length: 8600 }, (_, index) => index % 251) },
                    { blobId: randomUUID(), name: 'attachment-note.txt', mime: 'text/plain', bytes: new TextEncoder().encode('n'.repeat(191)) },
                ];
                const prepared = await prepareAttachmentPayloads({ maxFileBytes: 8600, drafts: leaves.map(leaf => ({
                    id: leaf.blobId, source: { kind: 'web' as const, file: new File([leaf.bytes], leaf.name, { type: leaf.mime }) },
                })) });
                const authoredContent = DiscussionMessageContentV1Schema.parse({ v: 1, parts: [
                    { t: 'text', text: 'Two selected files' }, ...prepared.attachments.map(attachment => ({ t: 'attachment', attachment })),
                ] });
                const body = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: randomUUID(),
                    authoredContent, mentionedAccountIds: [], mentionedSessionIds: [], content: { t: 'plain', v: authoredContent } });
                const postFiles = async () => {
                    const { metadata, segments } = prepareDiscussionAttachmentUpload({ operation: 'post', body, discussionId,
                        references: prepared.sources.map(source => source.reference), sources: prepared.sources,
                        mode: 'plain', encryption: null, assertCurrent: () => {} });
                    return requestDiscussionAttachmentUpload({ request: async (path, init) => {
                        if (!(init?.body instanceof Blob)) throw new Error('Expected the real web upload body');
                        const response = await app.inject({ method: 'POST', url: path,
                            headers: Object.fromEntries(new Headers(init.headers).entries()),
                            payload: Buffer.from(await init.body.arrayBuffer()) });
                        return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
                    } }, metadata, segments);
                };
                return { leaves, postFiles };
            };
            const natural = await prepareFiles();
            const assertReadback = async (messageId: string, leaves: typeof natural.leaves) => {
                expect(await db.discussionAttachment.count({ where: { messageId } })).toBe(2);
                for (const leaf of leaves) {
                    const read = await app.inject({ method: 'GET',
                        url: `/v1/discussions/${discussionId}/messages/${messageId}/attachments/${leaf.blobId}` });
                    expect(read.statusCode, read.body).toBe(200);
                    expect(decodeBase64(read.json().content.v)).toEqual(leaf.bytes);
                }
                expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
            };
            const naturalPost = DiscussionPostResponseV1Schema.parse(await natural.postFiles());
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
            await assertReadback(naturalPost.message.id, natural.leaves);

            const other = await prepareFiles();
            const otherPost = DiscussionPostResponseV1Schema.parse(await other.postFiles());
            const later = await app.inject({ method: 'POST', url: `/v1/discussions/${discussionId}/messages`, payload: {
                localId: randomUUID(), mentionedAccountIds: [],
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Newer message' }] } },
            } });
            expect(later.statusCode, later.body).toBe(200);
            const scope = { serverId: 'test-home', accountId: reader.id };
            const reads: string[] = [];
            const execute = createDiscussionActionAdapter({ scope, availability: 'available', accountMode: 'plain',
                encryption: null, request: async (url, init) => {
                    reads.push(url);
                    const response = await participant.app.inject({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
                    return new Response(response.body, { status: response.statusCode });
                },
            });
            const context = { surface: 'ui' as const, serverId: scope.serverId };
            const repository = createDiscussionRepository({ scope, address: scope, client: client({
                get: async id => ({ kind: 'succeeded', value: DiscussionDetailsResultV1Schema.parse(
                    await execute({ actionId: 'discussion.get', input: { discussionId: id }, context })) }),
                read: async (id, input = {}) => ({ kind: 'succeeded', value: DiscussionReadResultV1Schema.parse(
                    await execute({ actionId: 'discussion.read', input: { discussionId: id, ...input }, context })) }),
            }) });
            const unmount = repository.mount({ discussionId });
            try {
                await repository.refreshDiscussion(discussionId);
                const thread = () => repository.getSnapshot().threads[discussionId]!;
                const attachmentMessage = (id: string) => thread().messages.find(row => row.id === id);
                expect(thread().messages.map(row => row.seq)).toEqual([1, 2, 3, 4]);
                expect(attachmentMessage(naturalPost.message.id)?.removedAttachments).toBeUndefined();
                const cursor = await participant.app.inject({ url: '/v2/cursor' });
                expect(cursor.statusCode, cursor.body).toBe(200);
                const after = cursor.json().cursor as number;
                const attachmentBase = `/v1/discussions/${discussionId}/messages`;
                const blobId = natural.leaves[0]!.blobId;
                const remove = async (messageId: string, id: string) => {
                    const result = await app.inject({ method: 'DELETE', url: `${attachmentBase}/${messageId}/attachments/${id}` });
                    expect(result.statusCode, result.body).toBe(200);
                };
                const applyChanges = async (afterCursor: number) => {
                    const feed = await participant.app.inject({ url: `/v2/changes?after=${afterCursor}` });
                    expect(feed.statusCode, feed.body).toBe(200);
                    const page = ChangesResponseSchema.parse(feed.json());
                    expect(page.changes).toEqual([expect.objectContaining({ kind: 'discussion', entityId: discussionId })]);
                    publishMountedDiscussionChanges({ ...scope, afterCursor, changes: page.changes });
                    return page.nextCursor;
                };
                reads.length = 0;
                await remove(naturalPost.message.id, blobId);
                const next = await applyChanges(after);
                await vi.waitFor(() => expect(attachmentMessage(naturalPost.message.id)?.removedAttachments)
                    .toEqual([{ blobId, removedByAccountId: owner.id }]));
                expect(reads).toEqual([`${attachmentBase}?messageId=${naturalPost.message.id}`]);

                // The Account feed coalesces both writes. Replaying the page must catch both old rows.
                const secondBlobId = natural.leaves[1]!.blobId;
                const otherBlobId = other.leaves[0]!.blobId;
                reads.length = 0;
                await remove(naturalPost.message.id, secondBlobId);
                await remove(otherPost.message.id, otherBlobId);
                await applyChanges(next);
                await vi.waitFor(() => {
                    expect(attachmentMessage(naturalPost.message.id)?.removedAttachments?.map(row => row.blobId))
                        .toEqual(expect.arrayContaining([blobId, secondBlobId]));
                    expect(attachmentMessage(otherPost.message.id)?.removedAttachments)
                        .toEqual([{ blobId: otherBlobId, removedByAccountId: owner.id }]);
                });
                expect(reads).toEqual([
                    `${attachmentBase}?messageId=${naturalPost.message.id}`,
                    `${attachmentBase}?messageId=${otherPost.message.id}`,
                ]);
                expect(thread().messages.map(row => row.seq)).toEqual([1, 2, 3, 4]);
            } finally { unmount(); repository.clear(); }
        } finally {
            await participant.app.close();
            participant.restoreEnvironment();
            await app.close();
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
            restoreEnvironment();
        }
    });
});
