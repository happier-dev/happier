import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { buildDiscussionMutationRequestBodyV1, DiscussionPostResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { prepareAttachmentPayloads } from '../../../../../../ui/sources/sync/domains/attachments/prepareAttachmentPayloads';
import { prepareDiscussionAttachmentUpload, requestDiscussionAttachmentUpload } from '../../../../../../ui/sources/sync/api/discussions/discussionAttachmentTransport';
import { createAttachmentApp } from './discussionAttachments.testkit';

// The existing UI→server lane owns native/Expo boundaries; transfer and storage stay real.
describe('UI-prepared Discussion attachment transport (SQLite composition)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-ui-files-', initAuth: false, initEncrypt: true, initFiles: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('posts two UI-prepared leaf attachments to an existing Discussion and reads back their exact bytes', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const { app, restoreEnvironment } = createAttachmentApp(() => owner.id);
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
        } finally {
            await app.close();
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
            restoreEnvironment();
        }
    });
});
