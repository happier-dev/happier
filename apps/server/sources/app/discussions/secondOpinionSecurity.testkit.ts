import { expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { setArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDiscussion, postDiscussionMessage } from './mutations';
import { setDiscussionGrant } from './accessService';
import { readDiscussionMessages, listDiscussions, readDiscussionMessageInTx } from './queries';
import { previewDiscussionSecondOpinion } from './secondOpinion';

const authentication = createPresentUserSessionAccessAuthentication();
const document = (text: string) => ({ v: 1 as const, parts: [{ t: 'text' as const, text }] });

export async function createSecondOpinionSourceFixture() {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
    await makeShareEligibleForTest(owner.id, reader.id);
    const source = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
    const answer = await db.sessionMessage.create({ data: { sessionId: source.id, seq: 1, messageRole: 'agent', content: { t: 'plain', v: { text: 'Private answer' } } } });
    const request = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
        anchor: { kind: 'session', sessionId: source.id, messageId: answer.id },
        titleContent: { t: 'plain', v: { v: 1, title: 'Second opinion' } },
        firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: document('Private answer') }, authoredContent: document('Private answer'), mentionedAccountIds: [] },
        participants: [{ kind: 'account', accountId: reader.id }] });
    return { owner, reader, source, answer, request };
}

/** Same real-owner security contracts run against SQLite and disposable PostgreSQL. */
export function discussionSecondOpinionSecurityContracts() {
    const fixture = createSecondOpinionSourceFixture;
    it('withholds a Session quote and its replies from a later Team member but retains independent chat', async () => {
        const { owner, reader, source, request } = await fixture();
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: source.id, createdByAccountId: owner.id, accountId: reader.id, accessLevel: 'view' } });
        const team = await db.team.create({ data: { name: 'Quoted source readers' } });
        await db.teamMembership.createMany({ data: [owner.id, reader.id].map(accountId => ({ teamId: team.id, accountId, role: 'member' })) });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await setDiscussionGrant({ authentication, actorAccountId: owner.id, discussionId,
            request: { principal: { kind: 'team', teamId: team.id }, accessLevel: 'view' } })).toMatchObject({ ok: true });
        const reply = document('Reply containing the protected answer');
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(),
                content: { t: 'plain', v: reply }, authoredContent: reply, mentionedAccountIds: [],
                replyTarget: { kind: 'message', messageId: created.value.firstMessage.id } }) })).toMatchObject({ ok: true });
        const later = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: later.id, role: 'member' } });
        expect(await readDiscussionMessages({ authentication, actorAccountId: later.id, discussionId }))
            .toMatchObject({ ok: true, value: { messages: [] } });
        expect(await inTx(tx => readDiscussionMessageInTx(tx, { authentication, actorAccountId: later.id, discussionId,
            messageId: created.value.firstMessage.id }))).toEqual({ ok: false, error: 'discussion_content_unavailable' });
        const listed = await listDiscussions({ authentication, actorAccountId: later.id, anchorSessionId: source.id });
        expect(listed).toMatchObject({ ok: true, value: { discussions: [{ id: discussionId }] } });
        if (!listed.ok) throw new Error(listed.error);
        expect(listed.value.discussions[0]!.latestMessage).not.toHaveProperty('content');
        expect(await readDiscussionMessages({ authentication, actorAccountId: reader.id, discussionId }))
            .toMatchObject({ ok: true, value: { messages: [{ id: created.value.firstMessage.id }, { seq: 2 }] } });
        const chat = document('Independent Discussion chat');
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(),
                content: { t: 'plain', v: chat }, authoredContent: chat, mentionedAccountIds: [] }) })).toMatchObject({ ok: true });
        expect(await readDiscussionMessages({ authentication, actorAccountId: later.id, discussionId }))
            .toMatchObject({ ok: true, value: { messages: [{ seq: 3 }] } });
    });
    it.each(['session', 'doc_passage'] as const)('keeps the %s source roster private to managers', async kind => {
        const { owner, reader, source, answer } = await fixture();
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, other.id);
        await db.sessionGrant.createMany({ data: ([reader.id, other.id].map(accountId => ({
            sessionId: source.id, createdByAccountId: owner.id, accountId, accessLevel: 'view',
        }))).map(data => ({ ...data, principalKind: 'account' })) });
        const sessionSource = { kind: 'session' as const, message: { kind: 'session' as const,
            session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } };
        const artifact = kind === 'doc_passage' ? await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'markdown', title: 'Private Doc' })),
            body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Private quote' })),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) }) : null;
        if (artifact && !artifact.ok) throw new Error(artifact.error);
        if (artifact?.ok) for (const accountId of [reader.id, other.id]) {
            expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: artifact.artifact.id,
                principal: { kind: 'account', accountId }, accessLevel: 'view' }))).toMatchObject({ ok: true });
        }
        const request = { source: artifact?.ok ? { kind: 'doc_passage' as const, doc: {
            ref: { kind: 'doc' as const, serverId: 'home', artifactId: artifact.artifact.id },
            revision: { headerVersion: artifact.artifact.headerVersion, bodyVersion: artifact.artifact.bodyVersion },
        } } : sessionSource, reviewers: [] };
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: reader.id, request }))
            .toMatchObject({ ok: true, value: { sourceAudienceAccountIds: [], sourceContentReady: true } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { sourceAudienceAccountIds: expect.arrayContaining([owner.id, reader.id, other.id]) } });
    });
    it('uses Artifact grant eligibility for the reviewer runtime, including an inactive owner', async () => {
        const { owner, reader } = await fixture();
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'markdown', title: 'Source Doc' })),
            body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Private Doc quote' })),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const artifactId = artifact.artifact.id;
        const reviewer = await db.session.create({ data: { accountId: reader.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: reviewer.id, createdByAccountId: reader.id, accountId: owner.id, accessLevel: 'edit' } });
        const request = { source: { kind: 'doc_passage' as const, doc: { ref: { kind: 'doc' as const, serverId: 'home', artifactId },
            revision: { headerVersion: artifact.artifact.headerVersion, bodyVersion: artifact.artifact.bodyVersion } } },
            reviewers: [{ sourceAccess: 'read' as const, selection: { kind: 'session' as const, session: { serverId: 'home', sessionId: reviewer.id } } }] };
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { reviewers: [{ canGrantSource: true, missingSourceAccountIds: [reader.id] }] } });
        await db.account.update({ where: { id: reader.id }, data: { status: 'disabled' } });
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId,
            principal: { kind: 'account', accountId: reader.id }, accessLevel: 'view' })))
            .toEqual({ ok: false, error: 'artifact_subject_ineligible' });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { reviewers: [{ canGrantSource: false, missingSourceAccountIds: [reader.id] }] } });
        expect(await db.artifactGrant.count({ where: { artifactId, principalKind: 'account' } })).toBe(0);
    });
}
