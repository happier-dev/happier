import { afterAll, beforeAll, expect, it } from 'vitest';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { readReviewCommentChangesHintV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSqlReviewCommentStore } from './store';
import { createReviewCommentOperations } from './operations';
import { inReadSnapshot } from '@/storage/inTx';
import { readReviewHistoryInTx } from '@/app/reviews/reviewListService';
import { ReviewHistoryRequestV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';
import { resolveReviewAccessInTx } from '@/app/reviews/reviewAccess';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'review-bound-storage-', initAuth: false });
}, 120_000);
afterAll(async () => { await harness?.close(); });

it('reloads a human comment and its reply in their Review round without inventing engine appearances', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const review = await db.artifact.create({ data: { id: 'human-round-review', accountId: owner.id,
        header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
    const store = createSqlReviewCommentStore();
    let id = 0;
    const operations = createReviewCommentOperations(store, { now: () => 1000, createId: prefix => `${prefix}-human-${++id}` });
    const principal = { accountId: owner.id, actor: { kind: 'user' as const, userId: owner.id },
        reviewAccess: { reviewId: review.id, ownerAccountId: owner.id, level: 'admin' as const, encryptionMode: 'plain' as const } };
    const input = { reviewId: review.id, anchor: { kind: 'line' as const, filePath: 'a.ts', line: 2 },
        snapshot: { kind: 'none' as const, capturedAt: 1 }, body: 'Explain this change',
        authorIntent: 'open' as const, clientMutationId: 'human-control' };
    const control = await operations.create({ ...principal, input });
    expect((await operations.list({ ...principal, input: { reviewId: review.id, states: [], includeHistory: true, limit: 50 } })).items)
        .toMatchObject([{ id: control.comment.id }]);
    const created = await operations.create({ ...principal, input: { ...input, roundOrdinal: 2, clientMutationId: 'human-round' } });
    const reply = await operations.reply({ ...principal, input: { reviewId: review.id, parentCommentId: created.comment.id,
        expectedParentServerRevision: 1, body: 'Here is the reason', clientMutationId: 'human-reply' } });
    const reload = (roundOrdinal: number) => createReviewCommentOperations(createSqlReviewCommentStore()).list({ ...principal,
        input: { reviewId: review.id, roundOrdinal, states: [], includeHistory: true, limit: 50 } });
    expect((await reload(2)).items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: created.comment.id, roundOrdinal: 2, body: 'Explain this change' }),
        expect.objectContaining({ id: reply.comment.id, roundOrdinal: 2, body: 'Here is the reason' }),
    ]));
    expect((await reload(2)).items).toHaveLength(2);
    expect((await reload(1)).items).toEqual([]);
    expect(await store.listAppearances({ reviewId: review.id })).toEqual([]);
});

