import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { getActivePrismaRuntime } from '@/storage/prisma';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion } from '@/app/discussions/mutations';
import { readDiscussionMessageInTx } from '@/app/discussions/queries';
import { readArtifactForCallerInTx } from './artifactAccessService';
import { createArtifact, updateArtifactTx } from './artifactWriteService';
import { decideArtifactEditProposalInTx } from './artifactEditProposalService';

const authentication = createPresentUserSessionAccessAuthentication();
const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));

describe('Doc proposal decision preparation (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-doc-proposal-', initEncrypt: true }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        expect(await createArtifact({ actorUserId: owner.id, artifactId: id, header: bytes({ title: 'Doc' }),
            body: bytes({ body: '😀 first again / again!' }), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) })).toMatchObject({ ok: true });
        const proposal = { target: { ref: { kind: 'doc' as const, artifactId: id, serverId: 'home' },
            revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 17, end: 22 }, quote: 'again' },
            baseRevision: { headerVersion: 1, bodyVersion: 1 }, before: 'again', after: '**again**', reason: 'Emphasize the second occurrence' };
        const content = { kind: 'doc_edit_proposal' as const, proposal };
        const request = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
                titleContent: { t: 'plain', v: { v: 1, title: 'Proposal' } }, firstMessage: { localId: crypto.randomUUID(),
                    content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [],
                    replyTarget: { kind: 'doc_passage', doc: { ref: proposal.target.ref, revision: proposal.baseRevision } } } });
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request });
        if (!created.ok) throw new Error(created.error);
        return { owner, id, request, proposalRef: createDiscussionMessageRefV1({ serverId: 'home', discussionId: created.value.discussion.id }, created.value.firstMessage) };
    }

    it('accepts the exact stored candidate once and rejoins the decision after a lost response and original propose retry', async () => {
        const { owner, id, request, proposalRef } = await fixture();
        const beforeChange = await db.accountChange.findFirstOrThrow({ where: {
            accountId: owner.id, kind: 'discussion', entityId: proposalRef.discussion.discussionId,
        } });
        const input = { actorAccountId: owner.id, authentication, proposalRef, expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
        const accepted = await inTx(tx => decideArtifactEditProposalInTx(tx, { ...input, decision: 'accept' }));
        expect(accepted).toMatchObject({ ok: true, disposition: { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 },
            decidedBy: { accountId: owner.id } } });
        const committedChange = await db.accountChange.findFirstOrThrow({ where: {
            accountId: owner.id, kind: 'discussion', entityId: proposalRef.discussion.discussionId,
        } });
        expect(committedChange.cursor).toBeGreaterThan(beforeChange.cursor);
        expect(committedChange.hint).toEqual({ v: 1, discussions: true });
        const again = await inTx(tx => decideArtifactEditProposalInTx(tx, { ...input, decision: 'accept' }));
        const opposite = await inTx(tx => decideArtifactEditProposalInTx(tx, { actorAccountId: owner.id, authentication, proposalRef, decision: 'decline' }));
        expect(again).toMatchObject(accepted.ok ? { ok: true, disposition: accepted.disposition } : { ok: true });
        expect(opposite).toMatchObject(accepted.ok ? { ok: true, disposition: accepted.disposition } : { ok: true });
        const retry = await createDiscussion({ actorAccountId: owner.id, authentication, request });
        expect(retry).toMatchObject({ ok: true, value: { firstMessage: { id: proposalRef.messageId, docEditProposalDispositionV1: { state: 'accepted' } } } });
        const secondClient = await inTx(tx => readDiscussionMessageInTx(tx, { actorAccountId: owner.id, authentication,
            discussionId: proposalRef.discussion.discussionId, messageId: proposalRef.messageId }));
        expect(secondClient).toMatchObject({ ok: true, value: { docEditProposalDispositionV1: { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 } } } });
        const current = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: owner.id, artifactId: id }));
        expect(current).toMatchObject({ ok: true, artifact: { bodyVersion: 2 } });
        if (!current.ok) throw new Error(current.error);
        expect(decodePlainArtifactStoredContent(privacyKit.encodeBase64(current.artifact.body))).toEqual({ body: '😀 first again / **again**!' });
        expect(await db.artifactRevision.count({ where: { artifactId: id } })).toBe(1);
    });

    it('refuses automation and a runtime principal even when the outer credential claims a present person', async () => {
        const { owner, proposalRef } = await fixture();
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, { actorAccountId: owner.id,
            authentication: { ...authentication, authority: 'account_automation' }, proposalRef, decision: 'accept',
            expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))).toEqual({ ok: false, error: 'doc_edit_proposal_present_person_required' });
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, { actorAccountId: owner.id, decision: 'accept',
            authentication: { ...authentication, sessionRuntimePrincipal: { kind: 'ephemeral_session_runner', authority: 'session_runtime',
                accountId: owner.id, activationId: crypto.randomUUID(), sessionId: 'runtime-session', machineId: 'machine',
                installationId: 'installation', installationPublicKey: 'public-key', creatorTokenEpoch: owner.tokenEpoch } },
            proposalRef, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))).toEqual({ ok: false, error: 'doc_edit_proposal_present_person_required' });
    });

    it.each(['body', 'header'] as const)('leaves the competing %s revision and open proposal unchanged on conflict', async field => {
        const { owner, id, proposalRef } = await fixture();
        const update = field === 'body' ? { body: { bytes: bytes({ body: 'A competing edit' }), expectedVersion: 1 } }
            : { header: { bytes: bytes({ title: 'A competing title' }), expectedVersion: 1 } };
        expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: owner.id, artifactId: id, ...update }))).toMatchObject({ ok: true });
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, { actorAccountId: owner.id, authentication, proposalRef,
            decision: 'accept', expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))).toMatchObject({ ok: false, error: 'version-mismatch' });
        expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject(field === 'body' ? { headerVersion: 1, bodyVersion: 2 } : { headerVersion: 2, bodyVersion: 1 });
        expect(await db.discussionMessage.findUniqueOrThrow({ where: { id: proposalRef.messageId } })).toMatchObject({ docEditProposalDispositionV1: { state: 'open' } });
    });

    it('declines without a body revision and retains the actual decision on opposite retry', async () => {
        const { owner, id, request, proposalRef } = await fixture();
        const beforeChange = await db.accountChange.findFirstOrThrow({ where: {
            accountId: owner.id, kind: 'discussion', entityId: proposalRef.discussion.discussionId,
        } });
        const declined = await inTx(tx => decideArtifactEditProposalInTx(tx, { actorAccountId: owner.id, authentication, proposalRef, decision: 'decline' }));
        expect(declined).toMatchObject({ ok: true, disposition: { state: 'declined', decidedBy: { accountId: owner.id } } });
        const committedChange = await db.accountChange.findFirstOrThrow({ where: {
            accountId: owner.id, kind: 'discussion', entityId: proposalRef.discussion.discussionId,
        } });
        expect(committedChange.cursor).toBeGreaterThan(beforeChange.cursor);
        expect(committedChange.hint).toEqual({ v: 1, discussions: true });
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, { actorAccountId: owner.id, authentication, proposalRef,
            decision: 'accept', expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))).toEqual(declined);
        expect(await createDiscussion({ actorAccountId: owner.id, authentication, request })).toMatchObject({ ok: true,
            value: { firstMessage: { id: proposalRef.messageId, docEditProposalDispositionV1: { state: 'declined' } } } });
        expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ bodyVersion: 1 });
        expect(await db.artifactRevision.count({ where: { artifactId: id } })).toBe(0);
    });

    it('never treats a missing persisted disposition as an open proposal', async () => {
        const { owner, id, proposalRef } = await fixture();
        await db.discussionMessage.update({ where: { id: proposalRef.messageId },
            data: { docEditProposalDispositionV1: getActivePrismaRuntime().DbNull } });
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, { actorAccountId: owner.id, authentication, proposalRef,
            decision: 'accept', expectedRevision: { headerVersion: 1, bodyVersion: 1 } })))
            .toEqual({ ok: false, error: 'doc_edit_proposal_disposition_unavailable' });
        expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ bodyVersion: 1 });
        expect(await db.artifactRevision.count({ where: { artifactId: id } })).toBe(0);
    });

    it('refuses caller-supplied plain replacement bytes that differ from the stored candidate', async () => {
        const { owner, id, proposalRef } = await fixture();
        const result = await inTx(tx => decideArtifactEditProposalInTx(tx, { actorAccountId: owner.id, authentication, proposalRef,
            decision: 'accept', expectedRevision: { headerVersion: 1, bodyVersion: 1 }, preparation: {
                doc: { ref: { kind: 'doc', artifactId: id, serverId: 'home' }, revision: { headerVersion: 1, bodyVersion: 1 } },
                body: encodePlainArtifactStoredContent({ body: 'Unreviewed replacement' }),
            } }));
        expect(result).toEqual({ ok: false, error: 'doc_edit_proposal_invalid' });
        expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ bodyVersion: 1 });
        expect(await db.discussionMessage.findUniqueOrThrow({ where: { id: proposalRef.messageId } })).toMatchObject({ docEditProposalDispositionV1: { state: 'open' } });
    });

    it('settles concurrent Accept and Decline once and every retry returns that deciding person', async () => {
        const { owner, id, proposalRef } = await fixture();
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: id, accountId: other.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        await db.discussionGrant.create({ data: { principalKind: 'account', discussionId: proposalRef.discussion.discussionId, accountId: other.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const results = await Promise.all([
            inTx(tx => decideArtifactEditProposalInTx(tx, { actorAccountId: owner.id, authentication, proposalRef,
                decision: 'accept', expectedRevision: { headerVersion: 1, bodyVersion: 1 } })),
            inTx(tx => decideArtifactEditProposalInTx(tx, { actorAccountId: other.id, authentication, proposalRef, decision: 'decline' })),
        ]);
        expect(results[0]).toMatchObject({ ok: true });
        expect(results[1]).toMatchObject({ ok: true });
        if (!results[0].ok || !results[1].ok) throw new Error('Both decision calls must reconcile');
        expect(results[1].disposition).toEqual(results[0].disposition);
        const accepted = results[0].disposition.state === 'accepted';
        expect(results[0].disposition.decidedBy.accountId).toBe(accepted ? owner.id : other.id);
        expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ bodyVersion: accepted ? 2 : 1 });
        expect(await db.artifactRevision.count({ where: { artifactId: id } })).toBe(accepted ? 1 : 0);
    });

    it('readmits Doc edit and thread/credential authority even for an already settled proposal', async () => {
        const { owner, id, proposalRef } = await fixture();
        const editor = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: id, accountId: editor.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const input = { actorAccountId: editor.id, authentication, proposalRef, decision: 'decline' as const };
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, input))).toMatchObject({ ok: false, error: 'discussion_not_found' });
        await db.discussionGrant.create({ data: { principalKind: 'account', discussionId: proposalRef.discussion.discussionId, accountId: editor.id, accessLevel: 'view', createdByAccountId: owner.id } });
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, input))).toMatchObject({ ok: false, error: 'doc_edit_proposal_edit_access_required' });
        await db.artifactGrant.update({ where: { principalKind: 'account', artifactId_accountId: { artifactId: id, accountId: editor.id } }, data: { accessLevel: 'edit' } });
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, input))).toMatchObject({ ok: true });
        await db.artifactGrant.update({ where: { principalKind: 'account', artifactId_accountId: { artifactId: id, accountId: editor.id } }, data: { accessLevel: 'view' } });
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, input))).toMatchObject({ ok: false, error: 'doc_edit_proposal_edit_access_required' });
        await db.artifactGrant.update({ where: { principalKind: 'account', artifactId_accountId: { artifactId: id, accountId: editor.id } }, data: { accessLevel: 'edit' } });
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, { ...input, authentication: { ...authentication, tokenEpoch: editor.tokenEpoch + 1 } })))
            .toMatchObject({ ok: false, error: 'discussion_not_found' });
        await db.artifactGrant.delete({ where: { principalKind: 'account', artifactId_accountId: { artifactId: id, accountId: editor.id } } });
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, input))).toMatchObject({ ok: false });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: id, accountId: editor.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        await db.discussionGrant.delete({ where: { principalKind: 'account', discussionId_accountId: { discussionId: proposalRef.discussion.discussionId, accountId: editor.id } } });
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, input))).toMatchObject({ ok: false, error: 'discussion_not_found' });
        expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ bodyVersion: 1 });
    });

    it('keeps structured content outside passage acceptance', async () => {
        const structured = await fixture();
        expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: structured.owner.id, artifactId: structured.id,
            header: { bytes: bytes({ title: 'Memory', kind: 'memory_doc.v1' }), expectedVersion: 1 } }))).toMatchObject({ ok: true });
        expect(await inTx(tx => decideArtifactEditProposalInTx(tx, { actorAccountId: structured.owner.id, authentication, decision: 'accept',
            proposalRef: structured.proposalRef, expectedRevision: { headerVersion: 1, bodyVersion: 1 } })))
            .toEqual({ ok: false, error: 'doc_edit_proposal_prose_required' });
    });
});
