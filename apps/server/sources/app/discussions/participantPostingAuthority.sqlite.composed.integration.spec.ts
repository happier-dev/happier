import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { buildDiscussionMutationRequestBodyV1, DiscussionCreateResponseV1Schema, DiscussionDetailsResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionInviteResponseV1Schema, DiscussionModelParticipantLaunchV1Schema } from '@happier-dev/protocol/discussions/participants';
import { auth } from '@/app/auth/auth';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { registerSessionCreateOrLoadRoute } from '@/app/api/routes/session/registerSessionCreateOrLoadRoute';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { db } from '@/storage/db';
import { encrypt } from '../../../../cli/src/api/encryption';
import { sealSessionStoredContent } from '../../../../cli/src/session/transport/encryption/sessionStoredContentCodec';

// Owner ruling 2026-11-09: anyone who can post may add their agent, including
// on a teammate's Doc thread. Human grants and foreign Session control stay separate.
describe('Doc thread executable invitations through authenticated HTTP', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-doc-agent-invite-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('lets a teammate writer invite and birth their own agent, while refusing readers and foreign custody (%s)', async mode => {
        const ownerKeys = mode === 'e2ee' ? tweetnacl.box.keyPair() : null;
        const writerKeys = mode === 'e2ee' ? tweetnacl.box.keyPair() : null;
        const dataKey = mode === 'e2ee' ? tweetnacl.randomBytes(32) : null;
        const envelope = (recipientPublicKey: Uint8Array) => sealEncryptedDataKeyEnvelopeV1({ dataKey: dataKey!,
            recipientPublicKey, randomBytes: tweetnacl.randomBytes });
        const seal = (payload: Parameters<typeof sealSessionStoredContent>[0]['payload']) => sealSessionStoredContent(dataKey
            ? { mode: 'e2ee', ctx: { encryptionKey: dataKey, encryptionVariant: 'dataKey' }, payload }
            : { mode: 'plain', ctx: null, payload });
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(ownerKeys ? createSignedAccountContentBinding(ownerKeys.publicKey) : {}) } });
        const writer = await db.account.create({ data: { encryptionMode: mode,
            ...(writerKeys ? createSignedAccountContentBinding(writerKeys.publicKey) : {}) } });
        const team = await db.team.create({ data: { name: 'Doc collaborators' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: writer.id, role: 'member' },
        ] });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: dataKey ? encrypt(dataKey, 'dataKey', { title: 'Shared Doc', kind: 'markdown' })
                : decodeBase64(encodePlainArtifactStoredContent({ title: 'Shared Doc', kind: 'markdown' })),
            body: dataKey ? encrypt(dataKey, 'dataKey', { body: 'Shared passage' })
                : decodeBase64(encodePlainArtifactStoredContent({ body: 'Shared passage' })),
            dataEncryptionKey: ownerKeys ? envelope(ownerKeys.publicKey) : decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.artifact.id, teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        if (writerKeys) await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.artifact.id, recipientAccountId: writer.id,
            encryptedDataKey: envelope(writerKeys.publicKey), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(writerKeys.publicKey) } });
        const doc = { ref: { kind: 'doc' as const, artifactId: artifact.artifact.id, serverId: 'home' },
            revision: { headerVersion: artifact.artifact.headerVersion, bodyVersion: artifact.artifact.bodyVersion } };
        const tokens = new Map(await Promise.all([owner, writer].map(async account => [account.id,
            await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' })] as const)));
        const headers = (accountId: string) => ({ authorization: `Bearer ${tokens.get(accountId)}`,
            'x-happier-account-stored-content-protocol': '2' });
        await withAuthenticatedTestApp(app => { registerDiscussionRoutes(app); registerSessionCreateOrLoadRoute(app); }, async app => {
            const content = { kind: 'doc_passage_comment' as const,
                passage: { ...doc, range: { start: 0, end: 14 }, quote: 'Shared passage' },
                content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Discuss the shared passage' }] } };
            const created = await app.inject({ method: 'POST', url: '/v1/discussions', headers: headers(owner.id),
                payload: buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: randomUUID(),
                    anchor: { kind: 'doc', doc }, titleContent: seal({ v: 1, title: 'Doc thread' }),
                    ...(ownerKeys && writerKeys ? { dataEncryptionKey: encodeBase64(envelope(ownerKeys.publicKey)),
                        expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(ownerKeys.publicKey),
                        creationEqualityEvidenceV1: { kind: 'e2eeTag' as const, tag: 'A'.repeat(43) },
                        recipientKeyEnvelopes: [{ recipientAccountId: writer.id, encryptedDataKey: encodeBase64(envelope(writerKeys.publicKey)),
                            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(writerKeys.publicKey) }] } : {}),
                    firstMessage: { localId: randomUUID(), mentionedAccountIds: [], authoredContent: content,
                        ...(dataKey ? { requestEqualityEvidenceV1: { kind: 'e2eeTag' as const, tag: 'B'.repeat(43) } } : {}),
                        content: seal(content), replyTarget: { kind: 'doc_passage', doc } } }) });
            expect(created.statusCode, created.body).toBe(200);
            const discussionId = DiscussionCreateResponseV1Schema.parse(created.json()).discussion.id;
            // Creation discloses to the Doc audience; exercise Team-only posting authority.
            await db.discussionAccountGrant.deleteMany({ where: { discussionId, accountId: writer.id } });
            const grant = await app.inject({ method: 'PUT', url: `/v1/discussions/${discussionId}/access/grants`,
                headers: headers(owner.id), payload: { principal: { kind: 'team', teamId: team.id }, accessLevel: 'edit' } });
            expect(grant.statusCode, grant.body).toBe(200);
            const details = await app.inject({ method: 'GET', url: `/v1/discussions/${discussionId}`, headers: headers(writer.id) });
            expect(details.statusCode, details.body).toBe(200);
            expect(DiscussionDetailsResponseV1Schema.parse(details.json()).discussion).toMatchObject({ access: 'edit',
                capabilities: { postMessages: true, manageAccess: false } });
            const own = await db.session.create({ data: { accountId: writer.id, tag: randomUUID(), metadata: '{}', encryptionMode: mode,
                ...(writerKeys ? { dataKeyEnvelopes: { create: { recipientAccountId: writer.id, encryptedDataKey: envelope(writerKeys.publicKey) } } } : {}) } });
            const foreign = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: mode,
                ...(ownerKeys ? { dataKeyEnvelopes: { create: { recipientAccountId: owner.id, encryptedDataKey: envelope(ownerKeys.publicKey) } } } : {}) } });
            const invite = (accountId: string, participant: unknown) => app.inject({ method: 'POST',
                url: `/v1/discussions/${discussionId}/participants/invite`, headers: headers(accountId), payload: { participant } });
            const added = await invite(writer.id, { kind: 'session', sessionId: own.id });
            expect(added.statusCode, added.body).toBe(200);
            expect((await invite(writer.id, { kind: 'session', sessionId: foreign.id })).statusCode).toBe(403);
            expect((await invite(writer.id, { kind: 'account', accountId: owner.id })).statusCode).toBe(403);
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: writer.id, metadata: '{}' } });
            const launch = DiscussionModelParticipantLaunchV1Schema.parse({ executionTarget: { serverId: 'home', machineId: machine.id },
                directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
            const discussionParticipant = { discussionId, participantSlotId: randomUUID() };
            const model = { kind: 'model', participantSlotId: discussionParticipant.participantSlotId, launch };
            const reserved = await invite(writer.id, model);
            expect(reserved.statusCode, reserved.body).toBe(200);
            expect(DiscussionInviteResponseV1Schema.parse(reserved.json())).toMatchObject({ modelParticipant: { sessionId: null } });
            expect(await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: discussionParticipant } }))
                .toMatchObject({ createdByAccountId: writer.id });
            const birthBody = { tag: randomUUID(), metadataLayoutVersion: 1, encryptionMode: mode,
                sharedMetadata: { ciphertext: dataKey ? encodeBase64(encrypt(dataKey, 'dataKey', { v: 1 })) : JSON.stringify({ v: 1 }) },
                ownerMetadata: writerKeys ? sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: { v: 1 },
                    material: { type: 'dataKey', machineKey: writerKeys.secretKey }, randomBytes: tweetnacl.randomBytes })
                    : { t: 'plain', v: { v: 1 } },
                dataEncryptionKey: writerKeys ? encodeBase64(envelope(writerKeys.publicKey)) : null,
                originKind: 'discussion', discussionParticipant, discussionParticipantLaunch: launch };
            const birth = await app.inject({ method: 'POST', url: '/v1/sessions', headers: headers(writer.id), payload: birthBody });
            expect(birth.statusCode, birth.body).toBe(200);
            const bound = await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: discussionParticipant } });
            expect(bound.sessionId).not.toBeNull();
            expect(await db.session.findUniqueOrThrow({ where: { id: bound.sessionId! } }))
                .toMatchObject({ accountId: writer.id, originKind: 'discussion' });
            const retried = await invite(writer.id, model);
            expect(retried.statusCode, retried.body).toBe(200);
            expect(DiscussionInviteResponseV1Schema.parse(retried.json()))
                .toMatchObject({ modelParticipant: { sessionId: bound.sessionId } });
            expect((await app.inject({ method: 'POST', url: '/v1/sessions', headers: headers(owner.id), payload: birthBody })).statusCode).toBe(403);
            expect((await invite(owner.id, { kind: 'session', sessionId: foreign.id })).statusCode).toBe(200);
            await db.discussionTeamGrant.update({ where: { discussionId_teamId: { discussionId, teamId: team.id } }, data: { accessLevel: 'view' } });
            const readOnly = await invite(writer.id, { kind: 'session', sessionId: own.id });
            expect(readOnly.statusCode, readOnly.body).toBe(403);
            expect(readOnly.json()).toMatchObject({ error: 'discussion_access_forbidden' });
            expect((await invite(writer.id, { ...model, participantSlotId: randomUUID() })).statusCode).toBe(403);
            expect((await app.inject({ method: 'POST', url: '/v1/sessions', headers: headers(writer.id), payload: birthBody })).statusCode).toBe(403);
            if (writerKeys) {
                await db.discussionTeamGrant.update({ where: { discussionId_teamId: { discussionId, teamId: team.id } }, data: { accessLevel: 'edit' } });
                await db.discussionKeyEnvelope.delete({ where: { discussionId_recipientAccountId: { discussionId, recipientAccountId: writer.id } } });
                const locked = await invite(writer.id, { kind: 'session', sessionId: own.id });
                expect(locked.statusCode, locked.body).toBe(409);
                expect(locked.json()).toMatchObject({ error: 'discussion_content_unavailable' });
            }
        }, { authentication: 'real' });
    });
});
