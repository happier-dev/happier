import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { serializeFollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { observePendingSessionFollowForDestinationInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { inviteDiscussionParticipant } from './accessService';
import { createDiscussion, postDiscussionMessage } from './mutations';

const authentication = createPresentUserSessionAccessAuthentication();
const content = { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: 'Update' }] } };

/** Real append → committed Account changes → Follow observation, on each disposable DB provider. */
export function discussionFollowPublicationCostContracts(): void {
    it.each([1, 1_000])('publishes only changed Follow destinations with %i uninvolved attachments', async count => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        try {
            const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
                creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Publication demand' } },
                firstMessage: { localId: randomUUID(), content, mentionedAccountIds: [] },
            } });
            if (!created.ok) throw new Error(created.error);
            const discussionId = created.value.discussion.id;
            const input = { authentication, actorAccountId: owner.id, discussionId };
            const session = () => db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
            } });
            const target = await session();
            const reader = await session();
            for (const [sessionId, answerPolicy] of [[target.id, 'when_addressed'], [reader.id, 'reads_only']] as const) {
                expect(await inviteDiscussionParticipant({ ...input, request: {
                    participant: { kind: 'session', sessionId }, answerPolicy,
                } })).toMatchObject({ ok: true });
            }
            // Scale only the existing persisted attachment fixture; append,
            // addressing, publication, recipient admission and observation stay real.
            const unrelatedIds = Array.from({ length: count }, () => randomUUID());
            await db.session.createMany({ data: unrelatedIds.map(id => ({
                id, accountId: owner.id, tag: id, encryptionMode: 'plain', metadata: '{}',
            })) });
            await db.discussionParticipant.createMany({ data: unrelatedIds.map(sessionId => ({
                discussionId, sessionId, participantSlotId: sessionId, answerPolicy: 'when_addressed',
            })) });
            await db.sessionFollowEdge.createMany({ data: unrelatedIds.map(destinationSessionId => ({
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'discussion', discussionId }),
                sourceDiscussionId: discussionId, destinationSessionId,
                policyJson: serializeFollowPolicyV1({ preset: 'important' }), deliveredTranscriptSeq: 1,
            })) });
            const observe = (destinationSessionId: string) => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication },
                destinationSessionId,
            }));
            const measure = async (request: Parameters<typeof postDiscussionMessage>[0]['request'], changedSessionIds: string[], retry = false) => {
                const before = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
                const beforeChanges = await db.accountChange.findMany({ where: { accountId: owner.id, kind: 'session' } });
                const posted = await postDiscussionMessage({ ...input, request });
                expect(posted).toMatchObject({ ok: true });
                const after = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
                const afterChanges = await db.accountChange.findMany({ where: { accountId: owner.id, kind: 'session' } });
                const baseline = new Map(beforeChanges.map(row => [row.entityId, row]));
                const changed = afterChanges.filter(row => row.cursor !== baseline.get(row.entityId)?.cursor);
                const publications = after.seq - before.seq;
                console.info('DISCUSSION_FOLLOW_PUBLICATION_COST', JSON.stringify({ unrelatedAttachments: count,
                    publications, changedDestinations: changed.length, retry }));
                // One real Discussion publication plus each changed destination;
                // a retry publishes neither, independent of attachment inventory.
                expect(publications).toBe(retry ? 0 : 1 + changedSessionIds.length);
                expect(changed.map(row => row.entityId).sort()).toEqual([...changedSessionIds].sort());
                for (const row of afterChanges) {
                    if (!changedSessionIds.includes(row.entityId)) expect(row).toEqual(baseline.get(row.entityId));
                }
                if (!posted.ok) throw new Error(posted.error);
                return posted.value.message;
            };
            const request = () => ({ localId: randomUUID(), content, mentionedAccountIds: [] });
            await measure(request(), []);
            expect((await observe(target.id)).observations).toEqual([]);

            const watcher = await session();
            expect(await inviteDiscussionParticipant({ ...input, request: {
                participant: { kind: 'session', sessionId: watcher.id }, answerPolicy: 'watches_and_speaks_up',
            } })).toMatchObject({ ok: true });
            const watched = await measure(request(), [watcher.id]);
            expect((await observe(watcher.id)).observations).toContainEqual(expect.objectContaining({
                destinationSessionId: watcher.id, event: { kind: 'person_wrote' },
                addressing: { discussionId, messageId: watched.id, throughSeq: watched.seq, participantSessionId: watcher.id },
            }));
            const addressedRequest = { ...request(), mentionedSessionIds: [target.id, reader.id],
                content: { t: 'plain' as const, v: { v: 1, parts: [target.id, reader.id].map(sessionId => ({
                    t: 'mention', participant: { kind: 'session', sessionId },
                })) } } };
            const addressed = await measure(addressedRequest, [target.id, watcher.id]);
            expect(addressed.addressingV1?.participantSessionIds).toEqual([target.id, watcher.id].sort());
            expect((await observe(target.id)).observations).toContainEqual(expect.objectContaining({
                destinationSessionId: target.id, event: { kind: 'needs_you', type: 'decision', mode: 'wait' },
                addressing: { discussionId, messageId: addressed.id, throughSeq: addressed.seq, participantSessionId: target.id },
            }));
            expect((await observe(reader.id)).observations).toEqual([]);
            expect((await observe(unrelatedIds[0]!)).observations).toEqual([]);
            await measure(addressedRequest, [], true);
        } finally {
            await db.discussion.deleteMany({ where: { ownerAccountId: owner.id } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
}
