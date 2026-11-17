import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Prisma } from '@prisma/client';
import { readArtifactCandidateAccess } from '@/app/artifacts/artifactAccessService';
import { artifactVisibleWhere } from '@/app/artifacts/artifactClassification';
import { mergeResourceGrantArmPages } from '@/app/teams/resourceGrantAccess';
import { resolveTeamArtifactQueryInTx } from '@/app/artifacts/artifactTeamResourceQuery';
import { createArtifactResourceSpaceMembershipWhere } from '@/app/session/organization/organizationQueries';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { resourceGrantAccessSqlPredicate } from '@/app/teams/resourceGrantAccess';
import { artifactOrdinarySqlPredicate } from '@/app/artifacts/artifactClassification';
import { ReviewCommentOperationError } from './comments/errors';
import { REVIEW_TRIAGE_NEEDS_DECISION_STATUSES_V1, REVIEW_COMMENT_TERMINAL_DECISION_STATES_V1 } from '@happier-dev/protocol/reviews/reviewTriageStatus';
import { ReviewListRequestV1Schema, ReviewListResponseV1Schema, ReviewListItemV1Schema, ReviewWorkflowHistoryResponseV1Schema,
    type ReviewListRequestV1, type ReviewListResponseV1, type ReviewHistoryRequestV1,
    type ReviewHistoryResponseV1, type ReviewWorkflowHistoryRequestV1, type ReviewWorkflowHistoryResponseV1,
    type ReviewSeenBeforeRequestV1, type ReviewSeenBeforeResponseV1, type ReviewListItemV1 } from '@happier-dev/protocol/reviews/reviewListV1';

type CountRow = { reviewId: string; total: number | bigint; needsDecision: number | bigint };
const sql = prismaRuntime.sql;
function dialect() {
    const mysql = getDbProviderFromEnv(process.env, 'postgres') === 'mysql';
    const identifier = (name: string) => prismaRuntime.raw(mysql ? `\`${name}\`` : `"${name}"`);
    const col = (alias: string, name: string) => sql`${prismaRuntime.raw(alias)}.${identifier(name)}`;
    return { identifier, col, mysql };
}
function reviewNeedsDecisionWhere(): Prisma.ReviewCommentWhereInput {
    return { parentCommentId: null, findingIdentity: { not: null }, tombstoneJson: null, state: { notIn: [...REVIEW_COMMENT_TERMINAL_DECISION_STATES_V1] },
        OR: [{ reviewTriageStatus: null }, { reviewTriageStatus: { in: [...REVIEW_TRIAGE_NEEDS_DECISION_STATUSES_V1] } }] };
}
function actionable(alias: string) {
    const { col } = dialect();
    return sql`${col(alias, 'state')} NOT IN (${prismaRuntime.join([...REVIEW_COMMENT_TERMINAL_DECISION_STATES_V1])}) AND (${col(alias, 'review_triage_status')} IS NULL OR ${col(alias, 'review_triage_status')} IN (${prismaRuntime.join([...REVIEW_TRIAGE_NEEDS_DECISION_STATUSES_V1])}))`;
}
function roots(alias: string) {
    const { col } = dialect();
    return sql`${col(alias, 'parent_comment_id')} IS NULL AND ${col(alias, 'finding_identity')} IS NOT NULL AND ${col(alias, 'tombstone_json')} IS NULL`;
}
function authorized(actorAccountId: string) {
    const { col, mysql } = dialect();
    return sql`${col('a', 'deletedAt')} IS NULL AND ${prismaRuntime.raw(artifactOrdinarySqlPredicate(mysql))}
        AND ${resourceGrantAccessSqlPredicate({ actorAccountId, resourceTablePrefix: 'Artifact', resourceIdColumn: 'artifactId' })}`;
}
const millis = (value: Date | string | number | bigint) => value instanceof Date ? value.getTime()
    : typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : new Date(value).getTime();
