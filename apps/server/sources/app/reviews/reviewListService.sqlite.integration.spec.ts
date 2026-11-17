import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { listReviewsInTx, readReviewHistoryInTx, readAdmittedReviewDetailInTx } from './reviewListService';

describe('Review metadata demand', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => { harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-review-list-' }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('finds sparse matches before LIMIT, includes clean Reviews and binds tied continuation to its filter', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const older = new Date('2026-01-01');
        const make = async (projectSourceId: string, at: Date) => {
            const artifactId = randomUUID();
            await db.artifact.create({ data: { id: artifactId, accountId: owner.id, header: new Uint8Array(), body: new Uint8Array(),
                dataEncryptionKey: new Uint8Array(), updatedAt: at } });
            await db.$executeRaw`INSERT INTO "ReviewMetadata" ("artifactId", "projectSourceId", "subjectKind", "sourceKind", "state", "currentRoundOrdinal", "startedAt")
                VALUES (${artifactId}, ${projectSourceId}, 'comparison', 'direct', 'completed', 1, ${at})`;
            return artifactId;
        };
        const matches = [await make('selected', older), await make('selected', older)].sort().reverse();
        for (let i = 0; i < 12; i++) await make('other', new Date());
        const input = { actorAccountId: owner.id, projectSourceId: 'selected', limit: 1 };
        const first = await inTx(tx => listReviewsInTx(tx, input));
        expect(first.items.map(row => row.reviewId)).toEqual(matches.slice(0, 1));
        expect(first.items[0]?.counts).toEqual({ total: 0, needsDecision: 0 });
        expect(first.cursor).toBeTypeOf('string');
        const second = await inTx(tx => listReviewsInTx(tx, { ...input, cursor: first.cursor! }));
        expect(second.items.map(row => row.reviewId)).toEqual(matches.slice(1));
        await expect(inTx(tx => listReviewsInTx(tx, { ...input, projectSourceId: 'other', cursor: first.cursor! })))
            .rejects.toMatchObject({ code: 'review_comment_invalid_filter' });
        for (const cursor of ['not-json', Buffer.from(JSON.stringify({ id: matches[0], updatedAt: Number.MAX_VALUE, filters: { projectSourceId: 'selected' } })).toString('base64url')]) {
            await expect(inTx(tx => listReviewsInTx(tx, { ...input, cursor })))
                .rejects.toMatchObject({ code: 'review_comment_invalid_filter' });
        }
        const spaceId = randomUUID();
        const manual = await make('other', new Date(older.getTime() - 1000));
        await db.resourceSpaceMembership.create({ data: { accountId: owner.id, spaceId, resourceKind: 'artifact', resourceId: manual } });
        const manualPage = await inTx(tx => listReviewsInTx(tx, { ...input, spaceId, spaceMembershipMode: 'manual_only' }));
        expect(manualPage.items.map(row => row.reviewId)).toEqual([manual]);
        expect(manualPage.cursor).toBeNull();
        const combined = await inTx(tx => listReviewsInTx(tx, { ...input, spaceId, spaceMembershipMode: 'filter_or_manual', limit: 3 }));
        expect(combined.items.map(row => row.reviewId)).toEqual([...matches, manual]);
        const otherOrganizer = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.resourceSpaceMembership.create({ data: { accountId: otherOrganizer.id, spaceId, resourceKind: 'artifact', resourceId: matches[0]! } });
        const personal = await inTx(tx => listReviewsInTx(tx, { ...input, spaceId, spaceMembershipMode: 'manual_only' }));
        expect(personal.items.map(row => row.reviewId)).toEqual([manual]);
        expect(await inTx(tx => readReviewHistoryInTx(tx, { actorAccountId: owner.id, workflowId: 'absent', reviewId: matches[0]! })))
            .toEqual({ previousReviewId: null, items: [] });
    });

    it('groups only authorized workflow history and never imports a decision from another Review', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const workflowId = randomUUID();
        const make = async (accountId: string, sequence: number, workflow = workflowId) => {
            const id = randomUUID();
            const at = new Date(sequence * 1000);
            await db.artifact.create({ data: { id, accountId, header: new Uint8Array(), body: new Uint8Array(),
                dataEncryptionKey: new Uint8Array(), createdAt: at, updatedAt: at } });
            await db.$executeRaw`INSERT INTO "ReviewMetadata" ("artifactId", "projectSourceId", "workflowId", "subjectKind", "sourceKind", "state", "currentRoundOrdinal", "startedAt")
                VALUES (${id}, NULL, ${workflow}, 'repository', 'workflow', 'completed', 1, ${at})`;
            return id;
        };
        const earlier = await make(owner.id, 1);
        const previous = await make(owner.id, 2);
        const current = await make(owner.id, 3);
        const privateReview = await make(outsider.id, 0);
        const unrelated = await make(owner.id, 0, randomUUID());
        const root = async (reviewId: string, accountId: string, decision: string | null) => {
            const id = randomUUID();
            await db.$executeRaw`INSERT INTO review_comments (id, account_id, review_id, finding_identity, review_triage_status,
                thread_id, state, flags_json, anchor_json, snapshot_envelope_json, body_envelope_json, body_version,
                author_json, edits_json, dispositions_json, transitions_json, server_revision, created_at, updated_at)
                VALUES (${id}, ${accountId}, ${reviewId}, 'same-identity', ${decision}, ${id}, 'open', '{}', '{}', '{}', '{}', 1, '{}', '[]', '{}', '[]', 1, 1000, 1000)`;
            return id;
        };
        const firstRoot = await root(earlier, owner.id, 'reject');
        const priorRoot = await root(previous, owner.id, 'accept');
        const currentRoot = await root(current, owner.id, null);
        await root(privateReview, outsider.id, null);
        await root(unrelated, owner.id, null);
        for (const [reviewId, commentId, roundOrdinal, runId, reviewerId] of [
            [earlier, firstRoot, 1, 'early-run', 'engine-a'],
            [previous, priorRoot, 1, 'prior-run', 'engine-a'],
            [previous, priorRoot, 1, 'prior-run', 'engine-b'],
            [previous, priorRoot, 2, 'second-round-run', 'engine-a'],
            [current, currentRoot, 1, 'current-run', 'engine-a'],
        ] as const) {
            await db.reviewCommentAppearance.create({ data: { reviewId, commentId, roundOrdinal, runId, reviewerId,
                sourceKey: `${runId}-${reviewerId}`, machineId: 'machine-one', sessionId: 'session-one' } });
        }
        const history = await inTx(tx => readReviewHistoryInTx(tx, { actorAccountId: owner.id, workflowId, reviewId: current }));
        expect(history).toMatchObject({ previousReviewId: previous, items: [{ findingIdentity: 'same-identity', priorReviewCount: 2,
            firstObservedAt: 1000, inCurrentReview: true, inPreviousReview: true, newSincePrevious: false, openReviewCount: 1 }] });
        expect(history.items[0]).toHaveProperty('priorRunCount', 3);
        expect(history.items[0]).toHaveProperty('currentAppearances', [{ roundOrdinal: 1, runId: 'current-run', reviewerId: 'engine-a', machineId: 'machine-one', sessionId: 'session-one' }]);
        expect(history.items[0]).toHaveProperty('previousAppearances', expect.arrayContaining([
            expect.objectContaining({ roundOrdinal: 1, runId: 'prior-run', reviewerId: 'engine-a' }),
            expect.objectContaining({ roundOrdinal: 1, runId: 'prior-run', reviewerId: 'engine-b' }),
            expect.objectContaining({ roundOrdinal: 2, runId: 'second-round-run', reviewerId: 'engine-a' }),
        ]));
        const firstHistory = await inTx(tx => readReviewHistoryInTx(tx, { actorAccountId: owner.id, workflowId, reviewId: earlier }));
        expect(firstHistory).toMatchObject({ previousReviewId: null, items: [{ priorReviewCount: 0, priorRunCount: 0, newSincePrevious: null }] });
        const page = await inTx(tx => listReviewsInTx(tx, { actorAccountId: owner.id, workflowId, needsDecision: true, limit: 1 }));
        expect(page.items.map(row => row.reviewId)).toEqual([current]);
        expect(page.items[0]?.counts).toEqual({ total: 1, needsDecision: 1 });
        expect(await inTx(tx => readAdmittedReviewDetailInTx(tx, current))).toMatchObject({
            reviewId: current, state: 'completed', currentRoundOrdinal: 1, workflowId,
            counts: { total: 1, needsDecision: 1 },
        });
        expect(await inTx(tx => readAdmittedReviewDetailInTx(tx, 'absent-admitted-review'))).toBeNull();
    });

    it('selects received Account, Team and Group Review candidates before paging', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Review audience' } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Reviewers' } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: member.id } });
        const expected: string[] = [];
        for (const principalKind of ['account', 'team', 'group'] as const) {
            const reviewId = randomUUID();
            expected.push(reviewId);
            await db.artifact.create({ data: { id: reviewId, accountId: owner.id, header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
            await db.$executeRaw`INSERT INTO "ReviewMetadata" ("artifactId", "projectSourceId", "subjectKind", "sourceKind", "state", "currentRoundOrdinal", "startedAt")
                VALUES (${reviewId}, ${team.id}, 'comparison', 'direct', 'completed', 1, ${new Date()})`;
            await db.artifactGrant.create({ data: { artifactId: reviewId, principalKind, accessLevel: 'view', createdByAccountId: owner.id,
                ...(principalKind === 'account' ? { accountId: reader.id } : principalKind === 'team' ? { teamId: team.id } : { teamGroupId: group.id }) } });
        }
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await inTx(tx => listReviewsInTx(tx, { actorAccountId: reader.id, projectSourceId: team.id, limit: 1, cursor }));
            seen.push(...page.items.map(row => row.reviewId));
            cursor = page.cursor ?? undefined;
        } while (cursor);
        expect(new Set(seen)).toEqual(new Set(expected));
        expect(seen).toHaveLength(3);
        await db.teamMembership.update({ where: { id: member.id }, data: { status: 'suspended' } });
        const after = await inTx(tx => listReviewsInTx(tx, { actorAccountId: reader.id, projectSourceId: team.id, limit: 10 }));
        expect(after.items.map(row => row.reviewId)).toEqual([expected[0]]);
    });
});