it('keeps publication plans private to the publishing Account across Review encryption modes', async () => {
    const publisher = await db.account.create({ data: { encryptionMode: 'plain' } });
    const encryptedOwner = await db.account.create({ data: { encryptionMode: 'e2ee' } });
    const store = createSqlReviewCommentStore();
    for (const owner of [publisher, encryptedOwner]) {
        const review = await db.artifact.create({ data: { id: `private-plan-${owner.id}`, accountId: owner.id, header: new Uint8Array(), body: new Uint8Array(),
            dataEncryptionKey: new Uint8Array(), reviewMetadata: { create: { subjectKind: 'comparison', sourceKind: 'direct',
                state: 'completed', currentRoundOrdinal: 1, startedAt: new Date(1) } } } });
        if (owner.id !== publisher.id) await db.artifactGrant.create({ data: { artifactId: review.id, principalKind: 'account',
            accountId: publisher.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        const commentId = `publication-${review.id}`;
        await db.$executeRaw`INSERT INTO review_comments (id, account_id, review_id, thread_id, state, flags_json,
            anchor_json, snapshot_envelope_json, body_envelope_json, body_version, author_json, edits_json,
            dispositions_json, transitions_json, server_revision, created_at, updated_at)
            VALUES (${commentId}, ${owner.id}, ${review.id}, ${commentId}, 'open', '{}', '{}', '{}', '{}', 1, '{}', '[]', '{}', '[]', 1, 1000, 1000)`;
        const reviewAccess = await resolveReviewAccessInTx(db, { actorAccountId: publisher.id, reviewId: review.id });
        expect(reviewAccess).not.toBeNull();
        const params = { accountId: publisher.id, reviewAccess: reviewAccess!, entries: [{ commentId, serverRevision: 1,
            publicationCorrelationId: `correlation-${review.id}` }], verdictPublicationCorrelationId: null,
            targetKey: 'github-target', storageMode: 'plain' as const, contentPublicKeyFingerprint: null,
            publicationPlanId: `plan-${review.id}`, dispatchToken: `dispatch-${review.id}`, createdAt: 1 };
        expect(await store.claimPublicationDispatch(params)).toMatchObject({ disposition: 'dispatch', publicationPlanId: params.publicationPlanId });
        expect(await db.reviewCommentPublicationCorrelation.findUniqueOrThrow({ where: {
            publicationCorrelationId: params.entries[0]!.publicationCorrelationId,
        } })).toMatchObject({ accountId: publisher.id, commentId });
        expect(await store.claimPublicationDispatch(params)).toMatchObject({ publicationPlanId: params.publicationPlanId });
    }
});

it('persists Review decisions and appearances and publishes only real changes to the Artifact audience', async () => {
    const ownerId = 'review-owner';
    const recipientId = 'review-recipient';
    const reviewId = 'bound-review';
    await db.account.createMany({ data: [ownerId, recipientId].map(id => ({ id, publicKey: id, encryptionMode: 'plain' })) });
    await db.artifact.create({ data: { id: reviewId, accountId: ownerId,
        kind: deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 }),
        header: Buffer.from('{}'), body: Buffer.from('{}'), dataEncryptionKey: Buffer.alloc(0) } });
    const grant = await db.artifactGrant.create({ data: { artifactId: reviewId, principalKind: 'account',
        accountId: recipientId, accessLevel: 'edit', createdByAccountId: ownerId } });
    const access = { reviewId, ownerAccountId: ownerId, level: 'admin' as const, encryptionMode: 'plain' as const };
    const principal = { accountId: ownerId, reviewAccess: access, actor: { kind: 'user' as const, userId: ownerId } };
    const store = createSqlReviewCommentStore();
    let now = 1000;
    let id = 0;
    const operations = createReviewCommentOperations(store, { now: () => now++, createId: prefix => `${prefix}-${++id}` });
    const input = { reviewId, findingIdentity: 'd'.repeat(64), anchor: { kind: 'file' as const, filePath: 'a.ts' },
        snapshot: { kind: 'none' as const, capturedAt: 1 }, body: 'Guard input', authorIntent: 'open' as const,
        appearance: { roundOrdinal: 1, runId: 'run-one', reviewerId: 'codex', machineId: 'machine-one', sessionId: 'session-one' },
        clientMutationId: 'first-appearance' };
    const created = await operations.create({ ...principal, input });
    const dismissed = await operations.transition({ ...principal, input: { reviewId, commentId: created.comment.id,
        expectedState: 'open', toState: 'dismissed', expectedServerRevision: 1, reviewTriageStatus: 'reject',
        reason: 'Not reachable', clientMutationId: 'decision' } });
    const laterInput = { ...input, appearance: { roundOrdinal: 2, runId: 'run-two', reviewerId: 'claude', machineId: 'machine-two', sessionId: 'session-two' },
        clientMutationId: 'second-appearance' };
    const laterPrincipal = { ...principal, accountId: recipientId, actor: { kind: 'user' as const, userId: recipientId } };
    const retained = await operations.create({ ...laterPrincipal, input: laterInput });
    expect(retained.comment).toMatchObject({ id: created.comment.id, state: 'dismissed', reviewTriageStatus: 'reject', serverRevision: dismissed.comment.serverRevision });
    const beforeReplay = await db.accountChange.findMany({ where: { kind: 'artifact', entityId: reviewId }, orderBy: { accountId: 'asc' } });
    expect(beforeReplay.map(row => row.accountId).sort()).toEqual([ownerId, recipientId].sort());
    for (const row of beforeReplay) expect(readReviewCommentChangesHintV1(row.hint)?.changes).toEqual([
        { commentId: created.comment.id, state: 'dismissed', serverRevision: 2, reviewTriageStatus: 'reject' },
    ]);
    await operations.create({ ...laterPrincipal, input: laterInput });
    expect(await db.accountChange.findMany({ where: { kind: 'artifact', entityId: reviewId }, orderBy: { accountId: 'asc' } })).toEqual(beforeReplay);
    expect(await store.listAppearances({ reviewId })).toHaveLength(2);
    const list = await operations.list({ ...laterPrincipal, input: { reviewId, runId: 'run-two', sessionId: 'session-two',
        states: [], includeHistory: true, limit: 50 } });
    expect(list.items).toMatchObject([{ id: created.comment.id, state: 'dismissed' }]);
    const guestInput = { ...laterInput, findingIdentity: 'e'.repeat(64), clientMutationId: 'guest-created-root' };
    const guest = await operations.create({ ...laterPrincipal, input: guestInput });
    expect(guest.comment).toMatchObject({ accountId: ownerId, author: { kind: 'user', userId: recipientId } });
    expect((await operations.create({ ...laterPrincipal, input: guestInput })).comment.id).toBe(guest.comment.id);
    const recipientBeforeRemoval = await db.accountChange.findUniqueOrThrow({ where: {
        accountId_kind_entityId: { accountId: recipientId, kind: 'artifact', entityId: reviewId },
    } });
    await db.artifactGrant.delete({ where: { id: grant.id } });
    await operations.transition({ ...principal, input: { reviewId, commentId: created.comment.id,
        expectedState: 'dismissed', toState: 'open', expectedServerRevision: 2, reviewTriageStatus: 'defer', clientMutationId: 'revisit' } });
    const recipientAfter = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: { accountId: recipientId, kind: 'artifact', entityId: reviewId } } });
    expect(recipientAfter).toEqual(recipientBeforeRemoval);
});