function filters(input: ReviewListRequestV1) { const { cursor: _cursor, limit: _limit, ...rest } = input; return rest; }

/** One structural candidate page, then one grouped root-count read; no Artifact bodies or per-row grant discovery. */
export async function listReviewsInTx(tx: Tx, input: ReviewListRequestV1 & { actorAccountId: string }): Promise<ReviewListResponseV1> {
    const { actorAccountId, ...request } = input;
    const parsed = ReviewListRequestV1Schema.parse(request);
    const { needsDecision: _needsDecision, sharedWithTeamId: _team, cursor: _cursor,
        limit: _limit, spaceId: _space, spaceMembershipMode: _mode, ...metadata } = parsed;
    const smart: Prisma.ArtifactWhereInput = { reviewMetadata: { is: metadata },
        ...(parsed.needsDecision === undefined ? {} : { reviewComments: {
            [parsed.needsDecision ? 'some' : 'none']: reviewNeedsDecisionWhere(),
        } }),
    };
    const membership = parsed.spaceId === undefined ? null : createArtifactResourceSpaceMembershipWhere({ accountId: actorAccountId, spaceId: parsed.spaceId });
    const selection: Prisma.ArtifactWhereInput = membership === null ? smart
        : parsed.spaceMembershipMode === 'filter_or_manual' ? { reviewMetadata: { isNot: null }, OR: [smart, membership] }
        : { reviewMetadata: { isNot: null }, ...membership };
    const conditions: Prisma.ArtifactWhereInput[] = [selection];
    if (parsed.cursor) {
        let decoded: unknown;
        try { decoded = JSON.parse(Buffer.from(parsed.cursor, 'base64url').toString('utf8')); }
        catch { throw new ReviewCommentOperationError('review_comment_invalid_filter', 'Invalid Review continuation'); }
        if (!decoded || typeof decoded !== 'object' || !('filters' in decoded) || !('id' in decoded) || typeof decoded.id !== 'string'
            || !('updatedAt' in decoded) || typeof decoded.updatedAt !== 'number' || JSON.stringify(decoded.filters) !== JSON.stringify(filters(parsed))) {
            throw new ReviewCommentOperationError('review_comment_invalid_filter', 'Review continuation does not match the selection');
        }
        const at = new Date(decoded.updatedAt);
        if (Number.isNaN(at.getTime())) throw new ReviewCommentOperationError('review_comment_invalid_filter', 'Invalid Review continuation timestamp');
        conditions.push({ OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: decoded.id } }] });
    }
    const team = parsed.sharedWithTeamId === undefined ? null : await resolveTeamArtifactQueryInTx(tx, {
        actorAccountId, sharedWithTeamId: parsed.sharedWithTeamId, teamResourceKind: 'reviews',
    });
    if (team && !team.ok) throw Object.assign(new Error(team.error), { code: team.error });
    const access = team?.ok ? { owned: null, received: [team.where] } : readArtifactCandidateAccess(actorAccountId);
    const rows = mergeResourceGrantArmPages(await Promise.all([...(access.owned ? [access.owned] : []), ...access.received].map(arm =>
        tx.artifact.findMany({ where: { ...artifactVisibleWhere, AND: [...conditions, arm] },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: parsed.limit + 1,
            select: { id: true, createdAt: true, updatedAt: true, reviewMetadata: true },
        }))), (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id), parsed.limit + 1)
        .map(row => { const { artifactId: _artifactId, ...metadata } = row.reviewMetadata!; return { ...metadata, reviewId: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt }; });
    const page = rows.slice(0, parsed.limit);
    const byId = await readAdmittedReviewCountsInTx(tx, page.map(row => row.reviewId));
    const last = page.at(-1);
    return ReviewListResponseV1Schema.parse({ items: page.map(row => ({ ...row, startedAt: millis(row.startedAt), finishedAt: row.finishedAt === null ? null : millis(row.finishedAt),
        createdAt: millis(row.createdAt), updatedAt: millis(row.updatedAt), counts: byId.get(row.reviewId) ?? { total: 0, needsDecision: 0 } })),
        cursor: rows.length > parsed.limit && last ? Buffer.from(JSON.stringify({ filters: filters(parsed), id: last.reviewId, updatedAt: millis(last.updatedAt) })).toString('base64url') : null });
}

