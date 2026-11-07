import { describe, expect, it, vi } from 'vitest';
import { DiscussionAttentionQueryV1Schema, DiscussionCreateRequestV1Schema, DiscussionCreateResponseV1Schema, DiscussionListResponseV1Schema, DiscussionPostRequestV1Schema, type DiscussionCreateRequestV1, type DiscussionCreateResponseV1, type DiscussionPostRequestV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionListResultV1Schema, DiscussionPostResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { CoordinationMessageRefV1Schema } from '@happier-dev/protocol/discussions/messageRefs';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createDiscussionActionAdapter, createDiscussionClient, readDiscussionAttentionPage } from './discussionActions';
import { Encryption } from '@/sync/encryption/encryption';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';
import { DiscussionAccessGrantsListResponseV1Schema, DiscussionRecipientKeyEnvelopeCommitInputV1Schema,
    type DiscussionRecipientKeyEnvelopeCommitInputV1 } from '@happier-dev/protocol/discussions/access';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { readDiscussionMentionedParticipantIdsV1 } from '@happier-dev/protocol/discussions/content';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { SessionInputSourceSessionV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { TriageEntryRefV1Schema } from '@happier-dev/protocol/tasks/entryRefV1';
import { hashBinaryContent, createBinaryContentEncryption, openBinaryContent } from '@/sync/encryption/binaryContent';
import { executeDocDiscussionWriteV1 } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import { readBinaryUploadFrameV1, decodeDiscussionUploadMetadataV1 } from '@happier-dev/transfers';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { prepareAttachmentPayloads } from '@/sync/domains/attachments/prepareAttachmentPayloads';
import { buildDiscussionContent } from '@/components/discussions/discussionComposerDocument';

// Browser HTTP is this suite's platform boundary; native URI custody has its own real-sink tests.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const scope = { serverId: 'home-a', accountId: 'account-a' };
const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Ready?' }] };
const input = { creationLocalId: 'create-local', title: 'Release readiness', firstMessage: { localId: 'message-local', content } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

/** HTTP is the boundary; mutation body, response, cipher and opened schemas remain real. */
function http(mode: 'plain' | 'e2ee', loseCreate = false, losePost = false) {
    let stored: DiscussionCreateResponseV1 | null = null;
    const creates: DiscussionCreateRequestV1[] = [];
    const posts: DiscussionPostRequestV1[] = [];
    const messages: DiscussionCreateResponseV1['firstMessage'][] = [];
    const request = async (path: string, init?: RequestInit): Promise<Response> => {
        const url = new URL(path, 'https://home.invalid');
        if (url.pathname === '/v1/discussions' && init?.method === 'GET') {
            const creationId = url.searchParams.get('creationLocalId');
            if (url.searchParams.has('anchorDocArtifactId') && stored) {
                const { content: _latestContent, ...latestMessage } = stored.discussion.latestMessage;
                return json({ discussions: [{ ...stored.discussion, latestMessage, firstMessage: stored.firstMessage }], nextCursor: null });
            }
            return json({ discussions: stored && url.searchParams.get('state') !== 'archived'
                && (!creationId || stored.discussion.creationLocalId === creationId) ? [stored.discussion] : [], nextCursor: null });
        }
        if (url.pathname === '/v1/discussions' && init?.method === 'POST') {
            const body = DiscussionCreateRequestV1Schema.parse(JSON.parse(String(init.body)));
            creates.push(body);
            if (stored) {
                if (body.creationLocalId !== stored.discussion.creationLocalId
                    || JSON.stringify(body.creationEqualityEvidenceV1) !== JSON.stringify(creates[0]?.creationEqualityEvidenceV1)) {
                    return json({ error: 'discussion_idempotency_conflict' }, 409);
                }
            } else {
                const firstMessage = { id: 'committed-message', discussionId: 'discussion-a', localId: body.firstMessage.localId,
                    seq: 1, authorAccountId: scope.accountId, accountActor: { v: 1, accountId: scope.accountId, profile: null },
                    producerV1: null, content: body.firstMessage.content, mentionedAccountIds: body.firstMessage.mentionedAccountIds,
                    ...(body.firstMessage.replyTarget ? { replyTarget: body.firstMessage.replyTarget } : {}), createdAt: 10 };
                const { content: _content, mentionedAccountIds: _mentions, discussionId: _discussion, replyTarget: _target, ...latestMessage } = firstMessage;
                stored = DiscussionCreateResponseV1Schema.parse({
                    discussion: { id: 'discussion-a', ownerAccountId: scope.accountId, encryptionMode: mode,
                        anchor: body.anchor ?? null, access: 'owner', keyReadiness: true, dataEncryptionKey: body.dataEncryptionKey ?? null,
                        creationLocalId: body.creationLocalId, titleContent: body.titleContent,
                        latestMessage: { ...latestMessage, content: body.firstMessage.content },
                        messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0,
                        recentAuthorAccountIds: [scope.accountId], archivedAt: null,
                        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } },
                    firstMessage,
                });
                messages.push(stored.firstMessage);
            }
            if (loseCreate) { loseCreate = false; throw new TypeError('response lost after commit'); }
            return json(stored);
        }
        if (url.pathname === '/v1/discussions/discussion-a' && stored) return json({ discussion: stored.discussion });
        if (url.pathname === '/v1/discussions/discussion-a/data-key/recipients' && stored) {
            return json({ discussionId: 'discussion-a', ownerAccountId: scope.accountId, access: 'owner', encryptionMode: mode,
                dataEncryptionKey: stored.discussion.dataEncryptionKey, callerDataEncryptionKey: stored.discussion.dataEncryptionKey,
                recipients: [] });
        }
        if (url.pathname === '/v1/discussions/discussion-a/messages' && init?.method === 'POST' && stored) {
            const body = DiscussionPostRequestV1Schema.parse(JSON.parse(String(init.body)));
            posts.push(body);
            let message = messages.find(row => row.localId === body.localId);
            if (!message) {
                message = { ...stored.firstMessage, id: `message-${messages.length + 1}`, seq: messages.length + 1,
                    localId: body.localId, content: body.content, mentionedAccountIds: body.mentionedAccountIds,
                    ...(body.replyTarget ? { replyTarget: body.replyTarget } : {}) };
                messages.push(message);
            }
            if (losePost) { losePost = false; throw new TypeError('response lost after commit'); }
            return json({ message, messageSeq: messages.length });
        }
        if (url.pathname.endsWith('/messages') && stored) return json({ messages, hasMoreOlder: false, messageSeq: messages.length });
        return json({ error: 'discussion_not_found' }, 404);
    };
    return { request, creates, posts, messages, readStored: () => stored,
        replaceStored: (value: DiscussionCreateResponseV1) => { stored = value; } };
}

async function adapter(mode: 'plain' | 'e2ee', transport: ReturnType<typeof http>, serverId = scope.serverId) {
    const secret = new Uint8Array(32).fill(7);
    const encryption = mode === 'e2ee' ? await Encryption.create(secret) : null;
    const ownerContentPublicKeyFingerprint = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({
        accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint : undefined;
    return createDiscussionActionAdapter({ scope: { ...scope, serverId }, request: transport.request,
        accountMode: mode, encryption, ownerContentPublicKeyFingerprint, availability: 'available' });
}
const context = { surface: 'ui' as const, serverId: scope.serverId };

describe('Discussion key-opening demand', () => {
    it.each(['discussion.get', 'discussion.read', 'discussion.list'] as const)(
        'routes %s keys by exact demand while preserving readable E2EE content', async actionId => {
            const transport = http('e2ee');
            const create = await adapter('e2ee', transport);
            await create({ actionId: 'discussion.create', input, context });
            const encryption = await Encryption.create(new Uint8Array(32).fill(7));
            const worker = createFakeCryptoWorker();
            const openings: Array<{ workClass: string; count: number }> = [];
            encryption.configureNativeCryptoWorker({ worker: { ...worker,
                decryptDataKeyEnvelopeV1: async request => {
                    openings.push({ workClass: request.workClass ?? 'bulk', count: request.items.length });
                    return worker.decryptDataKeyEnvelopeV1(request);
                },
            }, routing: { mode: 'auto', minPayloadBytes: 0 } });
            const run = createDiscussionActionAdapter({ scope, request: transport.request,
                accountMode: 'e2ee', encryption, availability: 'available' });
            const result = await run({ actionId, input: actionId === 'discussion.list' ? {} : { discussionId: 'discussion-a' }, context });
            expect(result).toMatchObject(actionId === 'discussion.list'
                ? { discussions: [{ title: input.title }] }
                : actionId === 'discussion.get' ? { discussion: { title: input.title } }
                    : { messages: [{ content }] });
            expect(openings).toEqual([{ workClass: actionId === 'discussion.list' ? 'bulk' : 'interactive', count: 1 }]);
        });
});

describe('Discussion attention transport', () => {
    it('preserves exact Discussion selection and the loaded occurrence frontier through the strict server query', async () => {
        const input = { discussionId: 'discussion / exact', afterCursor: 'lower+cursor=', cursor: 'upper+cursor=' };
        let received: unknown;
        const outcome = await readDiscussionAttentionPage({ scope, encryption: null, availability: 'available',
            request: async path => {
                const url = new URL(path, 'https://home.invalid');
                expect(url.pathname).toBe('/v1/discussions/attention');
                received = DiscussionAttentionQueryV1Schema.parse(Object.fromEntries(url.searchParams));
                return json({ discussions: [], nextCursor: null, incomplete: false });
            } }, input);
        expect(received).toEqual(input);
        expect(outcome).toEqual({ kind: 'succeeded', value: { v: 1, serverId: scope.serverId,
            discussions: [], nextCursor: null, incomplete: false } });
    });
});

describe('Discussion attachment byte transport', () => {
    it.each(['plain', 'e2ee'] as const)('frames two unequal web files for an existing %s Discussion through the real consumer', async mode => {
        const transport = http(mode);
        const secret = new Uint8Array(32).fill(7);
        const encryption = mode === 'e2ee' ? await Encryption.create(secret) : null;
        const ownerContentPublicKeyFingerprint = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint : undefined;
        const bytes = [Uint8Array.from({ length: 8600 }, (_, index) => index % 251), new TextEncoder().encode('n'.repeat(191))];
        const files = [new File([bytes[0]!], 'attachment-garden.png', { type: 'image/png' }),
            new File([bytes[1]!], 'attachment-note.txt', { type: 'text/plain' })];
        const prepared = await prepareAttachmentPayloads({ maxFileBytes: 25 * 1024 * 1024,
            drafts: files.map((file, index) => ({ id: index === 0 ? 'e8eb80ae-7e18-4bbe-8c0e-c9d762787a86'
                : '1aaa2291-6e0b-4547-95b6-5a1238440820', source: { kind: 'web' as const, file } })) });
        const content = buildDiscussionContent('Review both selected files', [], undefined, prepared.attachments);
        const uploads: Uint8Array[] = [];
        const network = async (path: string, init?: RequestInit): Promise<Response> => {
                if (path !== '/v1/discussions/upload') return transport.request(path, init);
                expect(init?.body).toBeInstanceOf(Blob);
                expect(new Headers(init?.headers).get('content-type')).toBe('application/vnd.happier.discussion-upload-v1');
                const frame = new Uint8Array(await new Response(init?.body).arrayBuffer());
                // A browser may coalesce metadata and both leaves into one HTTP chunk.
                const metadata = await readBinaryUploadFrameV1((async function* () { yield frame; })(), {
                    metadataMaxBytes: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
                    decodeMetadata: decodeDiscussionUploadMetadataV1,
                    onMetadata: async value => value.attachments,
                    onSegment: async (_index, chunks) => {
                        const parts: Uint8Array[] = [];
                        for await (const chunk of chunks) parts.push(chunk);
                        const opened = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
                        let offset = 0;
                        for (const part of parts) { opened.set(part, offset); offset += part.length; }
                        uploads.push(opened);
                    },
                });
                expect(metadata.operation).toBe('post');
                if (metadata.operation !== 'post') throw new Error('Expected an existing Discussion post');
                expect(metadata.attachments.map(value => value.blobId)).toEqual(prepared.sources.map(value => value.reference.blobId));
                expect(metadata.input.attachments).toEqual(prepared.sources.map(value => ({ blobId: value.reference.blobId,
                    t: mode === 'plain' ? 'plain' : 'encrypted' })));
                const { discussionId, ...body } = metadata.input;
                return transport.request(`/v1/discussions/${discussionId}/messages`, { ...init, body: JSON.stringify(body) });
        };
        // Only global fetch is substituted: the production endpoint and runtime-fetch
        // wrappers must preserve the vendor content type and actual Blob body.
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
        const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => network(new URL(String(url)).pathname, init));
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://upload.test', credentials: null });
        const execute = createDiscussionActionAdapter({ scope, encryption, accountMode: mode, ownerContentPublicKeyFingerprint,
            availability: 'available', attachmentSources: prepared.sources,
            request: (path, init) => request(path, init, { retry: 'none' }) });
        try {
            await execute({ actionId: 'discussion.create', input, context });
            const result = await execute({ actionId: 'discussion.post', input: { discussionId: 'discussion-a', localId: 'two-web-files', content }, context });
            expect(result).toMatchObject({ message: { content } });
            expect(uploads).toHaveLength(2);
            const dataKey = mode === 'e2ee' ? await encryption!.decryptEncryptionKey(transport.readStored()!.discussion.dataEncryptionKey!, scope) : null;
            for (const [index, selected] of prepared.sources.entries()) {
                expect(await openBinaryContent({ reference: selected.reference, mode,
                    encryption: dataKey ? createBinaryContentEncryption(dataKey) : null,
                    content: mode === 'plain' ? { t: 'plain', v: encodeBase64(uploads[index]!) } : { t: 'encrypted', c: encodeBase64(uploads[index]!) } })).toEqual(bytes[index]);
            }
        } finally { fetchBoundary.mockRestore(); resetRuntimeFetch(); }
    });
    it.each([false, true])('retains a committed effect as uncertain when its captured Account retires (byte frame: %s)', async binary => {
        const transport = http('plain');
        let current = true;
        const bytes = new Uint8Array([4, 5]);
        const reference = { blobId: 'e8eb80ae-7e18-4bbe-8c0e-c9d762787a86', mime: 'application/octet-stream', sizeBytes: bytes.length, sha256: hashBinaryContent(bytes) };
        const content = binary ? { v: 1 as const, parts: [{ t: 'attachment' as const,
            attachment: { kind: 'file' as const, id: reference.blobId, name: 'data.bin', file: reference } }] } : input.firstMessage.content;
        const execute = createDiscussionActionAdapter({ scope, accountMode: 'plain', encryption: null, availability: 'available',
            assertCurrent: () => { if (!current) throw Object.assign(new Error('Account changed'), { code: 'action_account_scope_changed' }); },
            attachmentSources: binary ? [{ reference, source: { kind: 'memory', name: 'data.bin', bytes } }] : undefined,
            request: async (path, init) => {
                if (init?.method !== 'POST') return transport.request(path, init);
                let result: Response;
                if (path === '/v1/discussions/upload') {
                    const frame = new Uint8Array(await new Response(init.body).arrayBuffer());
                    const metadata = JSON.parse(new TextDecoder().decode(frame.subarray(0, frame.indexOf(10))));
                    result = await transport.request('/v1/discussions', { ...init, body: JSON.stringify(metadata.input) });
                } else result = await transport.request(path, init);
                current = false;
                return result;
            } });
        expect(await execute({ actionId: 'discussion.create', input: { ...input, firstMessage: { ...input.firstMessage, content } }, context }))
            .toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
        expect(transport.creates).toHaveLength(1);
        expect(await execute({ actionId: 'discussion.get', input: { discussionId: 'discussion-a' }, context }))
            .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(transport.creates).toHaveLength(1);
    });
    it.each([false, true])('keeps cancellation after a dispatched write uncertain (byte frame: %s)', async binary => {
        const transport = http('plain');
        const controller = new AbortController();
        const bytes = new Uint8Array([4, 5]);
        const reference = { blobId: 'e8eb80ae-7e18-4bbe-8c0e-c9d762787a86', mime: 'application/octet-stream', sizeBytes: bytes.length, sha256: hashBinaryContent(bytes) };
        const content = binary ? { v: 1 as const, parts: [{ t: 'attachment' as const,
            attachment: { kind: 'file' as const, id: reference.blobId, name: 'data.bin', file: reference } }] } : input.firstMessage.content;
        const execute = createDiscussionActionAdapter({ scope, accountMode: 'plain', encryption: null, availability: 'available',
            attachmentSources: binary ? [{ reference, source: { kind: 'memory', name: 'data.bin', bytes } }] : undefined,
            request: async (path, init) => {
                if (init?.method !== 'POST') return transport.request(path, init);
                if (path === '/v1/discussions/upload') {
                    const frame = new Uint8Array(await new Response(init.body).arrayBuffer());
                    const metadata = JSON.parse(new TextDecoder().decode(frame.subarray(0, frame.indexOf(10))));
                    await transport.request('/v1/discussions', { ...init, body: JSON.stringify(metadata.input) });
                } else await transport.request(path, init);
                controller.abort();
                throw new DOMException('Response canceled after commit', 'AbortError');
            } });
        expect(await execute({ actionId: 'discussion.create', input: { ...input, firstMessage: { ...input.firstMessage, content } }, context, signal: controller.signal }))
            .toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
        expect(transport.creates).toHaveLength(1);
        const beforeDispatch = new AbortController();
        beforeDispatch.abort();
        expect(await execute({ actionId: 'discussion.create', input, context, signal: beforeDispatch.signal }))
            .toMatchObject({ ok: false, errorCode: 'canceled' });
        expect(transport.creates).toHaveLength(1);
    });
    it.each([
        { mode: 'plain', doc: false }, { mode: 'e2ee', doc: false },
        { mode: 'plain', doc: true }, { mode: 'e2ee', doc: true },
    ] as const)('commits first-message $mode bytes through the canonical writer (Doc comment: $doc)', async ({ mode, doc }) => {
        const transport = http(mode);
        const bytes = new Uint8Array([0, 255, 13, 10]);
        const reference = { blobId: 'e8eb80ae-7e18-4bbe-8c0e-c9d762787a86', mime: 'image/png', sizeBytes: bytes.length, sha256: hashBinaryContent(bytes) };
        const textContent = { v: 1 as const, parts: [{ t: 'attachment' as const,
            attachment: { kind: 'file' as const, id: reference.blobId, name: 'private.png', file: reference } }] };
        const passage = { ref: { kind: 'doc' as const, artifactId: 'notes', serverId: scope.serverId },
            revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 1 }, quote: 'x' };
        const content = doc ? { kind: 'doc_passage_comment' as const, passage, content: textContent } : textContent;
        const uploads: Uint8Array[] = [];
        let attachmentReads = 0;
        let tamper = false;
        const secret = new Uint8Array(32).fill(7);
        const encryption = mode === 'e2ee' ? await Encryption.create(secret) : null;
        const ownerContentPublicKeyFingerprint = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint : undefined;
        const execute = createDiscussionActionAdapter({ scope, encryption, accountMode: mode, ownerContentPublicKeyFingerprint,
            availability: 'available', attachmentSources: [{ reference, source: { kind: 'memory', name: 'private.png', bytes } }],
            request: async (path, init) => {
                if (path === `/v1/discussions/discussion-a/messages/committed-message/attachments/${reference.blobId}`) {
                    attachmentReads++;
                    const body = tamper ? new Uint8Array([1, 2, 3, 4]) : uploads[0]!;
                    return json({ blobId: reference.blobId, content: mode === 'plain'
                        ? { t: 'plain', v: encodeBase64(body) } : { t: 'encrypted', c: encodeBase64(body) } });
                }
                if (path !== '/v1/discussions/upload') return transport.request(path, init);
                const frame = new Uint8Array(await new Response(init?.body).arrayBuffer());
                const newline = frame.indexOf(10);
                const metadata = JSON.parse(new TextDecoder().decode(frame.subarray(0, newline)));
                expect(metadata.operation).toBe('create');
                expect(metadata.attachments).toEqual([{ blobId: reference.blobId, t: mode === 'plain' ? 'plain' : 'encrypted', storedSizeBytes: frame.length - newline - 1 }]);
                if (mode === 'e2ee') expect(new TextDecoder().decode(frame.subarray(0, newline))).not.toContain('private.png');
                uploads.push(frame.subarray(newline + 1));
                return transport.request('/v1/discussions', { ...init, body: JSON.stringify(metadata.input) });
            } });
        const result = doc ? await executeDocDiscussionWriteV1('doc.comment.reply', { target: passage, localId: 'doc-root', content: textContent }, context, execute)
            : await execute({ actionId: 'discussion.create', input: { ...input, firstMessage: { ...input.firstMessage, content } }, context });
        expect(result).toMatchObject(doc ? { ok: true, result: { message: { content } } } : { firstMessage: { content } });
        expect(uploads).toHaveLength(1);
        const stored = transport.readStored()!;
        const dataKey = mode === 'e2ee' ? await encryption!.decryptEncryptionKey(stored.discussion.dataEncryptionKey!, scope) : null;
        expect(await openBinaryContent({ reference, mode, encryption: dataKey ? createBinaryContentEncryption(dataKey) : null,
            content: mode === 'plain' ? { t: 'plain', v: encodeBase64(uploads[0]!) } : { t: 'encrypted', c: encodeBase64(uploads[0]!) } })).toEqual(bytes);
        expect(attachmentReads).toBe(0);
        const readInput = { discussionId: 'discussion-a', messageId: 'committed-message', blobId: reference.blobId };
        expect(await execute({ actionId: 'discussion.attachment.read', input: readInput, context }))
            .toEqual({ ...reference, bytesBase64: encodeBase64(bytes) });
        tamper = true;
        expect(await execute({ actionId: 'discussion.attachment.read', input: readInput, context }))
            .toMatchObject({ ok: false, errorCode: 'binary_content_unavailable' });
        expect(await execute({ actionId: 'discussion.attachment.read', input: { ...readInput, blobId: '1aaa2291-6e0b-4547-95b6-5a1238440820' }, context }))
            .toMatchObject({ ok: false, errorCode: 'discussion_content_unavailable' });
        expect(attachmentReads).toBe(2);
    });
});

describe('Discussion UI Action adapter', () => {
    it.each(['plain', 'e2ee'] as const)('preserves a canonical Task anchor and reply target through the %s resource codec', async mode => {
        const transport = http(mode);
        const execute = await adapter(mode, transport);
        const entry = TriageEntryRefV1Schema.parse({ source: { pluginId: 'acme.tasks', localId: 'issues' }, kindId: 'issue',
            collisionScope: 'project', entryId: 'task/42' });
        const anchor = { kind: 'task', entry };
        const created = await execute({ actionId: 'discussion.create', input: { ...input, anchor }, context });
        expect(created).toMatchObject({ discussion: { anchor }, firstMessage: { content } });
        const replyTarget = { kind: 'task', entry };
        const posted = await execute({ actionId: 'discussion.reply', input: { discussionId: 'discussion-a',
            localId: 'task-reply', content, replyTarget }, context });
        expect(DiscussionPostResultV1Schema.parse(posted).message).toMatchObject({ replyTarget, content });
        expect(transport.creates[0]?.anchor).toEqual(anchor);
        expect(transport.posts[0]?.replyTarget).toEqual(replyTarget);
        expect(await execute({ actionId: 'discussion.get', input: { discussionId: 'discussion-a' }, context }))
            .toMatchObject({ discussion: { anchor } });
    });
    it('opens a filtered Doc root with its summary key without per-thread requests or a latest preview', async () => {
        const transport = http('e2ee');
        const request = transport.request;
        const reads: string[] = [];
        let rootState: 'ready' | 'source_unavailable' | 'key_unavailable' | 'unreadable' | 'missing' = 'ready';
        transport.request = async (path, init) => {
            reads.push(path);
            if (rootState !== 'ready' && new URL(path, 'https://home.invalid').searchParams.has('anchorDocArtifactId')) {
                const response = await request(path, init);
                const page = DiscussionListResponseV1Schema.parse(await response.json());
                return json({ ...page, discussions: page.discussions.map(row => {
                    if (rootState === 'source_unavailable') return { ...row, firstMessage: null };
                    if (rootState === 'key_unavailable') return { ...row, keyReadiness: false, dataEncryptionKey: null };
                    if (rootState === 'unreadable') return { ...row, firstMessage: { ...row.firstMessage!, content: row.titleContent } };
                    const { firstMessage: _firstMessage, ...missingRoot } = row;
                    return missingRoot;
                }) });
            }
            return request(path, init);
        };
        const execute = await adapter('e2ee', transport);
        const doc = { ref: { kind: 'doc' as const, serverId: scope.serverId, artifactId: 'notes' }, revision: { headerVersion: 1, bodyVersion: 1 } };
        const rootContent = { kind: 'doc_passage_comment' as const, passage: { ...doc, range: { start: 0, end: 5 }, quote: 'Notes' }, content };
        await execute({ actionId: 'discussion.create', input: { ...input, anchor: { kind: 'doc', doc },
            firstMessage: { ...input.firstMessage, content: rootContent, replyTarget: { kind: 'doc_passage', doc } } }, context });
        reads.length = 0;
        const result = await execute({ actionId: 'discussion.list', input: { state: 'active', anchorDocArtifactId: 'notes' }, context });
        expect(result).toMatchObject({ discussions: [{ firstMessage: { seq: 1, content: rootContent } }], incomplete: false });
        expect(DiscussionListResultV1Schema.parse(result).discussions[0]!.latestMessage).not.toHaveProperty('content');
        expect(reads).toHaveLength(1);
        expect(new URL(reads[0]!, 'https://home.invalid').pathname).toBe('/v1/discussions');
        const ordinary = DiscussionListResultV1Schema.parse(await execute({ actionId: 'discussion.list', input: {}, context }));
        expect(ordinary.discussions[0]).not.toHaveProperty('firstMessage');
        rootState = 'source_unavailable';
        const unavailable = DiscussionListResultV1Schema.parse(await execute({ actionId: 'discussion.list',
            input: { state: 'active', anchorDocArtifactId: 'notes' }, context }));
        expect(unavailable.discussions[0]!.firstMessage).toBeNull();
        rootState = 'key_unavailable';
        const locked = DiscussionListResultV1Schema.parse(await execute({ actionId: 'discussion.list',
            input: { state: 'active', anchorDocArtifactId: 'notes' }, context }));
        expect(locked.discussions[0]!.firstMessage).toBeNull();
        rootState = 'unreadable';
        const unreadable = DiscussionListResultV1Schema.parse(await execute({ actionId: 'discussion.list',
            input: { state: 'active', anchorDocArtifactId: 'notes' }, context }));
        expect(unreadable.discussions[0]!.firstMessage).toMatchObject({ seq: 1, content: null });
        rootState = 'missing';
        const missing = DiscussionListResultV1Schema.parse(await execute({ actionId: 'discussion.list',
            input: { state: 'active', anchorDocArtifactId: 'notes' }, context }));
        expect(missing.discussions[0]).not.toHaveProperty('firstMessage');
    });

    it.each(['plain', 'e2ee'] as const)('withholds unbounded %s latest content in an actual addressed Session Action context', async mode => {
        const transport = http(mode);
        const execute = await adapter(mode, transport);
        await execute({ actionId: 'discussion.create', input, context });
        const protectedContext = { ...context, surface: 'mcp' as const, actionCaller: { kind: 'session' as const, sessionId: 'receiver', starterDepth: 0, turnDepth: 0 },
            sessionInputSource: SessionInputSourceSessionV1Schema.parse({ sourceSessionId: 'receiver', sourceInputId: 'question-input',
                sourceTurnId: 'question-turn', via: 'mcp',
                discussionAddressing: { discussionId: 'discussion-a', messageId: 'question', throughSeq: 1, participantSessionId: 'receiver' } }) };
        expect(await execute({ actionId: 'discussion.list', input: {}, context: protectedContext }))
            .toMatchObject({ discussions: [{ title: input.title, latestMessage: { content: null } }], incomplete: true });
        expect(await execute({ actionId: 'discussion.get', input: { discussionId: 'discussion-a' }, context: protectedContext }))
            .toMatchObject({ discussion: { title: input.title, latestMessage: { content: null } } });
        expect(await execute({ actionId: 'discussion.get', input: { discussionId: 'discussion-a' },
            context: { ...protectedContext, sessionInputSource: undefined } }))
            .toMatchObject({ discussion: { latestMessage: { content } } });
    });

    it('opens the original latest-message envelope in one Home list read and never exposes ciphertext as preview content', async () => {
        const transport = http('e2ee');
        const execute = await adapter('e2ee', transport);
        await execute({ actionId: 'discussion.create', input, context });
        const stored = transport.readStored()!;
        expect(stored.discussion.latestMessage.content).toEqual(stored.firstMessage.content);
        expect(stored.discussion.latestMessage.content).not.toEqual(content);
        const participantAccounts = [{ v: 1 as const, accountId: 'quiet-invitee', profile: {
            name: 'Quiet invitee', firstName: 'Quiet invitee', lastName: null, username: null, avatarUrl: 'https://files.test/invitee.png',
        } }];
        transport.replaceStored({ ...stored, discussion: { ...stored.discussion, participantAccounts, participantSessionIds: ['invited-session'] } });
        const paths: string[] = [];
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const read = createDiscussionActionAdapter({ scope, encryption, availability: 'available', request: (path, init) => {
            paths.push(path);
            return transport.request(path, init);
        } });
        expect(await read({ actionId: 'discussion.list', input: {}, context })).toMatchObject({
            discussions: [{ latestMessage: { content }, participantAccounts, participantSessionIds: ['invited-session'] }], incomplete: false,
        });
        expect(paths).toEqual(['/v1/discussions']);
        const locked = createDiscussionActionAdapter({ scope, encryption: null, availability: 'available', request: transport.request });
        expect(await locked({ actionId: 'discussion.list', input: {}, context })).toMatchObject({
            discussions: [{ title: null, latestMessage: { content: null } }], incomplete: true,
        });
        transport.replaceStored({ ...stored, discussion: { ...stored.discussion,
            latestMessage: { ...stored.discussion.latestMessage, content: { t: 'plain', v: content } } } });
        expect(await read({ actionId: 'discussion.list', input: {}, context })).toMatchObject({
            discussions: [{ latestMessage: { content: null } }], incomplete: true,
        });
    });

    it('previews source admission without creating a Discussion or preparing recipient keys', async () => {
        const requests: Array<{ path: string; input: unknown }> = [];
        const source = { kind: 'session', message: { kind: 'session', session: { serverId: scope.serverId, sessionId: 'source-session' }, messageId: 'answer' } };
        const preview = { source, sourceAudienceAccountIds: ['account-a'], sourceContentReady: true, reviewers: [],
            discussionAudienceAccountIds: ['account-a'], missingDiscussionSourceAccountIds: [],
            discussionDisclosure: { ok: true }, canGrantSource: true };
        const execute = createDiscussionActionAdapter({ scope, encryption: null, availability: 'available',
            request: async (path, init) => {
                requests.push({ path, input: JSON.parse(String(init?.body)) });
                return json({ ok: true, value: preview });
            } });
        expect(await execute({ actionId: 'discussion.second_opinion.start', context,
            input: { intent: 'preview', source, title: 'Review', question: 'Is this right?', reviewers: [],
                retry: { creationLocalId: 'creation', quoteLocalId: 'quote', questionLocalId: 'question' } } }))
            .toMatchObject({ ok: true, value: preview });
        expect(requests).toEqual([{ path: '/v1/discussions/second-opinion/preview', input: { source, reviewers: [] } }]);
    });

    it.each(['plain', 'e2ee'] as const)('derives proposal initialization in the real %s codec without marking ordinary text', async mode => {
        const transport = http(mode);
        const execute = await adapter(mode, transport);
        const revision = { headerVersion: 1, bodyVersion: 2 };
        const proposal = { kind: 'doc_edit_proposal', proposal: {
            target: { ref: { kind: 'doc', artifactId: 'doc', serverId: scope.serverId }, revision,
                range: { start: 0, end: 3 }, quote: 'old' }, baseRevision: revision, before: 'old', after: 'new', reason: 'clarify',
        } };
        await execute({ actionId: 'discussion.create', input: { ...input, firstMessage: { ...input.firstMessage, content: proposal } }, context });
        expect(transport.creates[0]?.firstMessage).toMatchObject({ docEditProposal: true });
        await execute({ actionId: 'discussion.post', input: { discussionId: 'discussion-a', localId: 'proposal', content: proposal }, context });
        expect(transport.posts[0]).toMatchObject({ docEditProposal: true });
        await execute({ actionId: 'discussion.post', input: { discussionId: 'discussion-a', localId: 'text', content }, context });
        expect(transport.posts[1]).not.toHaveProperty('docEditProposal');
    });
    it('refuses executable invitation from a different Home before dispatch or allocation', async () => {
        const client = createDiscussionClient({ scope, availability: 'available' });
        const launch = { executionTarget: { serverId: 'home-b', machineId: 'machine-b' },
            directory: { kind: 'path', path: '/workspace' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        expect(await client.inviteExecutableParticipant({ discussionId: 'discussion-a',
            selection: { kind: 'session', session: { serverId: 'home-b', sessionId: 'same-raw-session' } } }))
            .toEqual({ kind: 'failed', errorCode: 'discussion_participant_home_mismatch' });
        expect(await client.inviteExecutableParticipant({ discussionId: 'discussion-a',
            selection: { kind: 'model', launch: { ...launch, executionTarget: { serverId: scope.serverId, machineId: 'machine-a' } } } }))
            .toEqual({ kind: 'failed', errorCode: 'discussion_participant_slot_required' });
    });

    it('preserves owned Session lifecycle descriptors from archive through the opened result', async () => {
        const transport = http('plain');
        const ownedSessions = [{ discussionId: 'discussion-a', participantSlotId: 'model-slot', sessionId: 'owned-session' }];
        const execute = createDiscussionActionAdapter({ scope, accountMode: 'plain', encryption: null,
            availability: 'available', request: async (path, init) => path.endsWith('/archive')
                ? json({ discussion: transport.readStored()!.discussion, ownedSessions }) : transport.request(path, init) });
        await execute({ actionId: 'discussion.create', input, context });
        expect(await execute({ actionId: 'discussion.archive', input: { discussionId: 'discussion-a' }, context }))
            .toMatchObject({ discussion: { id: 'discussion-a' }, ownedSessions });
    });

    it('projects omitted attention lists from strict content for create and post without rewriting explicit lists', async () => {
        const transport = http('e2ee');
        const execute = await adapter('e2ee', transport);
        const addressedContent = { v: 1 as const, parts: [
            { t: 'mention' as const, participant: { kind: 'account' as const, accountId: 'invited-person' } },
            { t: 'mention' as const, participant: { kind: 'session' as const, sessionId: 'invited-session' } },
        ] };
        const attention = readDiscussionMentionedParticipantIdsV1(addressedContent);
        await execute({ actionId: 'discussion.create', input: { ...input, firstMessage: { ...input.firstMessage, content: addressedContent } }, context });
        expect(transport.creates[0]?.firstMessage).toMatchObject(attention);
        await execute({ actionId: 'discussion.post', input: { discussionId: 'discussion-a', localId: 'implicit-attention', content: addressedContent }, context });
        expect(transport.posts[0]).toMatchObject(attention);
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const dataKey = await encryption.decryptEncryptionKey(transport.readStored()!.discussion.dataEncryptionKey!, scope);
        if (!dataKey) throw new Error('The actual created resource key must open');
        expect(transport.posts[0]?.requestEqualityEvidenceV1).toEqual({ kind: 'e2eeTag', tag: deriveDiscussionMutationEqualityTagV1({ dataKey,
            canonicalIntent: serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content: addressedContent, ...attention }) }) });
        await execute({ actionId: 'discussion.post', input: { discussionId: 'discussion-a', localId: 'explicit-attention',
            content: addressedContent, mentionedAccountIds: [], mentionedSessionIds: [] }, context });
        expect(transport.posts[1]).toMatchObject({ mentionedAccountIds: [], mentionedSessionIds: [] });
    });

    it('preserves typed Session addressing in independent create and post transport', async () => {
        const transport = http('e2ee');
        const execute = await adapter('e2ee', transport);
        const addressedContent = { v: 1 as const, parts: [{ t: 'mention' as const,
            participant: { kind: 'session' as const, sessionId: 'invited-session' } }] };
        expect(await execute({ actionId: 'discussion.create', input: { ...input, firstMessage: { ...input.firstMessage,
            content: addressedContent, mentionedSessionIds: ['invited-session'] } }, context })).toMatchObject({ discussion: { id: 'discussion-a' } });
        expect(transport.creates[0]?.firstMessage.mentionedSessionIds).toEqual(['invited-session']);
        expect(await execute({ actionId: 'discussion.post', input: { discussionId: 'discussion-a', localId: 'addressed-post',
            content: addressedContent, mentionedSessionIds: ['invited-session'] }, context })).toMatchObject({ message: { content: addressedContent } });
        expect(transport.posts[0]?.mentionedSessionIds).toEqual(['invited-session']);
    });

    it.each(['selected invitees', 'Doc audience'] as const)('delivers the independent Discussion key to $0 and newly invited recipients through the fenced shared owner', async audience => {
        const transport = http('e2ee');
        const signingSecret = new Uint8Array(32).fill(11);
        const signingPublic = ed25519.getPublicKey(signingSecret);
        const contentSecret = new Uint8Array(32).fill(12);
        const contentPublic = x25519.getPublicKey(contentSecret);
        const fingerprint = computeContentPublicKeyFingerprint(contentPublic);
        const signature = signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: contentPublic });
        const commits: DiscussionRecipientKeyEnvelopeCommitInputV1[] = [];
        const admitted = ['account-b'];
        const envelopes = new Map<string, string>();
        let loseFirstCommit = true;
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const ownerContentPublicKeyFingerprint = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
            material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }).contentPublicKeyFingerprint;
        const execute = createDiscussionActionAdapter({ scope, encryption, accountMode: 'e2ee',
            ownerContentPublicKeyFingerprint, availability: 'available', request: async (path, init) => {
                if (path.endsWith('/participants/invite')) {
                    admitted.push('account-c');
                    return json({ discussionId: 'discussion-a', ownerAccountId: scope.accountId, access: 'owner', grants: [], changed: true });
                }
                if (path.endsWith('/access/grants') && init?.method === 'PUT') {
                    admitted.push('account-d');
                    return json({ discussionId: 'discussion-a', ownerAccountId: scope.accountId, access: 'owner', grants: [], changed: true });
                }
                if (path.endsWith('/data-key/recipients')) {
                    const envelope = transport.readStored()?.discussion.dataEncryptionKey;
                    return json({ discussionId: 'discussion-a', ownerAccountId: scope.accountId, access: 'owner', encryptionMode: 'e2ee',
                        dataEncryptionKey: envelope, callerDataEncryptionKey: envelope, recipients: admitted.map(recipientAccountId => ({ recipientAccountId,
                            contentKey: { status: 'available', accountSigningPublicKey: bytesToHex(signingPublic),
                                contentPublicKey: encodeBase64(contentPublic), contentPublicKeySignature: encodeBase64(signature) },
                            contentPublicKeyFingerprint: fingerprint, encryptedDataKey: envelopes.get(recipientAccountId) ?? null,
                            recipientContentPublicKeyFingerprint: envelopes.has(recipientAccountId) ? fingerprint : null })) });
                }
                if (path.endsWith('/data-key/envelopes')) {
                    const commit = DiscussionRecipientKeyEnvelopeCommitInputV1Schema.parse(JSON.parse(String(init?.body)));
                    commits.push(commit);
                    for (const row of commit.recipientKeyEnvelopes) envelopes.set(row.recipientAccountId, row.encryptedDataKey);
                    if (loseFirstCommit) { loseFirstCommit = false; throw new TypeError('lost key-delivery response after commit'); }
                    return json({ appliedRecipientAccountIds: commit.recipientKeyEnvelopes.map(row => row.recipientAccountId), skippedRecipientAccountIds: [] });
                }
                return transport.request(path, init);
            } });
        const doc = { ref: { kind: 'doc' as const, artifactId: 'doc-a', serverId: scope.serverId },
            revision: { headerVersion: 1, bodyVersion: 1 } };
        const createInput = audience === 'selected invitees'
            ? { ...input, participants: [{ kind: 'account' as const, accountId: 'account-b' }] }
            : { ...input, anchor: { kind: 'doc' as const, doc }, firstMessage: { ...input.firstMessage,
                content: { kind: 'doc_passage_comment' as const, passage: { ...doc, range: { start: 0, end: 1 }, quote: 'x' }, content },
                replyTarget: { kind: 'doc_passage' as const, doc } } };
        expect(await execute({ actionId: 'discussion.create', input: createInput, context })).toMatchObject({ errorCode: 'outcome_unknown' });
        expect(await execute({ actionId: 'discussion.create', input: createInput, context })).toMatchObject({ discussion: { id: 'discussion-a' } });
        expect(transport.creates[0]?.participants).toEqual(audience === 'selected invitees'
            ? [{ kind: 'account', accountId: 'account-b' }] : undefined);
        expect(transport.creates[1]?.dataEncryptionKey).toBe(transport.creates[0]?.dataEncryptionKey);
        expect(transport.creates[1]?.creationEqualityEvidenceV1).toEqual(transport.creates[0]?.creationEqualityEvidenceV1);
        expect(transport.messages).toHaveLength(1);
        expect(commits).toHaveLength(1);
        expect(commits[0]?.recipientKeyEnvelopes.map(row => row.recipientAccountId)).toEqual(['account-b']);
        expect(await execute({ actionId: 'discussion.invite', input: { discussionId: 'discussion-a',
            participant: { kind: 'account', accountId: 'account-c' } }, context })).toMatchObject({ changed: true });
        expect(commits).toHaveLength(2);
        expect(commits[1]?.expectedDataEncryptionKey).toBe(transport.readStored()?.discussion.dataEncryptionKey);
        const recipientEnvelope = commits[1]!.recipientKeyEnvelopes[0]!;
        expect(recipientEnvelope.recipientAccountId).toBe('account-c');
        expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(recipientEnvelope.encryptedDataKey), recipientSecretKeyOrSeed: contentSecret }))
            .toEqual(await encryption.decryptEncryptionKey(transport.readStored()!.discussion.dataEncryptionKey!, scope));
        expect(await execute({ actionId: 'discussion.access.grants.set', input: { discussionId: 'discussion-a',
            principal: { kind: 'account', accountId: 'account-d' }, accessLevel: 'view' }, context })).toMatchObject({ changed: true });
        expect(commits[2]?.recipientKeyEnvelopes.map(row => row.recipientAccountId)).toEqual(['account-d']);
    });

    it.each([
        { state: 'missing tuple', storedEnvelope: false, storedFingerprint: null, expectedCensusReads: 1, expectedCommits: 1 },
        { state: 'rotated binding', storedEnvelope: true, storedFingerprint: 'stale', expectedCensusReads: 1, expectedCommits: 1 },
        { state: 'current tuple', storedEnvelope: true, storedFingerprint: 'current', expectedCensusReads: 0, expectedCommits: 0 },
    ] as const)('repairs a $state only when a DEK holder opens the Discussion', async testCase => {
        const transport = http('e2ee');
        await (await adapter('e2ee', transport))({ actionId: 'discussion.create', input, context });
        const signingSecret = new Uint8Array(32).fill(21);
        const signingPublic = ed25519.getPublicKey(signingSecret);
        const contentSecret = new Uint8Array(32).fill(22);
        const contentPublic = x25519.getPublicKey(contentSecret);
        const fingerprint = computeContentPublicKeyFingerprint(contentPublic);
        const signature = signAccountContentKeyBindingV1({
            accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: contentPublic,
        });
        let recipientEnvelope: string | null = testCase.storedEnvelope ? transport.readStored()!.discussion.dataEncryptionKey : null;
        let recipientFingerprint: string | null = testCase.storedFingerprint === 'current' ? fingerprint
            : testCase.storedFingerprint === 'stale' ? computeContentPublicKeyFingerprint(x25519.getPublicKey(new Uint8Array(32).fill(23))) : null;
        let censusReads = 0;
        const commits: DiscussionRecipientKeyEnvelopeCommitInputV1[] = [];
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const execute = createDiscussionActionAdapter({ scope, encryption, accountMode: 'e2ee', availability: 'available',
            request: async (path, init) => {
                if (path === '/v1/discussions/discussion-a') {
                    const response = await transport.request(path, init);
                    const payload = await response.json() as { discussion: Record<string, unknown> };
                    return json({ discussion: { ...payload.discussion,
                        recipientKeyPreparationRequired: recipientEnvelope === null || recipientFingerprint !== fingerprint } });
                }
                if (path.endsWith('/data-key/recipients')) {
                    censusReads++;
                    const ownerEnvelope = transport.readStored()!.discussion.dataEncryptionKey;
                    return json({ discussionId: 'discussion-a', ownerAccountId: scope.accountId, access: 'owner', encryptionMode: 'e2ee',
                        dataEncryptionKey: ownerEnvelope, callerDataEncryptionKey: ownerEnvelope, recipients: [{ recipientAccountId: 'account-b',
                            contentKey: { status: 'available', accountSigningPublicKey: bytesToHex(signingPublic),
                                contentPublicKey: encodeBase64(contentPublic), contentPublicKeySignature: encodeBase64(signature) },
                            contentPublicKeyFingerprint: fingerprint, encryptedDataKey: recipientEnvelope,
                            recipientContentPublicKeyFingerprint: recipientFingerprint }] });
                }
                if (path.endsWith('/data-key/envelopes')) {
                    const commit = DiscussionRecipientKeyEnvelopeCommitInputV1Schema.parse(JSON.parse(String(init?.body)));
                    commits.push(commit);
                    recipientEnvelope = commit.recipientKeyEnvelopes[0]!.encryptedDataKey;
                    recipientFingerprint = commit.recipientKeyEnvelopes[0]!.recipientContentPublicKeyFingerprint;
                    return json({ appliedRecipientAccountIds: ['account-b'], skippedRecipientAccountIds: [] });
                }
                return transport.request(path, init);
            } });

        expect(await execute({ actionId: 'discussion.list', input: {}, context })).toMatchObject({ discussions: [{ title: input.title }] });
        expect(censusReads).toBe(0);
        expect(await execute({ actionId: 'discussion.get', input: { discussionId: 'discussion-a' }, context }))
            .toMatchObject({ discussion: { title: input.title } });
        expect(censusReads).toBe(testCase.expectedCensusReads);
        expect(commits).toHaveLength(testCase.expectedCommits);
        if (testCase.expectedCommits === 1) {
            expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(recipientEnvelope!), recipientSecretKeyOrSeed: contentSecret }))
                .toEqual(await encryption.decryptEncryptionKey(transport.readStored()!.discussion.dataEncryptionKey!, scope));
        }
        expect(await execute({ actionId: 'discussion.get', input: { discussionId: 'discussion-a' }, context }))
            .toMatchObject({ discussion: { title: input.title } });
        expect(censusReads).toBe(testCase.expectedCensusReads);
        expect(commits).toHaveLength(testCase.expectedCommits);
    });

    it('keeps participant management key-free and rejects a roster disclosed after caller revocation', async () => {
        const plainTransport = http('plain');
        await (await adapter('plain', plainTransport))({ actionId: 'discussion.create', input, context });
        const roster = DiscussionAccessGrantsListResponseV1Schema.parse({ discussionId: 'discussion-a',
            ownerAccountId: scope.accountId, access: 'owner', grants: [{
                principal: { kind: 'account', accountId: 'account-b' }, accessLevel: 'edit',
                createdByAccountId: scope.accountId, createdAt: 1, display: { name: 'B' },
            }] });
        let revoked = false;
        // Only the Home HTTP boundary is replaced. The Action's binder and all
        // request/result schemas still run, without Account or Session keys.
        const execute = createDiscussionActionAdapter({ scope, encryption: null, availability: 'available',
            request: async (path, init) => {
                if (path === '/v1/discussions/discussion-a') return plainTransport.request(path, init);
                if (path.endsWith('/leave')) return json({ discussionId: 'discussion-a', access: null, changed: true });
                if (init?.method === 'GET') return json(path.endsWith('/participants') ? { ...roster, participants: [] } : roster);
                return json({ ...roster, access: revoked ? null : roster.access, changed: true });
            } });
        expect(await execute({ actionId: 'discussion.participants.list', input: { discussionId: 'discussion-a' }, context })).toEqual({ ...roster, participants: [] });
        expect(await execute({ actionId: 'discussion.invite', input: { discussionId: 'discussion-a',
            participant: { kind: 'account', accountId: 'account-b' } }, context })).toMatchObject({ grants: roster.grants, changed: true });
        expect(await execute({ actionId: 'discussion.leave', input: { discussionId: 'discussion-a' }, context }))
            .toEqual({ discussionId: 'discussion-a', access: null, changed: true });
        revoked = true;
        const refused = await execute({ actionId: 'discussion.access.grants.remove', input: { discussionId: 'discussion-a',
            principal: { kind: 'account', accountId: scope.accountId } }, context });
        expect(refused).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
        expect(refused).not.toHaveProperty('grants');
    });

    it('keeps authorized grant mutations successful when the caller cannot open its current resource envelope', async () => {
        const transport = http('e2ee');
        await (await adapter('e2ee', transport))({ actionId: 'discussion.create', input, context });
        const stored = transport.readStored()!;
        const admitted = new Set<string>();
        const censusRecipients: string[][] = [];
        const envelopeCommits: unknown[] = [];
        let censusRefused = false;
        const roster = () => DiscussionAccessGrantsListResponseV1Schema.parse({ discussionId: 'discussion-a',
            ownerAccountId: scope.accountId, access: 'owner', grants: [...admitted].map(accountId => ({
                principal: { kind: 'account', accountId }, accessLevel: 'edit', createdByAccountId: scope.accountId,
                createdAt: 1, display: { name: null },
            })) });
        // The server has a current caller envelope; this device cannot open it.
        // Management remains server-authorized independently of local content material.
        const execute = createDiscussionActionAdapter({ scope, encryption: null, availability: 'available',
            request: async (path, init) => {
                if (path.endsWith('/participants/invite')) {
                    admitted.add('account-b');
                    return json({ ...roster(), changed: true });
                }
                if (path.endsWith('/access/grants') && init?.method === 'PUT') {
                    admitted.add('account-c');
                    return json({ ...roster(), changed: true });
                }
                if (path.endsWith('/data-key/recipients')) {
                    if (censusRefused) return json({ error: 'recipient_key_unavailable' }, 403);
                    censusRecipients.push([...admitted]);
                    return json({ discussionId: 'discussion-a', ownerAccountId: scope.accountId, access: 'owner', encryptionMode: 'e2ee',
                        dataEncryptionKey: stored.discussion.dataEncryptionKey, callerDataEncryptionKey: stored.discussion.dataEncryptionKey,
                        recipients: [...admitted].map(recipientAccountId => ({ recipientAccountId,
                            contentKey: { status: 'unavailable', reason: 'encryption_setup_required' }, contentPublicKeyFingerprint: null,
                            encryptedDataKey: null, recipientContentPublicKeyFingerprint: null })) });
                }
                if (path.endsWith('/data-key/envelopes')) {
                    envelopeCommits.push(JSON.parse(String(init?.body)));
                    return json({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] });
                }
                return transport.request(path, init);
            } });
        expect(await execute({ actionId: 'discussion.invite', input: { discussionId: 'discussion-a',
            participant: { kind: 'account', accountId: 'account-b' } }, context })).toMatchObject({ changed: true, grants: roster().grants });
        expect(await execute({ actionId: 'discussion.access.grants.set', input: { discussionId: 'discussion-a',
            principal: { kind: 'account', accountId: 'account-c' }, accessLevel: 'edit' }, context })).toMatchObject({ changed: true });
        expect(admitted).toEqual(new Set(['account-b', 'account-c']));
        expect(censusRecipients).toEqual([['account-b'], ['account-b', 'account-c']]);
        expect(envelopeCommits).toEqual([]);
        expect(await execute({ actionId: 'discussion.get', input: { discussionId: 'discussion-a' }, context }))
            .toMatchObject({ discussion: { title: null } });
        expect(await execute({ actionId: 'discussion.post', input: { discussionId: 'discussion-a', localId: 'unavailable-key-post', content }, context }))
            .toMatchObject({ errorCode: 'discussion_encryption_mode_mismatch' });
        expect(transport.posts).toEqual([]);
        // A server refusal is not the local-material no-op and must stay uncertain.
        censusRefused = true;
        expect(await execute({ actionId: 'discussion.invite', input: { discussionId: 'discussion-a',
            participant: { kind: 'account', accountId: 'account-b' } }, context })).toMatchObject({ errorCode: 'outcome_unknown' });
    });

    it('creates in the captured Home without Session input or hydration', async () => {
        const transport = http('plain');
        const execute = await adapter('plain', transport);
        const result = await execute({ actionId: 'discussion.create', input, context });
        expect(result).toMatchObject({ discussion: { id: 'discussion-a', title: input.title }, firstMessage: { content } });
        expect(transport.creates[0]).not.toHaveProperty('sessionId');
        expect(transport.creates[0]).not.toHaveProperty('dataEncryptionKey');
        expect(transport.creates[0]?.creationLocalId).not.toBe(transport.creates[0]?.firstMessage.localId);
    });

    it('recovers the original independent key after a lost create response, then retries a lost post with its own ID', async () => {
        const transport = http('e2ee', true, true);
        const first = await adapter('e2ee', transport);
        expect(await first({ actionId: 'discussion.create', input, context })).toMatchObject({ errorCode: 'outcome_unknown' });
        const second = await adapter('e2ee', transport);
        const created = await second({ actionId: 'discussion.create', input, context });
        expect(created).toMatchObject({ discussion: { id: 'discussion-a', title: input.title }, firstMessage: { content } });
        expect(transport.creates[1]?.dataEncryptionKey).toBe(transport.creates[0]?.dataEncryptionKey);
        expect(transport.creates[1]?.creationEqualityEvidenceV1).toEqual(transport.creates[0]?.creationEqualityEvidenceV1);
        expect(transport.creates[1]?.firstMessage.requestEqualityEvidenceV1).toEqual(transport.creates[0]?.firstMessage.requestEqualityEvidenceV1);
        expect(transport.creates[1]?.firstMessage.content).not.toEqual(transport.creates[0]?.firstMessage.content);
        const post = { discussionId: 'discussion-a', localId: 'separate-post-id', content };
        expect(await second({ actionId: 'discussion.post', input: post, context })).toMatchObject({ errorCode: 'outcome_unknown' });
        const posted = DiscussionPostResultV1Schema.parse(await second({ actionId: 'discussion.post', input: post, context }));
        expect(posted.message.content).toEqual(content);
        expect(transport.messages).toHaveLength(2);
        expect(CoordinationMessageRefV1Schema.parse(posted.message.messageRef)).toEqual({ kind: 'discussion',
            discussion: { serverId: scope.serverId, discussionId: 'discussion-a' }, messageId: posted.message.id });
    });

    it('opens retained content fields while malformed known fields stay unavailable', async () => {
        const transport = http('plain');
        const execute = await adapter('plain', transport);
        await execute({ actionId: 'discussion.create', input, context });
        const stored = transport.readStored()!;
        transport.replaceStored({ ...stored, discussion: { ...stored.discussion,
            titleContent: { t: 'plain', v: { v: 1, title: 'Retained', retired: true } } } });
        expect(await execute({ actionId: 'discussion.get', input: { discussionId: 'discussion-a' }, context }))
            .toMatchObject({ discussion: { title: 'Retained' } });
        transport.replaceStored({ ...stored, discussion: { ...stored.discussion,
            titleContent: { t: 'plain', v: { v: 1, title: 42 } } } });
        expect(await execute({ actionId: 'discussion.get', input: { discussionId: 'discussion-a' }, context }))
            .toMatchObject({ discussion: { title: null } });
    });

    it('fails closed on a resource mode/envelope mismatch and never writes with an unavailable key', async () => {
        const transport = http('plain');
        const execute = await adapter('plain', transport);
        await execute({ actionId: 'discussion.create', input, context });
        const stored = transport.readStored()!;
        transport.replaceStored({ ...stored, discussion: { ...stored.discussion, encryptionMode: 'e2ee', dataEncryptionKey: null } });
        expect(await execute({ actionId: 'discussion.get', input: { discussionId: 'discussion-a' }, context }))
            .toMatchObject({ discussion: { title: null } });
        expect(await execute({ actionId: 'discussion.post', input: { discussionId: 'discussion-a', localId: 'post', content }, context }))
            .toMatchObject({ errorCode: 'discussion_encryption_mode_mismatch' });
        expect(await execute({ actionId: 'discussion.rename', input: { discussionId: 'discussion-a', title: 'Must not mutate' }, context }))
            .toMatchObject({ errorCode: 'discussion_encryption_mode_mismatch' });
        expect(transport.messages).toHaveLength(1);
    });

    it('qualifies the same raw committed ID by Home and refuses a changed execution Home', async () => {
        const first = await adapter('plain', http('plain'));
        const second = await adapter('plain', http('plain'), 'home-b');
        const a = await first({ actionId: 'discussion.create', input, context });
        const b = await second({ actionId: 'discussion.create', input, context: { ...context, serverId: 'home-b' } });
        expect(a).toMatchObject({ firstMessage: { messageRef: { discussion: { serverId: 'home-a', discussionId: 'discussion-a' } } } });
        expect(b).toMatchObject({ firstMessage: { messageRef: { discussion: { serverId: 'home-b', discussionId: 'discussion-a' } } } });
        expect(await second({ actionId: 'discussion.create', input, context })).toMatchObject({ errorCode: 'discussion_not_found' });
    });
});
