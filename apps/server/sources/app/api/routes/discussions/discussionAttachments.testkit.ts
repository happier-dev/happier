import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { registerDiscussionRoutes } from './registerDiscussionRoutes';
import * as privateFiles from '@/storage/blob/files';
import tweetnacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'privacy-kit';
import { sealAesGcmPayloadWebCrypto, openAesGcmPayloadWebCrypto, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto';
import { frameSessionDataKeyBundleV0, readSessionDataKeyBundleV0 } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { DiscussionMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { signDiscussionAttachmentAgentUploadV1, DiscussionAttachmentUploadRequestV1Schema, type DiscussionAttachmentUploadRequestV1 } from '@happier-dev/protocol/discussions/attachmentsUpload';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

export function createAttachmentApp(actorAccountId: () => string, options?: Readonly<{
    authenticate?: (request: FastifyRequest) => void;
    resolveCurrentSessionMachine?: (input: Readonly<{ accountId: string; sessionId: string }>) => Promise<string | null>;
}>) {
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: FastifyRequest) => {
        request.userId = actorAccountId();
        request.authAuthority = 'present_user';
        request.authTokenKind = 'account';
        options?.authenticate?.(request);
    });
    if (options?.resolveCurrentSessionMachine) app.decorate('resolveCurrentSessionMachine', options.resolveCurrentSessionMachine);
    const keys = ['HAPPIER_FEATURE_SESSIONS__ENABLED', 'HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED'] as const;
    const saved = keys.map(key => process.env[key]);
    for (const key of keys) process.env[key] = '1';
    registerDiscussionRoutes(app);
    return { app, restoreEnvironment: () => keys.forEach((key, index) => {
        const value = saved[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }) };
}

/** Identical storage/HTTP contracts run against both admitted disposable providers. */
export function discussionAttachmentContracts(): void {
    it.each(['account', 'terminal'] as const)('streams signed agent create, post and reply with Machine custody admitted once per upload (%s)', async credentialKind => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const signing = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'agent-upload-host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: randomUUID(), installationPublicKey: new Uint8Array(signing.publicKey) } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const homeId = await getOrCreateServerIdentityId();
        let tokenKind: FastifyRequest['authTokenKind'] = credentialKind;
        let externalAction = false;
        let actorAccountId = owner.id;
        let liveMachine: string | null = machine.id;
        const { app, restoreEnvironment } = createAttachmentApp(() => actorAccountId, {
            authenticate: request => {
                request.authTokenKind = tokenKind;
                request.authAuthority = 'account_automation';
                if (externalAction) {
                    request.externalActionExecutionAuthorized = true;
                    request.externalActionInputConstraints = { models: null, permissionModes: null };
                }
            },
            resolveCurrentSessionMachine: async () => liveMachine,
        });
        const bytes = new TextEncoder().encode('agent workspace attachment bytes');
        const message = () => {
            const blobId = randomUUID();
            return { localId: randomUUID(), mentionedAccountIds: [], attachments: [{ blobId, t: 'plain' as const }],
                content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'attachment', attachment: {
                    kind: 'file', id: blobId, name: 'agent.txt', file: { blobId, mime: 'text/plain', sizeBytes: bytes.length,
                        sha256: createHash('sha256').update(bytes).digest('hex') },
                } }] } } };
        };
        const signed = (metadata: Parameters<typeof signDiscussionAttachmentAgentUploadV1>[0]['metadata'], signedHomeId = homeId, signingKey = signing.secretKey) => {
            if (metadata.operation === 'encryption-conversion' || !metadata.agent) throw new Error('Expected agent publication');
            const signature = signDiscussionAttachmentAgentUploadV1({ homeId: signedHomeId,
                accountId: owner.id, metadata, privateKey: signingKey });
            return DiscussionAttachmentUploadRequestV1Schema.parse({ ...metadata, agent: { ...metadata.agent, signature } });
        };
        const upload = (metadata: DiscussionAttachmentUploadRequestV1) => app.inject({ method: 'POST', url: '/v1/discussions/upload',
            headers: { 'content-type': 'application/vnd.happier.discussion-upload-v1' },
            payload: Buffer.concat([Buffer.from(`${JSON.stringify(metadata)}\n`), bytes]) });
        const firstMessage = message();
        const input = { creationLocalId: randomUUID(), titleContent: { t: 'plain' as const, v: { v: 1, title: 'Agent files' } },
            participants: [{ kind: 'session' as const, sessionId: session.id }], firstMessage };
        const create: DiscussionAttachmentUploadRequestV1 = { operation: 'create', input,
            attachments: [{ ...firstMessage.attachments[0]!, storedSizeBytes: bytes.length }],
            agent: { machineId: machine.id, installationId: machine.installationId!, signature: '',
                publication: { v: 1, operation: 'create', sessionId: session.id, toolCallId: 'agent-create' } } };
        const originalWrite = privateFiles.writePrivateFile;
        const writes = vi.spyOn(privateFiles, 'writePrivateFile');
        try {
            // APPR-S3 admits ordinary Account/terminal operations through the
            // Action owner; a scoped credential still cannot use this route.
            tokenKind = 'api_token';
            expect((await upload({ operation: 'create', input, attachments: create.attachments })).statusCode).toBe(403);
            tokenKind = credentialKind;
            expect((await upload(signed(structuredClone(create), 'srv_other-home'))).statusCode).toBe(403);
            actorAccountId = outsider.id;
            expect((await upload(signed(create))).statusCode).toBe(403);
            actorAccountId = owner.id;
            for (const deniedKind of ['api_token', 'ephemeral_session_runner', 'account_directory', undefined] as const) {
                tokenKind = deniedKind;
                expect((await upload(signed(create))).statusCode).toBe(403);
            }
            tokenKind = credentialKind;
            // Terminal credentials identify an Account; the signed carrier must
            // independently prove custody of this exact Session and Machine.
            const otherSigning = tweetnacl.sign.keyPair();
            const otherMachine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
                metadata: machine.metadata, dataEncryptionKey: machine.dataEncryptionKey,
                installationId: randomUUID(), installationPublicKey: new Uint8Array(otherSigning.publicKey) } });
            const otherCarrier = structuredClone(create);
            if (!otherCarrier.agent) throw new Error('Expected agent publication');
            otherCarrier.agent.machineId = otherMachine.id;
            otherCarrier.agent.installationId = otherMachine.installationId!;
            expect((await upload(signed(otherCarrier, homeId, otherSigning.secretKey))).statusCode).toBe(403);
            expect((await upload(signed(create, homeId, otherSigning.secretKey))).statusCode).toBe(403);
            for (const withdrawal of [
                { revokedAt: new Date() },
                { replacedByMachineId: otherMachine.id },
                { kind: 'ephemeral_session_runner' as const },
            ]) {
                await db.machine.update({ where: { id: machine.id }, data: withdrawal });
                expect((await upload(signed(create))).statusCode).toBe(403);
                await db.machine.update({ where: { id: machine.id }, data: {
                    revokedAt: null, replacedByMachineId: null, kind: machine.kind,
                } });
            }
            await db.session.update({ where: { id: session.id }, data: { archivedAt: new Date() } });
            expect((await upload(signed(create))).statusCode).toBe(403);
            await db.session.update({ where: { id: session.id }, data: { archivedAt: null } });
            await db.accessKey.delete({ where: { accountId_machineId_sessionId: {
                accountId: owner.id, machineId: machine.id, sessionId: session.id,
            } } });
            expect((await upload(signed(create))).statusCode).toBe(403);
            await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
            // A shared-use Machine is not this Account's installed publisher,
            // even when its retained Session tuple and signature are valid.
            await db.machine.update({ where: { id: machine.id }, data: { accountId: outsider.id } });
            await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id, accountId: owner.id,
                accessLevel: 'admin', createdByAccountId: outsider.id } });
            expect((await upload(signed(create))).statusCode).toBe(403);
            await db.machineGrant.delete({ where: { principalKind: 'account', machineId_accountId: { machineId: machine.id, accountId: owner.id } } });
            await db.machine.update({ where: { id: machine.id }, data: { accountId: owner.id } });
            externalAction = true;
            expect((await upload(signed(create))).statusCode).toBe(403);
            externalAction = false;
            const staleSource = structuredClone(create);
            if (!staleSource.agent) throw new Error('Expected agent publication');
            staleSource.agent.publication.sourceSession = { sourceSessionId: session.id,
                sourceTurnId: 'missing-turn', sourceInputId: 'missing-input', via: 'action' };
            liveMachine = machine.id;
            expect((await upload(signed(staleSource))).statusCode).toBe(403);
            liveMachine = 'other-machine';
            expect((await upload(signed(create))).statusCode).toBe(403);
            expect(writes).not.toHaveBeenCalled();
            liveMachine = machine.id;
            const created = await upload(signed(create));
            expect(created.statusCode, created.body).toBe(200);
            const discussionId: string = created.json().discussion.id;
            const firstId: string = created.json().firstMessage.id;
            expect(created.json().firstMessage.producerV1).toMatchObject({ kind: 'agent', sessionId: session.id, toolCallId: 'agent-create' });
            const firstRead = await app.inject({ method: 'GET', url: `/v1/discussions/${discussionId}/messages/${firstId}/attachments/${firstMessage.attachments[0]!.blobId}` });
            expect(firstRead.statusCode, firstRead.body).toBe(200);
            expect(decodeBase64(firstRead.json().content.v)).toEqual(bytes);
            expect((await upload(signed(create))).json().firstMessage.id).toBe(firstId);
            for (const operation of ['post', 'reply'] as const) {
                const request = { ...message(), ...(operation === 'reply' ? { replyTarget: { kind: 'message' as const, messageId: firstId } } : {}) };
                const post = signed({ operation, input: { discussionId, ...request },
                    attachments: [{ ...request.attachments[0]!, storedSizeBytes: bytes.length }],
                    agent: { machineId: machine.id, installationId: machine.installationId!,
                        publication: { v: 1, sessionId: session.id, toolCallId: `agent-${operation}` } } });
                const posted = await upload(post);
                expect(posted.statusCode, posted.body).toBe(200);
                expect(posted.json().message.producerV1).toMatchObject({ kind: 'agent', sessionId: session.id, toolCallId: `agent-${operation}` });
                const read = await app.inject({ method: 'GET', url: `/v1/discussions/${discussionId}/messages/${posted.json().message.id}/attachments/${request.attachments[0]!.blobId}` });
                expect(read.statusCode, read.body).toBe(200);
                expect(decodeBase64(read.json().content.v)).toEqual(bytes);
            }
            // Reviewed replay is already owned by the installed Machine after
            // the Session publisher disconnects; it retains its original turn.
            await db.discussionParticipant.update({ where: { discussionId_sessionId: { discussionId, sessionId: session.id } },
                data: { answerPolicy: 'drafts_for_approval' } });
            const sourceTurnId = randomUUID();
            await db.sessionTurn.create({ data: { sessionId: session.id, turnId: sourceTurnId, status: 'completed', startedAt: 1n, updatedAt: 2n } });
            liveMachine = null;
            const reviewed = message();
            const unapproved = { operation: 'post' as const, input: { discussionId, ...reviewed },
                attachments: [{ ...reviewed.attachments[0]!, storedSizeBytes: bytes.length }],
                agent: { machineId: machine.id, installationId: machine.installationId!, signature: '', publication: {
                    v: 1, sessionId: session.id, sourceSession: { sourceSessionId: session.id, sourceTurnId, via: 'action' },
                    draftReview: { artifactId: String(randomUUID()), decidingAccountId: owner.id },
                } } } satisfies DiscussionAttachmentUploadRequestV1;
            // An installation signature is not a person's approval. In
            // particular, a guessed Artifact id cannot satisfy draft policy.
            const refused = await upload(signed(unapproved));
            expect(refused.statusCode, refused.body).toBe(403);
            const { draftReview: _unprovenReview, ...unreviewedPublication } = unapproved.agent.publication;
            expect((await upload(signed({ ...unapproved, agent: { ...unapproved.agent, publication: unreviewedPublication } }))).statusCode).toBe(403);
            const otherSession = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
            // Header/body are opaque at this server admission boundary. The
            // composed MCP case below covers their real encrypted producers.
            const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
                kind: deriveArtifactStoredKindV1({ kind: APPROVAL_ARTIFACT_KINDS_V1.builtIn }), approvalSessionId: session.id,
                header: new Uint8Array([0]), body: new Uint8Array([0]), dataEncryptionKey: new Uint8Array([0]) } });
            for (const mismatch of [{ accountId: outsider.id }, { approvalSessionId: otherSession.id },
                { kind: deriveArtifactStoredKindV1({ kind: 'not-an-approval' }) }, { deletedAt: new Date() }]) {
                const wrongArtifact = await db.artifact.create({ data: { ...artifact, id: randomUUID(), ...mismatch } });
                const wrong = structuredClone(unapproved);
                wrong.agent.publication.draftReview.artifactId = wrongArtifact.id;
                expect((await upload(signed(wrong))).statusCode).toBe(403);
            }
            const approved = structuredClone(unapproved);
            approved.agent.publication.draftReview.artifactId = artifact.id;
            const accepted = await upload(signed(approved));
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json().message.producerV1.sourceSession).toMatchObject({ sourceSessionId: session.id, sourceTurnId });
            await db.discussionParticipant.update({ where: { discussionId_sessionId: { discussionId, sessionId: session.id } },
                data: { answerPolicy: 'when_addressed' } });
            liveMachine = machine.id;
            writes.mockRestore();
            const raced = vi.spyOn(privateFiles, 'writePrivateFile').mockImplementation(async (...args) => {
                const result = await originalWrite(...args);
                await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
                return result;
            });
            try {
                const next = message();
                const admittedUpload = signed({ operation: 'post', input: { discussionId, ...next },
                    attachments: [{ ...next.attachments[0]!, storedSizeBytes: bytes.length }],
                    agent: { machineId: machine.id, installationId: machine.installationId!, signature: '',
                        publication: { v: 1, sessionId: session.id } } });
                const response = await upload(admittedUpload);
                expect(response.statusCode, response.body).toBe(200);
                expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(5);
                const nextRequest = await upload(admittedUpload);
                expect(nextRequest.statusCode, nextRequest.body).toBe(403);
                expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(5);
                expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
            } finally { raced.mockRestore(); }
        } finally {
            writes.mockRestore();
            await app.close();
            // The suite owns this disposable database, including restricted
            // Session/AccessKey rows; each case uses distinct Account ids.
            restoreEnvironment();
        }
    });

    it('atomically creates attachment-only history, rejoins without replacing bytes and reads only an exact current grant', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const bytes = Buffer.from('private Discussion attachment');
        const blobId = randomUUID();
        const input = { creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Files' } },
            participants: [{ kind: 'account', accountId: reader.id }], firstMessage: {
                localId: randomUUID(), mentionedAccountIds: [], attachments: [{ blobId, t: 'plain' }],
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'attachment', attachment: {
                    kind: 'file', id: blobId, name: 'evidence.txt', file: { blobId, mime: 'text/plain',
                        sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
                } }] } },
            } };
        const metadata = { operation: 'create', input, attachments: [{ blobId, t: 'plain', storedSizeBytes: bytes.length }] };
        let actorAccountId = owner.id;
        const { app, restoreEnvironment } = createAttachmentApp(() => actorAccountId);
        const upload = (payloadBytes = bytes, envelope: unknown = metadata) => app.inject({ method: 'POST', url: '/v1/discussions/upload',
            headers: { 'content-type': 'application/vnd.happier.discussion-upload-v1' },
            payload: Buffer.concat([Buffer.from(`${JSON.stringify(envelope)}\n`), payloadBytes]) });
        try {
            const denied = await upload(bytes, { operation: 'post', input: {
                ...metadata.input.firstMessage, discussionId: 'missing-discussion',
            }, attachments: metadata.attachments });
            expect(denied.statusCode).toBe(403);
            const rejected = await upload(bytes.subarray(0, bytes.length - 1));
            expect(rejected.statusCode).toBe(400);
            expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(0);
            const surplus = await upload(Buffer.concat([bytes, Buffer.from([1])]));
            expect(surplus.statusCode).toBe(400);
            expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(0);
            const multiple = structuredClone(metadata);
            const secondBlobId = randomUUID();
            const firstPart = multiple.input.firstMessage.content.v.parts[0]!;
            multiple.input.firstMessage.content.v.parts.push({ ...firstPart, attachment: { ...firstPart.attachment,
                id: secondBlobId, file: { ...firstPart.attachment.file, blobId: secondBlobId } } });
            multiple.input.firstMessage.attachments.push({ blobId: secondBlobId, t: 'plain' });
            multiple.attachments.push({ blobId: secondBlobId, t: 'plain', storedSizeBytes: bytes.length });
            expect((await upload(Buffer.concat([bytes, bytes.subarray(0, bytes.length - 1)]), multiple)).statusCode).toBe(400);
            expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(0);
            expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
            const tampered = await upload(Buffer.alloc(bytes.length));
            expect(tampered.statusCode).toBe(400);
            expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(0);
            const created = await upload();
            expect(created.statusCode).toBe(200);
            const result = created.json();
            const discussionId: string = result.discussion.id;
            const messageId: string = result.firstMessage.id;
            const retried = await upload();
            expect(retried.statusCode).toBe(200);
            expect(retried.json().firstMessage.id).toBe(messageId);
            const replayWithDifferentBytes = await upload(Buffer.alloc(bytes.length));
            expect(replayWithDifferentBytes.statusCode).toBe(200);
            const changedIntent = structuredClone(metadata);
            changedIntent.input.firstMessage.content.v.parts[0]!.attachment.name = 'changed-name.txt';
            expect((await upload(bytes, changedIntent)).statusCode).toBe(409);
            const inventoryReads = vi.spyOn(privateFiles, 'readPrivateFile');
            try {
                expect((await app.inject({ method: 'GET', url: '/v1/discussions' })).statusCode).toBe(200);
                expect((await app.inject({ method: 'GET', url: `/v1/discussions/${discussionId}/messages` })).statusCode).toBe(200);
                expect(inventoryReads).not.toHaveBeenCalled();
            } finally { inventoryReads.mockRestore(); }
            expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
            const folderId = randomUUID();
            const posted = await upload(Buffer.alloc(0), { operation: 'post', attachments: [], input: {
                discussionId, localId: randomUUID(), mentionedAccountIds: [], content: { t: 'plain', v: {
                    v: 1, parts: [{ t: 'attachment', attachment: { kind: 'folder', id: folderId,
                        name: 'empty-folder', entries: [], directories: ['nested/empty'] } }],
                } },
            } });
            expect(posted.statusCode).toBe(200);
            expect(posted.json().message.content.v.parts[0].attachment.directories).toEqual(['nested/empty']);
            expect(await db.discussionAttachment.count({ where: { messageId: posted.json().message.id } })).toBe(0);
            const textOnly = await app.inject({ method: 'POST', url: '/v1/discussions', payload: {
                creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Text neighbor' } },
                participants: [{ kind: 'account', accountId: reader.id }], firstMessage: { localId: randomUUID(), mentionedAccountIds: [],
                    content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Ordinary JSON send' }] } } },
            } });
            expect(textOnly.statusCode).toBe(200);
            actorAccountId = reader.id;
            const url = `/v1/discussions/${discussionId}/messages/${messageId}/attachments/${blobId}`;
            const read = await app.inject({ method: 'GET', url });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toEqual({ blobId, content: { t: 'plain', v: bytes.toString('base64') } });
            expect((await app.inject({ method: 'GET', url: url.replace(messageId, 'other-message') })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: url.replace(messageId, posted.json().message.id) })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: url.replace(discussionId, textOnly.json().discussion.id) })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: `${url}?throughSeq=0` })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: `${url}?throughSeq=-1` })).json()).toEqual({ error: 'discussion_invalid_content' });
            const readPrivateFile = privateFiles.readPrivateFile;
            // This finite read keeps its admitted immutable locator and key.
            // Withdrawal takes effect when the reader starts another request.
            const raced = vi.spyOn(privateFiles, 'readPrivateFile').mockImplementation(async key => {
                const value = await readPrivateFile(key);
                await db.discussionGrant.deleteMany({ where: { discussionId, principalKind: 'account', accountId: reader.id } });
                return value;
            });
            try {
                const admitted = await app.inject({ method: 'GET', url });
                expect(admitted.statusCode, admitted.body).toBe(200);
                expect(admitted.json().content).toEqual({ t: 'plain', v: bytes.toString('base64') });
                expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
            }
            finally { raced.mockRestore(); }
            actorAccountId = owner.id;
            expect((await app.inject({ method: 'POST', url: `/v1/discussions/${discussionId}/participants/invite`,
                payload: { participant: { kind: 'account', accountId: reader.id } } })).statusCode).toBe(200);
            const retained = await db.discussionAttachment.findUniqueOrThrow({ where: { blobId } });
            expect((await app.inject({ method: 'PUT', url: `/v1/discussions/${discussionId}/owner`,
                payload: { accountId: reader.id } })).statusCode).toBe(200);
            expect(await db.discussionAttachment.findUniqueOrThrow({ where: { blobId } })).toEqual(retained);
            expect(await db.discussionAttachment.count({ where: { message: { discussion: { ownerAccountId: owner.id } } } })).toBe(0);
            expect(await db.discussionAttachment.count({ where: { message: { discussion: { ownerAccountId: reader.id } } } })).toBe(1);
            // Retirement of the former owning Account leaves the transferred message and its private locator intact.
            await db.account.delete({ where: { id: owner.id } });
            actorAccountId = reader.id;
            expect((await app.inject({ method: 'GET', url })).json()).toEqual({ blobId, content: { t: 'plain', v: bytes.toString('base64') } });
            await db.discussion.update({ where: { id: discussionId }, data: { archivedAt: new Date() } });
            expect((await app.inject({ method: 'GET', url })).json()).toEqual({ blobId, content: { t: 'plain', v: bytes.toString('base64') } });
            await db.discussionAttachment.update({ where: { blobId }, data: { encryptionMode: 'e2ee' } });
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(400);
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
        } finally {
            await app.close();
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
            restoreEnvironment();
        }
    });

    it('stores only sealed bytes under the real Discussion key and refuses an invited reader without recipient material', async () => {
        const recipient = tweetnacl.box.keyPair();
        const binding = createSignedAccountContentBinding(recipient.publicKey);
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...binding } });
        const reader = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const dataKey = tweetnacl.randomBytes(32);
        const plaintext = new TextEncoder().encode('sealed private evidence');
        const sealed = frameSessionDataKeyBundleV0(await sealAesGcmPayloadWebCrypto(plaintext, dataKey));
        const blobId = randomUUID();
        const authored = DiscussionMessageContentV1Schema.parse({ v: 1, parts: [{ t: 'attachment', attachment: {
            kind: 'file', id: blobId, name: 'private.txt', file: { blobId, mime: 'text/plain', sizeBytes: plaintext.byteLength,
                sha256: createHash('sha256').update(plaintext).digest('hex') },
        } }] });
        const title = { v: 1 as const, title: 'Private files' };
        const first = { localId: randomUUID(), content: authored, mentionedAccountIds: [], attachments: [{ blobId, t: 'encrypted' as const }] };
        const participants = [{ kind: 'account' as const, accountId: reader.id }];
        const evidence = (canonicalIntent: string) => ({ kind: 'e2eeTag' as const,
            tag: deriveDiscussionMutationEqualityTagV1({ dataKey, canonicalIntent }) });
        const input = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: randomUUID(), participants,
            creationEqualityEvidenceV1: evidence(serializeDiscussionMutationEqualityIntentV1({ kind: 'create', title, participants, firstMessage: first })),
            titleContent: { t: 'encrypted', c: encodeBase64(await sealSessionDataKeyBundleV0(title, dataKey)) },
            dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: recipient.publicKey,
                randomBytes: tweetnacl.randomBytes })),
            expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(binding.contentPublicKey),
            firstMessage: { localId: first.localId, authoredContent: authored, mentionedAccountIds: [],
                requestEqualityEvidenceV1: evidence(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...first })),
                content: { t: 'encrypted', c: encodeBase64(await sealSessionDataKeyBundleV0(authored, dataKey)) } },
        });
        let actorAccountId = owner.id;
        const { app, restoreEnvironment } = createAttachmentApp(() => actorAccountId);
        try {
            const metadata = { operation: 'create', input, attachments: [{ blobId, t: 'encrypted', storedSizeBytes: sealed.byteLength }] };
            const created = await app.inject({ method: 'POST', url: '/v1/discussions/upload', headers: {
                'content-type': 'application/vnd.happier.discussion-upload-v1',
            }, payload: Buffer.concat([Buffer.from(`${JSON.stringify(metadata)}\n`), Buffer.from(sealed)]) });
            expect(created.statusCode).toBe(200);
            const result = created.json();
            const changedBindings = structuredClone(metadata);
            const otherBlobId = randomUUID();
            changedBindings.input.firstMessage.attachments![0]!.blobId = otherBlobId;
            changedBindings.attachments[0]!.blobId = otherBlobId;
            const conflict = await app.inject({ method: 'POST', url: '/v1/discussions/upload', headers: {
                'content-type': 'application/vnd.happier.discussion-upload-v1',
            }, payload: Buffer.concat([Buffer.from(`${JSON.stringify(changedBindings)}\n`), Buffer.from(sealed)]) });
            expect(conflict.statusCode).toBe(409);
            const url = `/v1/discussions/${result.discussion.id}/messages/${result.firstMessage.id}/attachments/${blobId}`;
            const read = await app.inject({ method: 'GET', url });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toEqual({ blobId, content: { t: 'encrypted', c: encodeBase64(sealed) } });
            const row = await db.discussionAttachment.findUniqueOrThrow({ where: { blobId } });
            expect(await privateFiles.readPrivateFile(row.storageKey)).toEqual(sealed);
            const bundle = readSessionDataKeyBundleV0(decodeBase64(read.json().content.c));
            if (bundle.status !== 'ready') throw new Error('Expected the canonical AES-GCM frame');
            expect(await openAesGcmPayloadWebCrypto(bundle.payload, dataKey)).toEqual(plaintext);
            actorAccountId = reader.id;
            expect((await app.inject({ method: 'GET', url })).json()).toEqual({ error: 'discussion_content_unavailable' });
        } finally {
            await app.close();
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
            restoreEnvironment();
        }
    });
}