/** Only call with ids selected through Artifact admission in this read snapshot. */
export async function readAdmittedReviewDetailInTx(tx: Tx, reviewId: string): Promise<ReviewListItemV1 | null> {
    const row = await tx.artifact.findUnique({ where: { id: reviewId },
        select: { createdAt: true, updatedAt: true, reviewMetadata: true } });
    if (!row?.reviewMetadata) return null;
    const { artifactId: _artifactId, ...metadata } = row.reviewMetadata;
    const counts = (await readAdmittedReviewCountsInTx(tx, [reviewId])).get(reviewId) ?? { total: 0, needsDecision: 0 };
    return ReviewListItemV1Schema.parse({ ...metadata, reviewId, createdAt: millis(row.createdAt), updatedAt: millis(row.updatedAt),
        startedAt: millis(metadata.startedAt), finishedAt: metadata.finishedAt === null ? null : millis(metadata.finishedAt), counts });
}

/** Only call with ids selected through Artifact admission in this read snapshot. */
export async function readAdmittedReviewCountsInTx(tx: Tx, reviewIds: readonly string[]): Promise<ReadonlyMap<string, { total: number; needsDecision: number }>> {
    if (reviewIds.length === 0) return new Map();
    const { col, identifier } = dialect();
    const rows: CountRow[] = [];
    for (const chunk of portableQueryChunks({ values: [...new Set(reviewIds)], bindingsPerValue: 1, fixedBindings: REVIEW_TRIAGE_NEEDS_DECISION_STATUSES_V1.length + REVIEW_COMMENT_TERMINAL_DECISION_STATES_V1.length })) {
        rows.push(...await tx.$queryRaw<CountRow[]>(sql`SELECT ${col('c', 'review_id')} AS ${identifier('reviewId')}, COUNT(*) AS ${identifier('total')},
            SUM(CASE WHEN ${actionable('c')} THEN 1 ELSE 0 END) AS ${identifier('needsDecision')} FROM review_comments c
            WHERE ${col('c', 'review_id')} IN (${prismaRuntime.join(chunk)}) AND ${roots('c')} GROUP BY ${col('c', 'review_id')}`));
    }
    return new Map(rows.map(row => [row.reviewId, { total: Number(row.total), needsDecision: Number(row.needsDecision) }]));
}