it('links only exact findings in authorized earlier Reviews with known shared project context', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const other = await db.account.create({ data: { encryptionMode: 'plain' } });
    const makeReview = async (id: string, at: number, projectSourceId: string | null, accountId = owner.id) => {
        await db.artifact.create({ data: { id, accountId, createdAt: new Date(at),
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
            reviewMetadata: { create: { projectSourceId, subjectKind: 'comparison', sourceKind: 'direct',
                state: 'completed', currentRoundOrdinal: 1, startedAt: new Date(at) } } } });
        return id;
    };
    const root = async (reviewId: string, findingIdentity = 'exact-identity', workspaceJson: string | null = null, accountId = owner.id) => {
        const id = `root-${reviewId}-${findingIdentity}`;
        await db.$executeRaw`INSERT INTO review_comments (id, account_id, review_id, finding_identity, workspace_json,
            thread_id, state, flags_json, anchor_json, snapshot_envelope_json, body_envelope_json, body_version,
            author_json, edits_json, dispositions_json, transitions_json, server_revision, created_at, updated_at)
            VALUES (${id}, ${accountId}, ${reviewId}, ${findingIdentity}, ${workspaceJson}, ${id}, 'dismissed', '{}', '{}', '{}', '{}', 1, '{}', '[]', '{}', '[]', 1, 1000, 1000)`;
        return id;
    };
    const current = await makeReview('seen-current', 5000, 'project-source');
    const earlier = await makeReview('seen-earlier', 1000, 'project-source', other.id);
    await db.artifactGrant.create({ data: { artifactId: earlier, principalKind: 'account', accountId: owner.id,
        accessLevel: 'view', createdByAccountId: other.id } });
    const expectedRoot = await root(earlier, 'exact-identity', null, other.id);
    await root(current);
    await root(await makeReview('seen-private', 500, 'project-source', other.id), 'exact-identity', null, other.id);
    await root(await makeReview('seen-unrelated', 600, 'other-project'));
    await root(await makeReview('seen-later', 6000, 'project-source'));
    await root(await makeReview('seen-other-identity', 700, 'project-source'), 'different-identity');
    const read = (reviewId: string) => inReadSnapshot(tx => readReviewHistoryInTx(tx, {
        ...ReviewHistoryRequestV1Schema.parse({ reviewId, findingIdentity: 'exact-identity' }), actorAccountId: owner.id,
    }));
    expect(await read(current)).toEqual({ matches: [{ reviewId: earlier, commentId: expectedRoot, createdAt: 1000 }] });
    expect(await read('seen-private')).toEqual({ matches: [] });
    const unknown = await makeReview('seen-unknown-context', 7000, null);
    await root(unknown);
    expect(await read(unknown)).toEqual({ matches: [] });
    const workspace = JSON.stringify({ machineId: 'machine-one', path: '/project' });
    const localCurrent = await makeReview('seen-local-current', 5000, null);
    const localEarlier = await makeReview('seen-local-earlier', 1000, null);
    await root(localCurrent, 'exact-identity', workspace);
    const localRoot = await root(localEarlier, 'exact-identity', workspace);
    await root(await makeReview('seen-local-unrelated', 700, null), 'exact-identity', JSON.stringify({ machineId: 'machine-two', path: '/project' }));
    expect(await read(localCurrent)).toEqual({ matches: [{ reviewId: localEarlier, commentId: localRoot, createdAt: 1000 }] });
});
