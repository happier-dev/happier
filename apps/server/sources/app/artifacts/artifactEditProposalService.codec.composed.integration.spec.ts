import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { ArtifactDocumentV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { DocEditAcceptTransportInputV1Schema, prepareDocEditAcceptanceV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { DiscussionOpenedMessageV1Schema } from '@happier-dev/protocol/discussions/actions';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { encrypt, decryptResult } from '../../../../cli/src/api/encryption';
import { openSessionStoredContent, sealSessionStoredContent } from '../../../../cli/src/session/transport/encryption/sessionStoredContentCodec';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { readDiscussionMessageInTx } from '@/app/discussions/queries';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createArtifact } from './artifactWriteService';
import { readArtifactForCallerInTx, setArtifactAccessGrantInTx } from './artifactAccessService';
import { decideArtifactEditProposal } from './artifactEditProposalService';

const authentication = createPresentUserSessionAccessAuthentication();

describe('Doc decision host codec → C3 transaction → Artifact writer', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-doc-decision-codec-', initEncrypt: true }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture(mode: 'plain' | 'e2ee') {
        const keys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        const docKey = tweetnacl.randomBytes(32), discussionKey = tweetnacl.randomBytes(32);
        const sealKey = (dataKey: Uint8Array) => sealEncryptedDataKeyEnvelopeV1({ dataKey,
            recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes });
        const encodeArtifact = (value: unknown) => mode === 'plain'
            ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value)) : encrypt(docKey, 'dataKey', value);
        const openArtifact = (bytes: Uint8Array) => {
            if (mode === 'plain') return decodePlainArtifactStoredContent(privacyKit.encodeBase64(new Uint8Array(bytes)));
            const opened = decryptResult(docKey, 'dataKey', bytes);
            if (opened.status !== 'authenticated') throw new Error('Artifact codec failed to authenticate');
            return opened.value;
        };
        const createdDoc = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: encodeArtifact({ title: 'Private Doc', kind: 'markdown' }), body: encodeArtifact({ body: 'again / again!' }),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) : sealKey(docKey) });
        if (!createdDoc.ok) throw new Error(createdDoc.error);
        const doc = { ref: { kind: 'doc' as const, artifactId: createdDoc.artifact.id, serverId: 'home' },
            revision: { headerVersion: 1, bodyVersion: 1 } };
        const content = DiscussionMessageContentV1Schema.parse({ kind: 'doc_edit_proposal', proposal: {
            target: { ...doc, range: { start: 8, end: 13 }, quote: 'again' }, baseRevision: doc.revision,
            before: 'again', after: '**again**', reason: 'Emphasize this occurrence',
        } });
        const cryptoContext = mode === 'plain' ? { mode: 'plain' as const, ctx: null }
            : { mode: 'e2ee' as const, ctx: { encryptionKey: discussionKey, encryptionVariant: 'dataKey' as const } };
        const localId = crypto.randomUUID(), title = { v: 1 as const, title: 'Private proposal' };
        const replyTarget = { kind: 'doc_passage' as const, doc };
        const equality = (canonicalIntent: string) => ({ kind: 'e2eeTag' as const, tag: deriveDiscussionMutationEqualityTagV1({ dataKey: discussionKey, canonicalIntent }) });
        const request = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
            titleContent: sealSessionStoredContent({ ...cryptoContext, payload: title }),
            ...(mode === 'e2ee' ? { dataEncryptionKey: privacyKit.encodeBase64(new Uint8Array(sealKey(discussionKey))),
                expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys.publicKey),
                creationEqualityEvidenceV1: equality(serializeDiscussionMutationEqualityIntentV1({ kind: 'create', title,
                    firstMessage: { localId, content, mentionedAccountIds: [], replyTarget } })) } : {}),
            firstMessage: { localId, authoredContent: content, content: sealSessionStoredContent({ ...cryptoContext, payload: content }),
                mentionedAccountIds: [], replyTarget,
                ...(mode === 'e2ee' ? { requestEqualityEvidenceV1: equality(serializeDiscussionMutationEqualityIntentV1({
                    kind: 'post', content, mentionedAccountIds: [], replyTarget })) } : {}) } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const proposalRef = createDiscussionMessageRefV1({ serverId: 'home', discussionId: created.value.discussion.id }, created.value.firstMessage);
        const read = await inTx(tx => readDiscussionMessageInTx(tx, { authentication, actorAccountId: owner.id,
            discussionId: proposalRef.discussion.discussionId, messageId: proposalRef.messageId }));
        if (!read.ok) throw new Error(read.error);
        const opened = DiscussionOpenedMessageV1Schema.parse({ ...read.value, messageRef: proposalRef,
            content: openSessionStoredContent({ ...cryptoContext, content: read.value.content }) });
        const source = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: owner.id, artifactId: doc.ref.artifactId }));
        if (!source.ok) throw new Error(source.error);
        const body = openArtifact(source.artifact.body);
        const artifact = ArtifactDocumentV1Schema.parse({ artifactId: source.artifact.id, ownerAccountId: owner.id, access: source.artifact.access,
            publicAudience: source.artifact.publicAudience, header: openArtifact(source.artifact.header),
            body: body && typeof body === 'object' && 'body' in body ? body.body : null, revision: doc.revision,
            seq: source.artifact.seq, createdAt: source.artifact.createdAt.getTime(), updatedAt: source.artifact.updatedAt.getTime() });
        const prepared = prepareDocEditAcceptanceV1({ proposalRef, expectedRevision: doc.revision, message: opened, artifact });
        if (!prepared.preparation) throw new Error('Expected host preparation');
        const packet = DocEditAcceptTransportInputV1Schema.parse({ ...prepared, preparation: { ...prepared.preparation,
            body: privacyKit.encodeBase64(new Uint8Array(encodeArtifact({ body: prepared.preparation.body }))) } });
        return { owner, docKey, discussionKey, doc, request, proposalRef, packet, openArtifact, encodeArtifact, artifact, cryptoContext, content };
    }

    it.each(['plain', 'e2ee'] as const)('admits the exact %s proposal on its authenticated Home despite a different client-local Home label', async mode => {
        const f = await fixture(mode);
        const proposalRef = { ...f.proposalRef, discussion: { ...f.proposalRef.discussion, serverId: 'other-client-profile' } };
        const preparation = f.packet.preparation;
        if (!preparation) throw new Error('Expected host preparation');
        const packet = DocEditAcceptTransportInputV1Schema.parse({ ...f.packet, proposalRef,
            preparation: { ...preparation, doc: { ...preparation.doc,
                ref: { ...preparation.doc.ref, serverId: proposalRef.discussion.serverId } } } });
        const accepted = await decideArtifactEditProposal({ actorAccountId: f.owner.id, authentication,
            ...packet, decision: 'accept' });
        expect(accepted).toMatchObject({ ok: true, disposition: { state: 'accepted',
            acceptedRevision: { headerVersion: 1, bodyVersion: 2 } } });
        expect(await db.discussionMessage.findUniqueOrThrow({ where: { id: proposalRef.messageId } }))
            .toMatchObject({ docEditProposalDispositionV1: { state: 'accepted' } });
        expect(await db.artifact.findUniqueOrThrow({ where: { id: f.doc.ref.artifactId } })).toMatchObject({ bodyVersion: 2 });
        expect(await decideArtifactEditProposal({ actorAccountId: f.owner.id, authentication, proposalRef, decision: 'decline' }))
            .toMatchObject({ ok: true, disposition: { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 } } });
        const wrongThread = await decideArtifactEditProposal({ actorAccountId: f.owner.id, authentication,
            proposalRef: { ...proposalRef, discussion: { ...proposalRef.discussion, discussionId: crypto.randomUUID() } }, decision: 'decline' });
        expect(wrongThread).toMatchObject({ ok: false });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await decideArtifactEditProposal({ actorAccountId: foreign.id, authentication, proposalRef, decision: 'decline' }))
            .toMatchObject({ ok: false });
        expect(await db.discussionMessage.findUniqueOrThrow({ where: { id: proposalRef.messageId } }))
            .toMatchObject({ docEditProposalDispositionV1: { state: 'accepted' } });
    });

    it.each(['plain', 'e2ee'] as const)('applies %s host-prepared bytes once, then second-client and original-propose retries see the settled revision', async mode => {
        const f = await fixture(mode);
        if (mode === 'e2ee') {
            expect(JSON.stringify(f.packet)).not.toContain('again');
            expect(await decideArtifactEditProposal({ actorAccountId: f.owner.id, authentication, proposalRef: f.proposalRef,
                expectedRevision: f.doc.revision, decision: 'accept' })).toEqual({ ok: false, error: 'doc_edit_proposal_preparation_required' });
            const preparation = f.packet.preparation;
            if (!preparation) throw new Error('Expected prepared E2EE packet');
            expect(await decideArtifactEditProposal({ actorAccountId: f.owner.id, authentication, decision: 'accept', ...f.packet,
                preparation: { ...preparation, doc: { ...preparation.doc, ref: { ...preparation.doc.ref, artifactId: crypto.randomUUID() } } } }))
                .toEqual({ ok: false, error: 'doc_edit_proposal_invalid' });
            expect(await decideArtifactEditProposal({ actorAccountId: f.owner.id, authentication, decision: 'accept', ...f.packet,
                preparation: { ...preparation, body: encodePlainArtifactStoredContent({ body: 'A plain-mode replacement' }) } }))
                .toMatchObject({ ok: false, error: 'invalid-params' });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: f.doc.ref.artifactId } })).toMatchObject({ bodyVersion: 1 });
            expect(await db.discussionMessage.findUniqueOrThrow({ where: { id: f.proposalRef.messageId } }))
                .toMatchObject({ docEditProposalDispositionV1: { state: 'open' } });
        }
        const result = await decideArtifactEditProposal({ actorAccountId: f.owner.id, authentication, decision: 'accept', ...f.packet });
        expect(result).toMatchObject({ ok: true, disposition: { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 } } });
        const current = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: f.owner.id, artifactId: f.doc.ref.artifactId }));
        if (!current.ok) throw new Error(current.error);
        expect(f.openArtifact(current.artifact.body)).toEqual({ body: 'again / **again**!' });
        const rejoin = await decideArtifactEditProposal({ actorAccountId: f.owner.id, authentication, decision: 'accept',
            proposalRef: f.proposalRef, expectedRevision: f.doc.revision });
        expect(rejoin).toMatchObject(result.ok ? { ok: true, disposition: result.disposition } : { ok: true });
        const retryRequest = { ...f.request, firstMessage: { ...f.request.firstMessage,
            content: sealSessionStoredContent({ ...f.cryptoContext, payload: f.content }) } };
        expect(await createDiscussion({ actorAccountId: f.owner.id, authentication, request: retryRequest })).toMatchObject({ ok: true,
            value: { firstMessage: { id: f.proposalRef.messageId, docEditProposalDispositionV1: { state: 'accepted' } } } });
        expect(await db.artifactRevision.count({ where: { artifactId: f.doc.ref.artifactId } })).toBe(1);
        const second = await inTx(tx => readDiscussionMessageInTx(tx, { actorAccountId: f.owner.id, authentication,
            discussionId: f.proposalRef.discussion.discussionId, messageId: f.proposalRef.messageId }));
        expect(second).toMatchObject({ ok: true, value: { docEditProposalDispositionV1: { state: 'accepted' } } });
    });

    it('accepts a plain Discussion proposal for an E2EE Doc through the admitted host Artifact codec', async () => {
        const f = await fixture('e2ee');
        const discussionOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(f.owner.id, discussionOwner.id);
        await makeShareEligibleForTest(discussionOwner.id, f.owner.id);
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: f.owner.id, artifactId: f.doc.ref.artifactId,
            principal: { kind: 'account', accountId: discussionOwner.id }, accessLevel: 'view' }))).toMatchObject({ ok: true });
        const greeting = DiscussionMessageContentV1Schema.parse({ v: 1, parts: [{ t: 'text', text: 'Review this Doc' }] });
        const discussion = await createDiscussion({ actorAccountId: discussionOwner.id, authentication,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
                participants: [{ kind: 'account', accountId: f.owner.id }], titleContent: { t: 'plain', v: { v: 1, title: 'Plain review' } },
                firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: greeting }, authoredContent: greeting, mentionedAccountIds: [] } }) });
        if (!discussion.ok) throw new Error(discussion.error);
        const request = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(),
            content: { t: 'plain', v: f.content }, authoredContent: f.content, mentionedAccountIds: [],
            replyTarget: { kind: 'doc_passage', doc: f.doc } });
        const posted = await postDiscussionMessage({ actorAccountId: f.owner.id, authentication,
            discussionId: discussion.value.discussion.id, request });
        if (!posted.ok) throw new Error(posted.error);
        const proposalRef = createDiscussionMessageRefV1({ serverId: 'home', discussionId: discussion.value.discussion.id }, posted.value.message);
        const opened = DiscussionOpenedMessageV1Schema.parse({ ...posted.value.message, messageRef: proposalRef, content: f.content });
        const prepared = prepareDocEditAcceptanceV1({ proposalRef, expectedRevision: f.doc.revision, message: opened, artifact: f.artifact });
        if (!prepared.preparation) throw new Error('Expected encrypted Doc preparation');
        const packet = DocEditAcceptTransportInputV1Schema.parse({ ...prepared, preparation: { ...prepared.preparation,
            body: privacyKit.encodeBase64(new Uint8Array(f.encodeArtifact({ body: prepared.preparation.body }))) } });
        expect(await decideArtifactEditProposal({ actorAccountId: f.owner.id, authentication, proposalRef,
            decision: 'accept', expectedRevision: f.doc.revision })).toEqual({ ok: false, error: 'doc_edit_proposal_preparation_required' });
        expect(await decideArtifactEditProposal({ actorAccountId: f.owner.id, authentication, proposalRef,
            decision: 'accept', expectedRevision: { headerVersion: 1, bodyVersion: 2 } })).toEqual({ ok: false, error: 'version-mismatch' });
        const accepted = await decideArtifactEditProposal({ actorAccountId: f.owner.id, authentication, decision: 'accept', ...packet });
        expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, artifactId: f.doc.ref.artifactId,
            disposition: { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 } } });
        const current = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: f.owner.id, artifactId: f.doc.ref.artifactId }));
        if (!current.ok) throw new Error(current.error);
        expect(f.openArtifact(current.artifact.body)).toEqual({ body: 'again / **again**!' });
        expect(await postDiscussionMessage({ actorAccountId: f.owner.id, authentication, discussionId: discussion.value.discussion.id, request }))
            .toMatchObject({ ok: true, value: { message: { id: proposalRef.messageId, docEditProposalDispositionV1: { state: 'accepted' } } } });
        expect(await db.artifactRevision.count({ where: { artifactId: f.doc.ref.artifactId } })).toBe(1);
    });

    it('declines opaque E2EE proposals without body preparation, but fails closed after recipient key rotation', async () => {
        const f = await fixture('e2ee');
        const editorKeys = tweetnacl.box.keyPair();
        const editor = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(editorKeys.publicKey) } });
        const recipientContentPublicKeyFingerprint = computeContentPublicKeyFingerprint(editorKeys.publicKey);
        const envelope = (dataKey: Uint8Array) => sealEncryptedDataKeyEnvelopeV1({ dataKey,
            recipientPublicKey: editorKeys.publicKey, randomBytes: tweetnacl.randomBytes });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: f.doc.ref.artifactId, accountId: editor.id, accessLevel: 'edit', createdByAccountId: f.owner.id } });
        await db.artifactKeyEnvelope.create({ data: { artifactId: f.doc.ref.artifactId, recipientAccountId: editor.id,
            recipientContentPublicKeyFingerprint, encryptedDataKey: envelope(f.docKey) } });
        await db.discussionGrant.create({ data: { principalKind: 'account', discussionId: f.proposalRef.discussion.discussionId, accountId: editor.id,
            accessLevel: 'view', createdByAccountId: f.owner.id } });
        await db.discussionKeyEnvelope.create({ data: { discussionId: f.proposalRef.discussion.discussionId, recipientAccountId: editor.id,
            recipientContentPublicKeyFingerprint, encryptedDataKey: envelope(f.discussionKey) } });
        expect(await decideArtifactEditProposal({ actorAccountId: editor.id, authentication, proposalRef: f.proposalRef, decision: 'decline' }))
            .toMatchObject({ ok: true, disposition: { state: 'declined' } });
        expect(await db.artifact.findUniqueOrThrow({ where: { id: f.doc.ref.artifactId } })).toMatchObject({ bodyVersion: 1 });
        const rotated = tweetnacl.box.keyPair();
        await db.account.update({ where: { id: editor.id }, data: createSignedAccountContentBinding(rotated.publicKey) });
        expect(await decideArtifactEditProposal({ actorAccountId: editor.id, authentication, proposalRef: f.proposalRef, decision: 'decline' }))
            .toMatchObject({ ok: false });
        expect(await db.artifactRevision.count({ where: { artifactId: f.doc.ref.artifactId } })).toBe(0);
    });
});