/** Exact identities across the selected workflow's authorized earlier Reviews; decisions remain Review-local. */
export function readReviewHistoryInTx(tx: Tx, input: ReviewWorkflowHistoryRequestV1 & { actorAccountId: string }): Promise<ReviewWorkflowHistoryResponseV1>;
export function readReviewHistoryInTx(tx: Tx, input: ReviewSeenBeforeRequestV1 & { actorAccountId: string }): Promise<ReviewSeenBeforeResponseV1>;
export function readReviewHistoryInTx(tx: Tx, input: ReviewHistoryRequestV1 & { actorAccountId: string }): Promise<ReviewHistoryResponseV1>;
export async function readReviewHistoryInTx(tx: Tx, input: ReviewHistoryRequestV1 & { actorAccountId: string }): Promise<ReviewHistoryResponseV1> {
    if ('findingIdentity' in input) return readReviewSeenBeforeInTx(tx, input);
    const { col, identifier } = dialect();
    type Row = { previousReviewId: string | null; findingIdentity: string | null; priorReviewCount: number | bigint;
        firstObservedAt: Date | string | number | bigint; inCurrentReview: number | bigint; inPreviousReview: number | bigint; openReviewCount: number | bigint;
        priorRunCount: number | bigint | null; appearanceReviewId: string | null; roundOrdinal: number | null;
        runId: string | null; reviewerId: string | null; machineId: string | null; sessionId: string | null };
    const rows = await tx.$queryRaw<Row[]>(sql`WITH authorized_reviews AS (
        SELECT ${col('a', 'id')} AS id, ${col('a', 'createdAt')} AS observed FROM ${identifier('Artifact')} a
        JOIN ${identifier('ReviewMetadata')} m ON ${col('m', 'artifactId')} = ${col('a', 'id')}
        WHERE ${authorized(input.actorAccountId)} AND ${col('m', 'workflowId')} = ${input.workflowId}
    ), current_review AS (SELECT * FROM authorized_reviews WHERE id = ${input.reviewId}),
    earlier_reviews AS (SELECT r.* FROM authorized_reviews r JOIN current_review n ON r.observed < n.observed OR (r.observed = n.observed AND r.id < n.id)),
    previous_review AS (SELECT id FROM earlier_reviews ORDER BY observed DESC, id DESC LIMIT 1),
    relevant AS (SELECT * FROM earlier_reviews UNION ALL SELECT * FROM current_review),
    grouped AS (SELECT ${col('c', 'finding_identity')} AS ${identifier('findingIdentity')},
        COUNT(DISTINCT CASE WHEN r.id <> ${input.reviewId} THEN r.id END) AS ${identifier('priorReviewCount')}, MIN(r.observed) AS ${identifier('firstObservedAt')},
        MAX(CASE WHEN r.id = ${input.reviewId} THEN 1 ELSE 0 END) AS ${identifier('inCurrentReview')},
        MAX(CASE WHEN r.id = (SELECT id FROM previous_review) THEN 1 ELSE 0 END) AS ${identifier('inPreviousReview')},
        COUNT(DISTINCT CASE WHEN ${actionable('c')} THEN r.id END) AS ${identifier('openReviewCount')}
        FROM relevant r JOIN review_comments c ON ${col('c', 'review_id')} = r.id WHERE ${roots('c')} GROUP BY ${col('c', 'finding_identity')}),
    appearance_facts AS (SELECT ${col('c', 'finding_identity')} AS ${identifier('findingIdentity')},
        ${col('p', 'review_id')}, ${col('p', 'round_ordinal')}, ${col('p', 'run_id')}, ${col('p', 'reviewer_id')}, ${col('p', 'machine_id')}, ${col('p', 'session_id')}
        FROM relevant r JOIN review_comments c ON ${col('c', 'review_id')} = r.id
        JOIN review_comment_appearances p ON ${col('p', 'comment_id')} = ${col('c', 'id')} WHERE ${roots('c')}),
    run_counts AS (SELECT ${identifier('findingIdentity')}, COUNT(*) AS ${identifier('priorRunCount')} FROM (
        SELECT DISTINCT ${identifier('findingIdentity')}, review_id, round_ordinal, run_id, machine_id, session_id FROM appearance_facts
        WHERE review_id <> ${input.reviewId}) qualified_runs GROUP BY ${identifier('findingIdentity')})
    SELECT (SELECT id FROM previous_review) AS ${identifier('previousReviewId')}, g.*, rc.${identifier('priorRunCount')},
        p.review_id AS ${identifier('appearanceReviewId')}, p.round_ordinal AS ${identifier('roundOrdinal')},
        p.run_id AS ${identifier('runId')}, p.reviewer_id AS ${identifier('reviewerId')}, p.machine_id AS ${identifier('machineId')}, p.session_id AS ${identifier('sessionId')}
    FROM current_review LEFT JOIN grouped g ON 1=1
    LEFT JOIN run_counts rc ON rc.${identifier('findingIdentity')} = g.${identifier('findingIdentity')}
    LEFT JOIN appearance_facts p ON p.${identifier('findingIdentity')} = g.${identifier('findingIdentity')}
        AND (p.review_id = ${input.reviewId} OR p.review_id = (SELECT id FROM previous_review))
    ORDER BY g.${identifier('findingIdentity')}, p.review_id, p.round_ordinal, p.run_id, p.reviewer_id`);
    const previousReviewId = rows[0]?.previousReviewId ?? null;
    const grouped = new Map<string, ReviewWorkflowHistoryResponseV1['items'][number]>();
    for (const row of rows) {
        if (row.findingIdentity === null) continue;
        let item = grouped.get(row.findingIdentity);
        if (!item) {
            item = { findingIdentity: row.findingIdentity, priorReviewCount: Number(row.priorReviewCount),
                priorRunCount: Number(row.priorRunCount ?? 0), firstObservedAt: millis(row.firstObservedAt),
                inCurrentReview: Number(row.inCurrentReview) > 0, inPreviousReview: Number(row.inPreviousReview) > 0,
                newSincePrevious: previousReviewId === null ? null : Number(row.inCurrentReview) > 0 && Number(row.inPreviousReview) === 0,
                openReviewCount: Number(row.openReviewCount), currentAppearances: [], previousAppearances: [] };
            grouped.set(row.findingIdentity, item);
        }
        if (row.appearanceReviewId !== null) {
            const target = row.appearanceReviewId === input.reviewId ? item.currentAppearances : item.previousAppearances;
            target.push({ roundOrdinal: row.roundOrdinal!, runId: row.runId!, reviewerId: row.reviewerId!,
                ...(row.machineId === null ? {} : { machineId: row.machineId }), ...(row.sessionId === null ? {} : { sessionId: row.sessionId }) });
        }
    }
    return ReviewWorkflowHistoryResponseV1Schema.parse({ previousReviewId, items: [...grouped.values()] });
}

