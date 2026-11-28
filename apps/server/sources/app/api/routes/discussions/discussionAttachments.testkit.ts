import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { registerDiscussionRoutes } from './registerDiscussionRoutes';
import * as privateFiles from '@/storage/blob/files';
import tweetnacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'privacy-kit';
import { sealAesGcmPayloadWebCrypto, openAesGcmPayloadWebCrypto, openSessionDataKeyBundleV0, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto';
import { frameSessionDataKeyBundleV0, readSessionDataKeyBundleV0 } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { buildDiscussionMutationRequestBodyV1, DISCUSSION_EXACT_MESSAGE_KEY_CONTEXT_ACCEPT_V1, DISCUSSION_HTTP_PATHS_V1 } from '@happier-dev/protocol/discussions/api';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { DiscussionAttachmentReadResponseV1Schema } from '@happier-dev/protocol/discussions/attachments';
import { DiscussionMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { signDiscussionAttachmentAgentUploadV1, DiscussionAttachmentUploadRequestV1Schema, type DiscussionAttachmentUploadRequestV1 } from '@happier-dev/protocol/discussions/attachmentsUpload';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { createSecondOpinionSourceFixture } from '@/app/discussions/secondOpinionSecurity.testkit';
import { StorageInventoryV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { registerAccountEncryptionMigrateRoutes } from '@/app/api/routes/account/registerAccountEncryptionMigrateRoutes';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { publicShareRoutes } from '@/app/api/routes/share/publicShareRoutes';
import { auth } from '@/app/auth/auth';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, createPlainSessionOwnerMetadataEnvelopeV1,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';

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
    it('counts quoted attachments in the Discussion only for readers of the source and the billed owner', async () => {
        const { owner, reader, source, answer, request } = await createSecondOpinionSourceFixture();
        const sourceGrant = await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: source.id, createdByAccountId: owner.id, accountId: reader.id, accessLevel: 'view' } });
        const bytes = Buffer.from('file on the quoted message');
        const blobId = randomUUID();
        const attachment = { blobId, t: 'plain' as const };
        const content = DiscussionMessageContentV1Schema.parse({ v: 1, parts: [
            { t: 'text', text: 'Private answer' },
            { t: 'attachment', attachment: { kind: 'file', id: blobId, name: 'source.txt',
                file: { blobId, mime: 'text/plain', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } },
        ] });
        const metadata = DiscussionAttachmentUploadRequestV1Schema.parse({ operation: 'create',
            input: { ...request, firstMessage: { ...request.firstMessage, attachments: [attachment],
                content: { t: 'plain', v: content } } },
            attachments: [{ ...attachment, storedSizeBytes: bytes.length }] });

        let actorAccountId = owner.id;
        const { app, restoreEnvironment } = createAttachmentApp(() => actorAccountId);
        artifactsRoutes(app);
        try {
            const created = await app.inject({ method: 'POST', url: '/v1/discussions/upload',
                headers: { 'content-type': 'application/vnd.happier.discussion-upload-v1' },
                payload: Buffer.concat([Buffer.from(JSON.stringify(metadata) + '\n'), bytes]) });
            expect(created.statusCode, created.body).toBe(200);
            const { discussion, firstMessage } = created.json();
            const inventoryUrl = '/v1/artifacts/storage/usage?inventory=true&paged=true&discussionId=' + discussion.id;
            const readInventory = async () => {
                const response = await app.inject({ url: inventoryUrl });
                expect(response.statusCode, response.body).toBe(200);
                return StorageInventoryV1Schema.parse(response.json());
            };
            // Storage billing uses the bytes of the persisted attachment envelope.
            const stored = await db.discussionAttachment.findFirstOrThrow({ where: { messageId: firstMessage.id, blobId },
                select: { storedSizeBytes: true } });
            const storedSizeBytes = Number(stored.storedSizeBytes);
            expect(storedSizeBytes).toBeGreaterThan(0);
            const visible = {
                totalBytes: storedSizeBytes,
                byKind: { discussionAttachments: storedSizeBytes },
                kinds: { discussionAttachments: { itemCount: 1, storedSizeBytes } },
                page: { items: [{ id: blobId, storedSizeBytes,
                    location: { kind: 'discussion', discussionId: discussion.id, messageId: firstMessage.id, attachmentId: blobId } }] },
            };
            actorAccountId = reader.id;
            expect(await readInventory()).toMatchObject(visible);
            await db.sessionGrant.delete({ where: { principalKind: 'account', id: sourceGrant.id } });

            const history = await app.inject({ url: '/v1/discussions/' + discussion.id + '/messages' });
            expect(history.statusCode, history.body).toBe(200);
            expect(history.json().messages).toEqual([]);
            expect(await readInventory()).toMatchObject({
                totalBytes: 0, byKind: { discussionAttachments: 0 },
                kinds: { discussionAttachments: { itemCount: 0, storedSizeBytes: 0 } },
                page: { items: [] },
            });

            // Billing retains the file even when the Discussion owner loses the source itself.
            await db.sessionMessage.delete({ where: { id: answer.id } });
            actorAccountId = owner.id;
            expect(await readInventory()).toMatchObject(visible);
        } finally {
            await app.close();
            restoreEnvironment();
        }
    });

    it.each(['author', 'owner'] as const)('lets the %s remove a committed attachment, while other readers cannot', async remover => {
        const [owner, author, participant, teamReader, unrelated] = await Promise.all(Array.from({ length: 5 }, () =>
            db.account.create({ data: { encryptionMode: 'plain' } })));
        await makeShareEligibleForTest(owner.id, author.id);
        await makeShareEligibleForTest(owner.id, participant.id);
        const team = await db.team.create({ data: { name: 'Attachment readers', memberships: { create: [
            { accountId: owner.id, role: 'owner' }, { accountId: teamReader.id, role: 'member' },
        ] } } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
            metadata: JSON.stringify({ v: 1 }), metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: {} })),
        } });
        const linkToken = randomUUID();
        await db.publicSessionShare.create({ data: { sessionId: session.id, createdByUserId: owner.id,
            tokenHash: createHash('sha256').update(linkToken).digest(), isConsentRequired: false } });
        let actorAccountId = owner.id;
        const { app, restoreEnvironment } = createAttachmentApp(() => actorAccountId);
        const publicApp = createAuthenticatedTestApp({ authentication: 'real' });
        artifactsRoutes(app);
        registerAccountEncryptionMigrateRoutes(app);
        artifactsRoutes(publicApp);
        publicShareRoutes(publicApp);
        registerDiscussionRoutes(publicApp);
        try {
            await auth.init();
            const titleContent = { t: 'plain', v: { v: 1, title: 'Attachment removal' } };
            const created = await app.inject({ method: 'POST', url: '/v1/discussions', payload: {
                creationLocalId: randomUUID(), titleContent, anchor: { kind: 'session', sessionId: session.id },
                participants: [author.id, participant.id].map(accountId => ({ kind: 'account', accountId })),
                firstMessage: { localId: randomUUID(), mentionedAccountIds: [],
                    content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'First message' }] } } },
            } });
            expect(created.statusCode, created.body).toBe(200);
            const discussionId: string = created.json().discussion.id;
            const grant = await app.inject({ method: 'PUT', url: DISCUSSION_HTTP_PATHS_V1.grants.replace(':discussionId', discussionId),
                payload: { principal: { kind: 'team', teamId: team.id }, accessLevel: 'view' } });
            expect(grant.statusCode, grant.body).toBe(200);
            actorAccountId = author.id;
            const bytes = Buffer.from('removable private attachment');
            const blobId = randomUUID();
            const metadata = { operation: 'post', input: { discussionId, localId: randomUUID(),
                mentionedAccountIds: [], attachments: [{ blobId, t: 'plain' }],
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Keep this message' },
                    { t: 'attachment', attachment: { kind: 'file', id: blobId, name: 'keep-message.txt',
                        file: { blobId, mime: 'text/plain', sizeBytes: bytes.length,
                            sha256: createHash('sha256').update(bytes).digest('hex') } } }] } } },
                attachments: [{ blobId, t: 'plain', storedSizeBytes: bytes.length }] };
            const posted = await app.inject({ method: 'POST', url: '/v1/discussions/upload',
                headers: { 'content-type': 'application/vnd.happier.discussion-upload-v1' },
                payload: Buffer.concat([Buffer.from(`${JSON.stringify(metadata)}\n`), bytes]) });
            expect(posted.statusCode, posted.body).toBe(200);
            const messageId: string = posted.json().message.id;
            const url = `/v1/discussions/${discussionId}/messages/${messageId}/attachments/${blobId}`;
            const inventoryPath = '/v1/artifacts/storage/usage?inventory=true&paged=true&kinds=discussionAttachments';
            const scopedPath = `${inventoryPath}&discussionId=${discussionId}`;
            const before = await db.discussionAttachment.findUniqueOrThrow({ where: { blobId } });
            const expectedItem = { id: blobId, kind: 'discussionAttachments', storedSizeBytes: Number(before.storedSizeBytes),
                location: { kind: 'discussion', discussionId, messageId, attachmentId: blobId } };
            const expectItem = async (path: string, viewerMayRemove: boolean) => {
                const response = await app.inject({ url: path });
                expect(response.statusCode, response.body).toBe(200);
                expect(StorageInventoryV1Schema.parse(response.json()).page?.items)
                    .toEqual([expect.objectContaining({ ...expectedItem, viewerMayRemove })]);
                expect(response.body).not.toContain('keep-message.txt');
            };
            await expectItem(scopedPath, true);
            actorAccountId = owner.id;
            await expectItem(inventoryPath, true);
            await expectItem(scopedPath, true);
            const expectTotal = async (url: string, storedSizeBytes: number) => {
                const response = await app.inject({ url });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({
                    kinds: { discussionAttachments: { storedSizeBytes } } });
                if (url === scopedPath) expect(response.json().totalBytes).toBe(storedSizeBytes);
            };
            await expectTotal(inventoryPath, expectedItem.storedSizeBytes);
            await expectTotal(scopedPath, expectedItem.storedSizeBytes);
            actorAccountId = participant.id;
            await expectItem(scopedPath, false);
            expect((await app.inject({ url: inventoryPath })).json().page.items).toEqual([]);
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
            const denied = await app.inject({ method: 'DELETE', url });
            expect(denied.statusCode, denied.body).toBe(403);
            actorAccountId = teamReader.id;
            await expectItem(scopedPath, false);
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
            expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(403);
            actorAccountId = owner.id;
            const revoked = await app.inject({
                method: 'DELETE', url: DISCUSSION_HTTP_PATHS_V1.participant.replace(':discussionId', discussionId),
                payload: { participant: { kind: 'account', accountId: participant.id } },
            });
            expect(revoked.statusCode, revoked.body).toBe(200);
            expect(revoked.json()).toMatchObject({ changed: true });
            actorAccountId = participant.id;
            expect((await app.inject({ url: scopedPath })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
            expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(403);
            actorAccountId = owner.id;
            await expectItem(scopedPath, true);
            const ownerRead = await app.inject({ method: 'GET', url });
            expect(ownerRead.statusCode, ownerRead.body).toBe(200);
            expect(DiscussionAttachmentReadResponseV1Schema.parse(ownerRead.json())).toEqual({
                blobId, content: { t: 'plain', v: bytes.toString('base64') },
            });

            actorAccountId = unrelated.id;
            expect((await app.inject({ url: scopedPath })).statusCode).toBe(404);
            expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(403);
            const publicRead = await publicApp.inject({ method: 'GET', url: `/v1/public-share/${linkToken}`,
                headers: buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) });
            expect(publicRead.statusCode, publicRead.body).toBe(200);
            expect((await publicApp.inject({ url: scopedPath, headers: { authorization: `Bearer ${linkToken}` } })).statusCode).toBe(401);
            expect((await publicApp.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${linkToken}` } })).statusCode).toBe(401);
            expect(await privateFiles.readPrivateFile(before.storageKey)).toBeDefined();
            actorAccountId = remover === 'owner' ? owner.id : author.id;
            const removed = { blobId, removedByAccountId: actorAccountId };
            const effect = await app.inject({ method: 'DELETE', url });
            expect(effect.statusCode, effect.body).toBe(200);
            expect(effect.json()).toEqual(removed);
            expect((await app.inject({ method: 'DELETE', url })).json()).toEqual(removed);
            actorAccountId = teamReader.id;
            expect((await app.inject({ method: 'GET', url })).json()).toEqual(removed);
            const page = await app.inject({ method: 'GET', url: `/v1/discussions/${discussionId}/messages?messageId=${messageId}` });
            expect(page.statusCode, page.body).toBe(200);
            expect(page.json().messages.find((row: { id: string }) => row.id === messageId)?.removedAttachments).toEqual([removed]);
            expect(await db.discussionMessage.findUniqueOrThrow({ where: { id: messageId }, select: { content: true } }))
                .toEqual({ content: metadata.input.content });
            await expect(privateFiles.readPrivateFile(before.storageKey)).rejects.toThrow();
            actorAccountId = owner.id;
            await expectTotal(inventoryPath, 0);
            await expectTotal(scopedPath, 0);
            const conversion = await app.inject({ url: '/v1/account/encryption/migrate/discussions/inventory' });
            expect(conversion.statusCode, conversion.body).toBe(200);
            expect(conversion.json().items).toMatchObject([{ discussionId, messages: expect.arrayContaining([
                expect.objectContaining({ id: messageId, attachments: [], removedAttachmentBlobIds: [blobId] }),
            ]) }]);
        } finally {
            await publicApp.close();
            await app.close();
            restoreEnvironment();
        }
    });

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
            await privateFiles.initFilesS3FromEnv({ ...process.env, S3_HOST: undefined, S3_PRIVATE_BUCKET: 'private' });
            await privateFiles.loadFiles();
            try {
                const unavailable = await upload();
                expect(unavailable.statusCode, unavailable.body).toBe(409);
                expect(unavailable.json()).toEqual({ error: 'discussion_content_unavailable' });
                expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
                expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(0);
            } finally {
                privateFiles.initFilesLocalFromEnv(process.env);
                await privateFiles.loadFiles();
            }
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
            artifactsRoutes(app);
            const metadata = { operation: 'create', input, attachments: [{ blobId, t: 'encrypted', storedSizeBytes: sealed.byteLength }] };
            const created = await app.inject({ method: 'POST', url: '/v1/discussions/upload', headers: {
                'content-type': 'application/vnd.happier.discussion-upload-v1',
            }, payload: Buffer.concat([Buffer.from(`${JSON.stringify(metadata)}\n`), Buffer.from(sealed)]) });
            expect(created.statusCode).toBe(200);
            const result = created.json();
            const inventory = await app.inject({ url: '/v1/artifacts/storage/usage?inventory=true&paged=true&kinds=discussionAttachments' });
            expect(inventory.statusCode, inventory.body).toBe(200);
            expect(inventory.body).not.toContain('private.txt');
            const [item] = inventory.json().page.items;
            expect(item.location).toEqual({ kind: 'discussion', discussionId: result.discussion.id,
                messageId: result.firstMessage.id, attachmentId: blobId });
            const exactMessageUrl = `/v1/discussions/${item.location.discussionId}/messages?messageId=${item.location.messageId}`;
            const keyContextHeaders = { accept: DISCUSSION_EXACT_MESSAGE_KEY_CONTEXT_ACCEPT_V1 };
            expect((await app.inject({ url: exactMessageUrl })).json()).not.toHaveProperty('keyContext');
            const selected = await app.inject({ url: exactMessageUrl, headers: keyContextHeaders });
            expect(selected.statusCode, selected.body).toBe(200);
            expect(selected.json().keyContext).toEqual({ encryptionMode: 'e2ee', keyReadiness: true,
                dataEncryptionKey: result.discussion.dataEncryptionKey });
            const [message] = selected.json().messages;
            expect(message).toMatchObject({ id: item.location.messageId, content: { t: 'encrypted' } });
            expect(selected.body).not.toContain('private.txt');
            expect(await openSessionDataKeyBundleV0(decodeBase64(message.content.c), dataKey))
                .toMatchObject({ status: 'authenticated', value: { parts: [{ t: 'attachment',
                    attachment: { id: item.location.attachmentId, name: 'private.txt' } }] } });
            const selection = { discussionId: item.location.discussionId, messageId: item.location.messageId };
            const other = await db.discussion.create({ data: {
                ownerAccountId: owner.id, encryptionMode: 'e2ee',
                dataEncryptionKey: decodeBase64(input.dataEncryptionKey!),
                titleContent: input.titleContent, creationLocalId: randomUUID(), creationEqualityEvidenceV1: {},
                lastMessageAt: new Date(), messageSeq: 1,
            } });
            const otherMessage = await db.discussionMessage.create({ data: {
                discussionId: other.id, authorAccountId: owner.id, seq: 1, localId: randomUUID(),
                content: input.firstMessage.content, requestEqualityEvidenceV1: {},
            } });
            const batch = () => app.inject({ method: 'POST', url: DISCUSSION_HTTP_PATHS_V1.exactMessages, payload: { messages: [
                selection, selection, { discussionId: other.id, messageId: otherMessage.id },
                { discussionId: other.id, messageId: selection.messageId },
            ] } });
            let messageReads = 0;
            const stop = observePrismaRequests(db, { before: ({ model, action }) => {
                if (model === 'DiscussionMessage' && (action === 'findMany' || action === 'findFirst')) messageReads++;
            } });
            const batched = await batch().finally(stop);
            expect.soft(batched.statusCode, batched.body).toBe(200);
            expect.soft(messageReads).toBe(1);
            expect.soft(batched.json().discussions).toEqual(expect.arrayContaining([
                { discussionId: selection.discussionId, titleContent: input.titleContent,
                    keyContext: selected.json().keyContext, messages: [message] },
                expect.objectContaining({ discussionId: other.id, messages: [expect.objectContaining({ id: otherMessage.id })] }),
            ]));
            expect.soft(batched.json().discussions).toHaveLength(2);
            expect.soft(batched.body).not.toMatch(/private\.txt|Private files/);
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
            const locked = await app.inject({ url: exactMessageUrl, headers: keyContextHeaders });
            expect(locked.statusCode, locked.body).toBe(200);
            expect(locked.json().keyContext).toEqual({ encryptionMode: 'e2ee', keyReadiness: false, dataEncryptionKey: null });
            const unauthorizedBatch = await batch();
            expect.soft(unauthorizedBatch.statusCode, unauthorizedBatch.body).toBe(200);
            expect.soft(unauthorizedBatch.json().discussions).toEqual([]);
            expect((await app.inject({ method: 'GET', url })).json()).toEqual({ error: 'discussion_content_unavailable' });
        } finally {
            await app.close();
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
            restoreEnvironment();
        }
    });
}
