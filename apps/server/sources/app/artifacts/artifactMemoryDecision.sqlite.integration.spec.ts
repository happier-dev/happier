import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { SessionMessageRefV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { auth } from '@/app/auth/auth';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { artifactUpdateHandler } from '@/app/api/socket/artifactUpdateHandler';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { inTx } from '@/storage/inTx';
import { createArtifactTx } from './artifactWriteService';
import { createSessionMessageFromPending } from '@/app/session/pending/pendingMessageTranscriptCommit';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant, removeDiscussionParticipant } from '@/app/discussions/accessService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { DiscussionMessageRefV1Schema } from '@happier-dev/protocol/discussions/messageRefs';
import { createArtifactHttpMutation, updateArtifactHttpMutation } from './artifactMutationHttpResponse';
import { z } from 'zod';
import type { Fastify } from '@/app/api/types';

const plain = encodePlainArtifactStoredContent;
const protocolHeaders = { 'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };
const memoryDecisionCreateUrl = '/v1/artifacts/memory-decision/create';

describe('Memory decision source disclosure at the Artifact HTTP boundary', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-memory-decision-', initEncrypt: true, initAuth: true });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function source(accountId: string) {
        const session = await db.session.create({ data: { accountId, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', seq: 1 } });
        const message = await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, localId: randomUUID(),
            messageRole: 'agent', content: { t: 'plain', v: { text: 'Use the approved design' } } } });
        return { session, message, ref: SessionMessageRefV1Schema.parse({ kind: 'session', session: { serverId: 'test-home', sessionId: message.sessionId }, messageId: message.id }) };
    }

    async function artifact(accountId: string) {
        return db.artifact.create({ data: { id: randomUUID(), accountId, header: privacyKit.decodeBase64(plain({ kind: 'memory_doc.v1' })),
            body: privacyKit.decodeBase64(plain({ body: 'original' })), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1 } });
    }

    it('allows a committed readable source after Pending retirement when lazily creating private memory', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const pending = await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId: randomUUID(), position: 0,
            content: { t: 'plain', v: { text: 'Use the approved design' } }, requestedAction: { v: 1, kind: 'enqueue' } } });
        const committed = await inTx(async tx => {
            const result = await createSessionMessageFromPending(tx, { sessionId: session.id, sessionEncryptionMode: 'plain', storagePolicy: 'optional',
                localId: pending.localId, content: pending.content, messageRole: 'user', pendingRequestedAction: pending.requestedAction });
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error('Expected a committed source message');
            await tx.sessionPendingMessage.delete({ where: { id: pending.id } });
            return result.message;
        });
        const memoryDecisionSource = SessionMessageRefV1Schema.parse({ kind: 'session', session: { serverId: 'test-home', sessionId: session.id }, messageId: committed.id });
        expect(await db.sessionPendingMessage.findUnique({ where: { id: pending.id } })).toBeNull();
        const id = randomUUID();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: memoryDecisionCreateUrl, headers: { ...protocolHeaders, 'x-test-user-id': owner.id },
                payload: { id, header: plain({ kind: 'memory_doc.v1' }), body: plain({ body: 'decision' }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, memoryDecisionSource } });
            expect(response.statusCode, response.body).toBe(200);
            expect(await db.artifact.findUnique({ where: { id }, select: { bodyVersion: true } })).toEqual({ bodyVersion: 1 });
        });
    });

    it('rejects a wrong committed message and a revoked source before lazy creation', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const writer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const original = await source(owner.id);
        const other = await source(owner.id);
        const grant = await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: original.session.id, createdByAccountId: owner.id,
            accountId: writer.id, accessLevel: 'view' } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            for (const ref of [{ ...original.ref, messageId: other.message.id }, original.ref]) {
                if (ref.messageId === original.ref.messageId) await db.sessionGrant.delete({ where: { principalKind: 'account', id: grant.id } });
                const id = randomUUID();
                const response = await app.inject({ method: 'POST', url: memoryDecisionCreateUrl, headers: { ...protocolHeaders, 'x-test-user-id': writer.id },
                    payload: { id, header: plain({ kind: 'memory_doc.v1' }), body: plain({ body: 'decision' }),
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, memoryDecisionSource: ref } });
                expect(response.statusCode, response.body).toBe(404);
                expect(response.json()).toEqual({ error: 'memory_decision_source_unavailable' });
                expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
            }
        });
    });

    it('denies broader and public memory audiences before mutation, then permits the same current audience', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const original = await source(owner.id);
        const memory = await artifact(owner.id);
        await db.artifactAccountGrant.create({ data: { artifactId: memory.id, accountId: reader.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const write = () => app.inject({ method: 'POST', url: `/v1/artifacts/${memory.id}/memory-decision`, headers: { ...protocolHeaders, 'x-test-user-id': owner.id },
                payload: { body: plain({ body: 'decision' }), expectedBodyVersion: 1, memoryDecisionSource: original.ref } });
            const denied = await write();
            expect(denied.statusCode, denied.body).toBe(403);
            expect(denied.json()).toEqual({ error: 'memory_decision_disclosure_denied' });
            expect(await db.artifact.findUnique({ where: { id: memory.id }, select: { bodyVersion: true } })).toEqual({ bodyVersion: 1 });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: original.session.id, createdByAccountId: owner.id, accountId: reader.id, accessLevel: 'view' } });
            const publication = await db.publicSessionShare.create({ data: { artifactId: memory.id,
                tokenHash: randomBytes(32), createdByUserId: owner.id } });
            const publicDenied = await write();
            expect(publicDenied.statusCode, publicDenied.body).toBe(403);
            expect(publicDenied.json()).toEqual({ error: 'memory_decision_disclosure_denied' });
            expect(await db.artifact.findUnique({ where: { id: memory.id }, select: { bodyVersion: true } })).toEqual({ bodyVersion: 1 });
            await db.publicSessionShare.delete({ where: { id: publication.id } });
            const saved = await write();
            expect(saved.statusCode, saved.body).toBe(200);
            expect(saved.json()).toMatchObject({ success: true, bodyVersion: 2 });
        });
    });

    it('saves exact Discussion sources and denies wrong, revoked and broader-audience sources without writes', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const authentication = createPresentUserSessionAccessAuthentication();
        const docOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sourceDoc = await inTx(tx => createArtifactTx(tx, { actorUserId: docOwner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(plain({ kind: 'markdown', title: 'Source design' })),
            body: privacyKit.decodeBase64(plain({ body: 'Use the approved design' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) }));
        if (!sourceDoc.ok) throw new Error(sourceDoc.error);
        const doc = { ref: { kind: 'doc' as const, serverId: 'test-home', artifactId: sourceDoc.artifact.id },
            revision: { headerVersion: sourceDoc.artifact.headerVersion, bodyVersion: sourceDoc.artifact.bodyVersion } };
        for (const accountId of [owner.id, reader.id]) await db.artifactAccountGrant.create({ data: {
            artifactId: doc.ref.artifactId, accountId, accessLevel: 'view', createdByAccountId: docOwner.id,
        } });
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Design decision' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { kind: 'doc_passage_comment',
                passage: { ...doc, range: { start: 0, end: 23 }, quote: 'Use the approved design', prefix: '', suffix: '' },
                content: { v: 1, parts: [{ t: 'text', text: 'Save this design decision' }] },
            } }, mentionedAccountIds: [], replyTarget: { kind: 'doc_passage', doc } },
        } });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        const other = await createDiscussion({ actorAccountId: owner.id, authentication, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Another decision' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'A different source' }] } }, mentionedAccountIds: [] },
        } });
        if (!other.ok) throw new Error(other.error);
        const discussionId = created.value.discussion.id;
        const memoryDecisionSource = DiscussionMessageRefV1Schema.parse({ kind: 'discussion',
            discussion: { serverId: 'test-home', discussionId }, messageId: created.value.firstMessage.id });
        const reply = await postDiscussionMessage({ actorAccountId: owner.id, discussionId, authentication, request: {
            localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Keep this design for the rollout' }] } },
            mentionedAccountIds: [], replyTarget: { kind: 'message', messageId: created.value.firstMessage.id },
        } });
        expect(reply.ok).toBe(true);
        if (!reply.ok) throw new Error(reply.error);
        const inheritedSource = DiscussionMessageRefV1Schema.parse({ ...memoryDecisionSource, messageId: reply.value.message.id });
        const memory = await artifact(owner.id);
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const id = randomUUID();
            const create = (actorAccountId: string, ref = memoryDecisionSource, artifactId = id) => app.inject({ method: 'POST', url: memoryDecisionCreateUrl,
                headers: { ...protocolHeaders, 'x-test-user-id': actorAccountId }, payload: { id: artifactId,
                    header: plain({ kind: 'memory_doc.v1' }), body: plain({ body: 'decision' }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, memoryDecisionSource: ref } });
            const wrong = await create(owner.id, { ...memoryDecisionSource, messageId: other.value.firstMessage.id });
            expect(wrong.statusCode, wrong.body).toBe(404);
            expect(wrong.json()).toEqual({ error: 'memory_decision_source_unavailable' });
            expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
            const saved = await create(owner.id);
            expect(saved.statusCode, saved.body).toBe(200);
            expect(await db.artifact.findUnique({ where: { id }, select: { bodyVersion: true } })).toEqual({ bodyVersion: 1 });
            const unanchoredId = randomUUID();
            const unanchored = await create(owner.id, { ...memoryDecisionSource,
                discussion: { ...memoryDecisionSource.discussion, discussionId: other.value.discussion.id }, messageId: other.value.firstMessage.id }, unanchoredId);
            expect(unanchored.statusCode, unanchored.body).toBe(200);
            expect(await db.artifact.findUnique({ where: { id: unanchoredId }, select: { bodyVersion: true } })).toEqual({ bodyVersion: 1 });

            await db.artifactAccountGrant.create({ data: { artifactId: memory.id, accountId: reader.id, accessLevel: 'edit', createdByAccountId: owner.id } });
            const update = (actorAccountId: string, ref = memoryDecisionSource, expectedBodyVersion = 1) => app.inject({ method: 'POST', url: `/v1/artifacts/${memory.id}/memory-decision`,
                headers: { ...protocolHeaders, 'x-test-user-id': actorAccountId },
                payload: { body: plain({ body: 'decision' }), expectedBodyVersion, memoryDecisionSource: ref } });
            const broader = await update(owner.id);
            expect(broader.statusCode, broader.body).toBe(403);
            expect(broader.json()).toEqual({ error: 'memory_decision_disclosure_denied' });
            expect(await db.artifact.findUnique({ where: { id: memory.id }, select: { bodyVersion: true } })).toEqual({ bodyVersion: 1 });
            expect(await inviteDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
                request: { participant: { kind: 'account', accountId: reader.id } } })).toMatchObject({ ok: true });
            // The saver still reads the Doc; only the other Memory/Discussion member loses its source grant.
            await db.artifactAccountGrant.delete({ where: { artifactId_accountId: { artifactId: doc.ref.artifactId, accountId: reader.id } } });
            const beforeDenied = await db.artifact.findUniqueOrThrow({ where: { id: memory.id } });
            for (const ref of [memoryDecisionSource, inheritedSource]) {
                const docDenied = await update(owner.id, ref);
                expect(docDenied.statusCode, docDenied.body).toBe(403);
                expect(docDenied.json()).toEqual({ error: 'memory_decision_disclosure_denied' });
                expect(await db.artifact.findUniqueOrThrow({ where: { id: memory.id } })).toEqual(beforeDenied);
            }
            await db.artifactAccountGrant.create({ data: { artifactId: doc.ref.artifactId, accountId: reader.id,
                accessLevel: 'view', createdByAccountId: docOwner.id } });
            const shared = await update(reader.id);
            expect(shared.statusCode, shared.body).toBe(200);
            expect(await db.artifact.findUnique({ where: { id: memory.id }, select: { bodyVersion: true } })).toEqual({ bodyVersion: 2 });
            const inherited = await update(owner.id, inheritedSource, 2);
            expect(inherited.statusCode, inherited.body).toBe(200);
            expect(await db.artifact.findUnique({ where: { id: memory.id }, select: { bodyVersion: true } })).toEqual({ bodyVersion: 3 });
            await db.artifactAccountGrant.delete({ where: { artifactId_accountId: { artifactId: doc.ref.artifactId, accountId: owner.id } } });
            const sourceRevokedId = randomUUID();
            const sourceRevoked = await app.inject({ method: 'POST', url: memoryDecisionCreateUrl,
                headers: { ...protocolHeaders, 'x-test-user-id': owner.id }, payload: { id: sourceRevokedId,
                    header: plain({ kind: 'memory_doc.v1' }), body: plain({ body: 'decision' }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, memoryDecisionSource } });
            expect(sourceRevoked.statusCode, sourceRevoked.body).toBe(404);
            expect(sourceRevoked.json()).toEqual({ error: 'memory_decision_source_unavailable' });
            expect(await db.artifact.findUnique({ where: { id: sourceRevokedId } })).toBeNull();
            expect(await removeDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
                request: { participant: { kind: 'account', accountId: reader.id } } })).toMatchObject({ ok: true });
            const revokedId = randomUUID();
            const revoked = await app.inject({ method: 'POST', url: memoryDecisionCreateUrl,
                headers: { ...protocolHeaders, 'x-test-user-id': reader.id }, payload: { id: revokedId,
                    header: plain({ kind: 'memory_doc.v1' }), body: plain({ body: 'decision' }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, memoryDecisionSource } });
            expect(revoked.statusCode, revoked.body).toBe(404);
            expect(revoked.json()).toEqual({ error: 'memory_decision_source_unavailable' });
            expect(await db.artifact.findUnique({ where: { id: revokedId } })).toBeNull();
        });
    });

    it('preserves encrypted Artifact bodies as opaque while authorizing their separate source metadata', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const original = await source(owner.id);
        const id = randomUUID();
        const header = privacyKit.encodeBase64(new TextEncoder().encode('opaque-header'));
        const body = privacyKit.encodeBase64(new TextEncoder().encode('opaque-decision-body'));
        const dataEncryptionKey = privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
            recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes })));
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: memoryDecisionCreateUrl, headers: { ...protocolHeaders, 'x-test-user-id': owner.id },
                payload: { id, header, body, dataEncryptionKey, memoryDecisionSource: original.ref } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ header, body, encryptionMode: 'e2ee' });
        });
    });

    it('refuses source-bearing saves on the ordinary socket writer without changing ordinary Artifact editing', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const original = await source(owner.id);
        const memory = await artifact(owner.id);
        await db.artifactAccountGrant.create({ data: { artifactId: memory.id, accountId: reader.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const socket = Object.assign(createAuthenticatedFakeSocket(), { handshake: { auth: { token } }, disconnect: vi.fn() });
        artifactUpdateHandler(owner.id, socket as unknown as Socket);
        const payload = { artifactId: memory.id, body: { data: plain({ body: 'decision' }), expectedVersion: 1 }, memoryDecisionSource: original.ref };
        const denied = vi.fn();
        await getSocketHandler(socket, 'artifact-update')(payload, denied);
        expect(denied).toHaveBeenCalledWith({ result: 'error', error: 'memory_decision_source_unsupported' });
        expect(await db.artifact.findUnique({ where: { id: memory.id }, select: { bodyVersion: true } })).toEqual({ bodyVersion: 1 });
        const saved = vi.fn();
        await getSocketHandler(socket, 'artifact-update')({ artifactId: payload.artifactId, body: payload.body }, saved);
        expect(saved).toHaveBeenCalledWith(expect.objectContaining({ result: 'success', body: { data: payload.body.data, version: 2 } }));
    });

    it('preserves existing HTTP denial of restricted credentials before the Artifact writer', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const original = await source(owner.id);
        const id = randomUUID();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: memoryDecisionCreateUrl, headers: { ...protocolHeaders,
                'x-test-user-id': owner.id, 'x-test-auth-token-kind': 'api_token' },
                payload: { id, header: plain({ kind: 'memory_doc.v1' }), body: plain({ body: 'decision' }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, memoryDecisionSource: original.ref } });
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: 'present_user_required' });
            expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
        });
    });

    it('does not let an admitted Artifact effect borrow Account-wide source read authority', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const original = await source(owner.id);
        const other = await source(owner.id);
        const id = randomUUID();
        const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [other.session.id], machines: [] } });
        const result = await inTx(tx => createArtifactTx(tx, { actorUserId: owner.id, artifactId: id,
            header: privacyKit.decodeBase64(plain({ kind: 'memory_doc.v1' })), body: privacyKit.decodeBase64(plain({ body: 'decision' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), memoryDecisionSource: original.ref,
            authentication: { env: process.env, authority: 'account_automation', authenticationEvidence: undefined, apiTokenGrant: grant } }));
        expect(result).toEqual({ ok: false, error: 'memory_decision_source_unavailable' });
        expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
        const allowed = await inTx(tx => createArtifactTx(tx, { actorUserId: owner.id, artifactId: id,
            header: privacyKit.decodeBase64(plain({ kind: 'memory_doc.v1' })), body: privacyKit.decodeBase64(plain({ body: 'decision' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), memoryDecisionSource: original.ref,
            authentication: { env: process.env, authority: 'account_automation', authenticationEvidence: undefined,
                apiTokenGrant: ApiTokenGrantV1Schema.parse({ ...grant, targets: { sessions: [original.session.id], machines: [] } }) } }));
        expect(allowed).toMatchObject({ ok: true, didWrite: true });
    });

    it('requires a source on decision operations and refuses source markers on ordinary HTTP writes', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const original = await source(owner.id);
        const memory = await artifact(owner.id);
        const id = randomUUID();
        const create = { id, header: plain({ kind: 'memory_doc.v1' }), body: plain({ body: 'decision' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
        const update = { body: plain({ body: 'decision' }), expectedBodyVersion: 1 };
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { ...protocolHeaders, 'x-test-user-id': owner.id };
            for (const request of [
                { url: memoryDecisionCreateUrl, payload: create },
                { url: `/v1/artifacts/${memory.id}/memory-decision`, payload: update },
                { url: '/v1/artifacts', payload: { ...create, memoryDecisionSource: original.ref } },
                { url: `/v1/artifacts/${memory.id}`, payload: { ...update, memoryDecisionSource: original.ref } },
            ]) {
                const response = await app.inject({ method: 'POST', headers, ...request });
                expect(response.statusCode, response.body).toBe(400);
                expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
                expect(await db.artifact.findUnique({ where: { id: memory.id }, select: { bodyVersion: true } })).toEqual({ bodyVersion: 1 });
            }
            const ordinary = await app.inject({ method: 'POST', url: `/v1/artifacts/${memory.id}`, headers, payload: update });
            expect(ordinary.statusCode, ordinary.body).toBe(200);
            expect(ordinary.json()).toMatchObject({ success: true, bodyVersion: 2 });
        });
    });

    it('cannot fall through to older Home generic writes when the source-bearing operations are absent', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const original = await source(owner.id);
        const memory = await artifact(owner.id);
        const id = randomUUID();
        // Bounded legacy transport fixture: server-v0.2.16[-preview.1],
        // 22ac8263cfdbcdb845441b9044ff18199cf7652e, artifactsRoutes.ts create/update.
        // Keep the dynamic update route and its stripping schemas: a shallow
        // source-create path would otherwise match :id and lose its source marker.
        await withAuthenticatedTestApp((app: Fastify) => {
            app.post('/v1/artifacts', { preHandler: app.authenticate, schema: { body: z.object({
                id: z.string().uuid(), header: z.string(), body: z.string(), dataEncryptionKey: z.string(),
            }) } }, async (request, reply) => {
                const result = await createArtifactHttpMutation(request.userId, request.body);
                return reply.code(result.statusCode).send(result.body);
            });
            app.post('/v1/artifacts/:id', { preHandler: app.authenticate, schema: {
                params: z.object({ id: z.string() }), body: z.object({ header: z.string().optional(), expectedHeaderVersion: z.number().int().min(0).optional(),
                    body: z.string().optional(), expectedBodyVersion: z.number().int().min(0).optional() }),
            } }, async (request, reply) => {
                const result = await updateArtifactHttpMutation(request.userId, request.params.id, request.body);
                return reply.code(result.statusCode).send(result.body);
            });
        }, async app => {
            const headers = { ...protocolHeaders, 'x-test-user-id': owner.id };
            const create = await app.inject({ method: 'POST', url: memoryDecisionCreateUrl, headers,
                payload: { id, header: plain({ kind: 'memory_doc.v1' }), body: plain({ body: 'decision' }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, memoryDecisionSource: original.ref } });
            const update = await app.inject({ method: 'POST', url: `/v1/artifacts/${memory.id}/memory-decision`, headers,
                payload: { body: plain({ body: 'decision' }), expectedBodyVersion: 1, memoryDecisionSource: original.ref } });
            expect(create.statusCode, create.body).toBe(404);
            expect(update.statusCode, update.body).toBe(404);
            expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
            expect(await db.artifact.findUnique({ where: { id: memory.id }, select: { bodyVersion: true } })).toEqual({ bodyVersion: 1 });
            // Control: this is a live legacy writer, including its unsafe
            // stripping of a source marker. Absence above is the protection.
            const generic = await app.inject({ method: 'POST', url: `/v1/artifacts/${memory.id}`, headers,
                payload: { body: plain({ body: 'legacy generic control' }), expectedBodyVersion: 1,
                    memoryDecisionSource: { ...original.ref, messageId: randomUUID() } } });
            expect(generic.statusCode, generic.body).toBe(200);
            expect(generic.json()).toMatchObject({ success: true, bodyVersion: 2 });
        });
    });
});