/** Exact earlier links only: Artifact admission owns visibility and each Review owns its decisions. */
export async function readReviewSeenBeforeInTx(tx: Tx, input: ReviewSeenBeforeRequestV1 & { actorAccountId: string }): Promise<ReviewSeenBeforeResponseV1> {
    const access = readArtifactCandidateAccess(input.actorAccountId);
    const arms = [...(access.owned ? [access.owned] : []), ...access.received];
    const root: Prisma.ReviewCommentWhereInput = { findingIdentity: input.findingIdentity, parentCommentId: null, tombstoneJson: null };
    const selected = await tx.artifact.findFirst({
        where: { ...artifactVisibleWhere, id: input.reviewId, OR: arms, reviewMetadata: { isNot: null } },
        select: { id: true, createdAt: true, reviewMetadata: { select: { projectSourceId: true } },
            reviewComments: { where: root, take: 1, select: { workspaceJson: true, projectId: true } } },
    });
    if (!selected) return { matches: [] };
    const projectSourceId = selected.reviewMetadata!.projectSourceId;
    const context = selected.reviewComments[0];
    if (projectSourceId === null && !context?.workspaceJson && !context?.projectId) return { matches: [] };
    const matchingRoot: Prisma.ReviewCommentWhereInput = projectSourceId !== null ? root
        : { ...root, ...(context?.workspaceJson ? { workspaceJson: context.workspaceJson } : { projectId: context!.projectId }) };
    const earlier: Prisma.ArtifactWhereInput = { OR: [{ createdAt: { lt: selected.createdAt } },
        { createdAt: selected.createdAt, id: { lt: selected.id } }] };
    const rows = (await Promise.all(arms.map(arm => tx.artifact.findMany({
        where: { ...artifactVisibleWhere, AND: [earlier, arm],
            reviewMetadata: projectSourceId === null ? { isNot: null } : { is: { projectSourceId } },
            reviewComments: { some: matchingRoot } },
        select: { id: true, createdAt: true, reviewComments: { where: matchingRoot, select: { id: true } } },
    })))).flat();
    const byReview = new Map(rows.map(row => [row.id, row]));
    return { matches: [...byReview.values()]
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
        .flatMap(row => row.reviewComments.map(comment => ({ reviewId: row.id, commentId: comment.id, createdAt: row.createdAt.getTime() }))) };
}
