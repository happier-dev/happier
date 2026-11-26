import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { Prisma } from '@prisma/client';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ReviewListResponseV1Schema, type ReviewListRequestV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { sealReviewCommentSensitiveEnvelopeV1, splitReviewCommentV1, type ReviewCommentV1 } from '@happier-dev/protocol';
import { createAccountServerActionDeps } from '../../../../cli/src/api/accountServerActionDeps';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { createDbMaintenanceClient, type PrismaClientType } from '@/storage/prisma';
import { recordDriverStatements } from '@/testkit/driverStatements';
import { ReviewVerdictContentV1Schema } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { listReviewsInTx } from './reviewListService';
import { readAdmittedReviewHumanStateInTx, readAdmittedReviewNeedsYouInTx } from './reviewHumanService';
import { registerReviewReadRoutes } from './readRoutes';
import { buildReviewCommentCanonicalStorageValues } from './comments/accountEncryptionMigrationPersistence';

let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
let observedClient: PrismaClientType | undefined;
let originalTransaction: typeof db.$transaction | undefined;
const app = Fastify().withTypeProvider<ZodTypeProvider>();
let origin: string;
const statements: string[] = [];
beforeAll(async () => {
    harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'review-human-read-cost-', initAuth: true });
    enableSchemaValidation(app);
    enableAuthentication(app);
    registerReviewReadRoutes(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
    origin = `http://127.0.0.1:${address.port}`;
    if (process.env.HAPPIER_DB_PROVIDER === 'postgres') {
        observedClient = await createDbMaintenanceClient('postgres', undefined, {
            onDriverStatement: recordDriverStatements(({ query }) => { statements.push(query); }),
        });
        await observedClient.$connect();
        const client = observedClient;
        originalTransaction = db.$transaction;
        // Observe the real driver while retaining the production transaction owner.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
    }
}, 180_000);
afterAll(async () => {
    await app.close();
    if (originalTransaction) db.$transaction = originalTransaction;
    await observedClient?.$disconnect();
    await harness?.close();
});

it.each(['plain', 'e2ee'] as const)('keeps public %s Review list pages bodyless at 1k/10k owned and shared Reviews', async encryptionMode => {
    const reader = await db.account.create({ data: { encryptionMode } });
    const owner = await db.account.create({ data: { encryptionMode } });
    const team = await db.team.create({ data: { name: 'Review list readers' } });
    const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: 'member' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
    const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Review list group' } });
    await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
        teamMembershipId: membership.id, nativeContribution: true } });
    const projectSourceId = randomUUID();
    const otherProjectSourceId = randomUUID();
    const at = new Date(1000);
    // Opaque stored payloads are deliberately unavailable to the metadata-only caller.
    const stored = { header: randomBytes(256), body: randomBytes(4096), dataEncryptionKey: randomBytes(32) };
    const wanted = Array.from({ length: 4 }, (_, index) => ({ id: randomUUID(),
        accountId: index === 0 ? reader.id : owner.id, ...stored, createdAt: at, updatedAt: at }));
    await db.artifact.createMany({ data: wanted });
    await db.reviewMetadata.createMany({ data: wanted.map(row => ({ artifactId: row.id, projectSourceId,
        subjectKind: 'comparison', sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1, startedAt: at })) });
    const grant = (artifactId: string, arm: number): Prisma.ArtifactGrantCreateManyInput => ({ artifactId, accessLevel: 'view', createdByAccountId: owner.id,
        ...(arm === 0 ? { principalKind: 'account', accountId: reader.id }
            : arm === 1 ? { principalKind: 'team', teamId: team.id } : { principalKind: 'group', teamGroupId: group.id }) });
    await db.artifactGrant.createMany({ data: wanted.slice(1).map((row, index) => grant(row.id, index)) });
    const material = { type: 'dataKey', machineKey: randomBytes(32) } as const;
    for (const row of wanted.slice(0, 3)) {
        const rootId = randomUUID();
        const resolvedId = randomUUID();
        const comments: ReviewCommentV1[] = ([
            { id: rootId, threadId: rootId, findingIdentity: randomUUID().replaceAll('-', '').repeat(2), state: 'open' },
            { id: randomUUID(), threadId: rootId, parentCommentId: rootId, state: 'open' },
            { id: resolvedId, threadId: resolvedId, findingIdentity: randomUUID().replaceAll('-', '').repeat(2), state: 'resolved' },
        ] as const).map(comment => ({ ...comment, v: 1, accountId: row.accountId, reviewId: row.id,
            body: 'Private finding prose must not be read by the list.', bodyVersion: 1, edits: [],
            anchor: { kind: 'file', filePath: 'src/private.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
            author: { kind: 'user', userId: row.accountId }, flags: {}, dispositions: {}, transitions: [],
            createdAt: 1, updatedAt: 1, serverRevision: 1 }));
        for (const comment of comments) {
            const split = splitReviewCommentV1(comment);
            const envelope = encryptionMode === 'plain'
                ? sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'plain' })
                : sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'e2ee', material, randomBytes });
            await db.reviewComment.create({ data: { ...buildReviewCommentCanonicalStorageValues({
                structural: split.structural, targetSensitiveEnvelope: envelope }), id: comment.id,
                accountId: row.accountId, reviewId: row.id, threadId: comment.threadId, parentCommentId: comment.parentCommentId,
                state: comment.state, findingIdentity: comment.findingIdentity, flagsJson: '{}',
                authorJson: JSON.stringify(comment.author), dispositionsJson: '{}', bodyVersion: 1,
                serverRevision: 1, createdAt: BigInt(1), updatedAt: BigInt(1) } });
        }
        await db.reviewCommentAppearance.createMany({ data: ['first', 'second'].map(reviewerId => ({
            reviewId: row.id, commentId: rootId, roundOrdinal: 1, runId: 'same-run', reviewerId, sourceKey: reviewerId,
        })) });
    }
    const token = await auth.createToken(reader.id, undefined, { kind: 'account', authority: 'present_user' });
    const executor = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
    const context = { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true } as const;
    const selection = { limit: 2, projectSourceId, subjectKind: 'comparison', sourceKind: 'direct' } as const;
    const expected = [...wanted].sort((left, right) => right.id.localeCompare(left.id));
    const measurements: Array<{ inventory: number; selection: string; candidateRows: number; candidateBytes: number;
        countQueries: number; artifactQueries: number; statements: number }> = [];
    let inventory = 0;
    for (const size of [1000, 10000]) {
        while (inventory < size) {
            const noise = Array.from({ length: Math.min(500, size - inventory) }, (_, index) => ({ id: randomUUID(),
                accountId: (inventory + index) % 2 === 0 ? reader.id : owner.id, ...stored,
                updatedAt: new Date(10_000 + inventory + index) }));
            await db.artifact.createMany({ data: noise });
            await db.reviewMetadata.createMany({ data: noise.map((row, index) => ({ artifactId: row.id,
                projectSourceId: (inventory + index) % 6 < 2 ? otherProjectSourceId : projectSourceId,
                subjectKind: (inventory + index) % 6 < 2 || (inventory + index) % 6 >= 4 ? 'comparison' : 'repository',
                sourceKind: (inventory + index) % 6 >= 4 ? 'workflow' : 'direct',
                state: 'completed', currentRoundOrdinal: 1, startedAt: at })) });
            await db.artifactGrant.createMany({ data: noise.filter(row => row.accountId === owner.id)
                .map((row, index) => grant(row.id, index % 3)) });
            inventory += noise.length;
        }
        // Warm only transport/auth setup; every measured read below is one separately demanded page.
        expect((await executor.execute('reviews.list', selection, context)).ok).toBe(true);
        const read = async (request: ReviewListRequestV1, name: string) => {
            const measured = { inventory, selection: name, candidateRows: 0, candidateBytes: 0,
                countQueries: 0, artifactQueries: 0, statements: 0 };
            statements.length = 0;
            const restore = observePrismaRequests(db, { after: (query, result) => {
                if (query.model === 'ReviewComment' || query.model === 'ReviewCommentAppearance') {
                    throw new Error('List must count in SQL rather than materializing comment bodies or appearances');
                }
                if (query.model !== 'Artifact' || !Array.isArray(result)) return;
                for (const row of result) {
                    expect(row).not.toHaveProperty('header');
                    expect(row).not.toHaveProperty('body');
                    if (row && typeof row === 'object' && 'reviewMetadata' in row) {
                        measured.candidateRows++;
                        measured.candidateBytes += Buffer.byteLength(JSON.stringify(row));
                    }
                }
            } });
            try {
                const result = await executor.execute('reviews.list', request, context);
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
                if (!result.ok) throw new Error('Expected authorized metadata page');
                const page = ReviewListResponseV1Schema.parse(result.result);
                measured.countQueries = statements.filter(query => /GROUP BY c\."review_id"/.test(query)).length;
                measured.artifactQueries = statements.filter(query => /FROM "public"\."Artifact"/.test(query)
                    && /LIMIT/.test(query)).length;
                measured.statements = statements.length;
                expect(measured.countQueries).toBe(1);
                expect(measured.candidateRows).toBeLessThanOrEqual(4 * (request.limit + 1));
                expect(statements.some(query => /^\s*(?:INSERT|UPDATE|DELETE)\b/.test(query))).toBe(false);
                measurements.push(measured);
                console.info(`[review-list-http] mode=${encryptionMode} ${JSON.stringify(measured)}`);
                return page;
            } finally { restore(); }
        };
        const first = await read(selection, 'first');
        expect(first.items.map(row => row.reviewId)).toEqual(expected.slice(0, 2).map(row => row.id));
        expect(first.cursor).toEqual(expect.any(String));
        const second = await read({ ...selection, cursor: first.cursor! }, 'continuation');
        expect(second.items.map(row => row.reviewId)).toEqual(expected.slice(2).map(row => row.id));
        expect(second.cursor).toBeNull();
        for (const row of [...first.items, ...second.items]) {
            expect(row.counts).toEqual(row.reviewId === wanted[3]!.id ? { total: 0, needsDecision: 0 } : { total: 2, needsDecision: 1 });
        }
        const pending = await read({ ...selection, needsDecision: true }, 'needs-decision');
        expect(pending.items.map(row => row.reviewId)).toEqual(expected.filter(row => row.id !== wanted[3]!.id).slice(0, 2).map(row => row.id));
        expect(pending.cursor).toEqual(expect.any(String));
        const pendingLast = await read({ ...selection, needsDecision: true, cursor: pending.cursor! }, 'needs-decision-continuation');
        expect(pendingLast.items.map(row => row.reviewId)).toEqual(expected.filter(row => row.id !== wanted[3]!.id).slice(2).map(row => row.id));
        expect(pendingLast.cursor).toBeNull();
        const changed = await executor.execute('reviews.list', { ...selection, sourceKind: 'workflow', cursor: first.cursor! }, context);
        expect(changed).toMatchObject({ ok: false, errorCode: 'review_comment_invalid_filter' });
    }
    for (const name of ['first', 'continuation', 'needs-decision', 'needs-decision-continuation']) {
        const [small, large] = measurements.filter(row => row.selection === name);
        expect(large).toEqual({ ...small!, inventory: 10000 });
    }
    expect(measurements.every(row => row.candidateRows > 0 && row.artifactQueries > 0)).toBe(true);
});

it('filters public Review pages by the shared Updated bounds before every grant-arm LIMIT', async () => {
    const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Updated Review readers' } });
    const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: 'member' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
    const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Updated Review group' } });
    await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
        teamMembershipId: membership.id, nativeContribution: true } });
    const projectSourceId = randomUUID();
    const make = (atMs: number, arm: number) => ({ id: randomUUID(), accountId: arm === 0 ? reader.id : owner.id,
        header: randomBytes(32), body: randomBytes(64), dataEncryptionKey: randomBytes(32), updatedAt: new Date(atMs) });
    const wanted = [make(999, 0), make(1000, 0), make(1000, 1), make(2000, 2), make(2000, 3), make(2001, 1)];
    const noise = Array.from({ length: 1000 }, (_, index) => make(10_000 + index, index % 4));
    const rows = [...wanted, ...noise];
    for (let offset = 0; offset < rows.length; offset += 500) {
        const chunk = rows.slice(offset, offset + 500);
        await db.artifact.createMany({ data: chunk });
        await db.reviewMetadata.createMany({ data: chunk.map(row => ({ artifactId: row.id, projectSourceId,
            subjectKind: 'comparison', sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1,
            // Updated means the Artifact list timestamp, not round start/finish metadata.
            startedAt: new Date(99_999), finishedAt: new Date(100_000) })) });
        await db.artifactGrant.createMany({ data: chunk.flatMap((row, index) => row.accountId === reader.id ? [] : [{
            artifactId: row.id, createdByAccountId: owner.id, accessLevel: 'view',
            ...((offset + index) % 3 === 0 ? { principalKind: 'account', accountId: reader.id }
                : (offset + index) % 3 === 1 ? { principalKind: 'team', teamId: team.id }
                    : { principalKind: 'group', teamGroupId: group.id }),
        }]) });
    }
    const token = await auth.createToken(reader.id, undefined, { kind: 'account', authority: 'present_user' });
    const executor = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
    const context = { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true } as const;
    const base = { limit: 2, projectSourceId };
    const read = async (input: unknown) => {
        const result = await executor.execute('reviews.list', input, context);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('Expected authorized Updated Review page');
        return ReviewListResponseV1Schema.parse(result.result);
    };
    const sort = (items: typeof wanted) => [...items].sort((left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id));
    expect((await read(base)).items.map(row => row.reviewId)).toEqual(sort(noise).slice(0, 2).map(row => row.id));
    const range = { ...base, updated: { op: 'between', fromMs: 1000, toMs: 2000 } };
    const expected = sort(wanted.filter(row => row.updatedAt.getTime() >= 1000 && row.updatedAt.getTime() <= 2000));
    const first = await read(range);
    expect(first.items.map(row => row.reviewId)).toEqual(expected.slice(0, 2).map(row => row.id));
    expect(first.cursor).toEqual(expect.any(String));
    const second = await read({ ...range, cursor: first.cursor });
    expect(second.items.map(row => row.reviewId)).toEqual(expected.slice(2).map(row => row.id));
    expect(second.cursor).toBeNull();
    expect([...first.items, ...second.items].map(row => row.counts)).toEqual(Array.from({ length: 4 }, () => ({ total: 0, needsDecision: 0 })));
    expect((await read({ ...base, updated: { op: 'before', atMs: 1000 } })).items.map(row => row.reviewId)).toEqual([wanted[0]!.id]);
    expect((await read({ ...base, reviewIds: wanted.map(row => row.id), updated: { op: 'after', atMs: 2000 } }))
        .items.map(row => row.reviewId)).toEqual([wanted[5]!.id]);
    expect(await executor.execute('reviews.list', { ...range, updated: { ...range.updated, fromMs: 1001 }, cursor: first.cursor }, context))
        .toMatchObject({ ok: false, errorCode: 'review_comment_invalid_filter' });
    expect(await executor.execute('reviews.list', { ...range, updated: { op: 'between', fromMs: 2000, toMs: 1000 } }, context))
        .toMatchObject({ ok: false });
});

it('keeps list and Inbox reads bodyless and proportional to current rounds while detail preserves verdict history', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const reviewId = randomUUID();
    const currentRoundOrdinal = 10_001;
    await db.artifact.create({ data: { id: reviewId, accountId: owner.id, header: new Uint8Array(), body: new Uint8Array(),
        dataEncryptionKey: new Uint8Array(), reviewMetadata: { create: { subjectKind: 'repository', sourceKind: 'direct',
            state: 'completed', currentRoundOrdinal, startedAt: new Date(1) } } } });
    const current = await db.reviewRequestedReviewer.create({ data: { reviewId, roundOrdinal: currentRoundOrdinal,
        principalKey: `account:${owner.id}`, principal: { kind: 'account', accountId: owner.id }, required: true,
        eligibleAccounts: { create: { accountId: owner.id } } } });
    const access = { reviewId, ownerAccountId: owner.id, level: 'owner', encryptionMode: 'plain' } as const;
    const measurements: { requests: number; verdicts: number; bytes: number; statements: number }[] = [];
    let history = 0;
    for (const size of [1000, 10000]) {
        if (size === 10000) {
            await db.session.createMany({ data: Array.from({ length: 1000 }, () => ({ accountId: owner.id,
                tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' })) });
            await db.machine.createMany({ data: Array.from({ length: 100 }, () => ({ id: randomUUID(),
                accountId: owner.id, metadata: '{}' })) });
        }
        while (history < size) {
            const rounds = Array.from({ length: Math.min(500, size - history) }, (_, index) => history + index + 1);
            await db.reviewRequestedReviewer.createMany({ data: rounds.map(roundOrdinal => ({ id: randomUUID(), reviewId,
                roundOrdinal, principalKey: `account:${owner.id}`, principal: { kind: 'account', accountId: owner.id }, required: true })) });
            await db.reviewVerdict.createMany({ data: rounds.map(roundOrdinal => ({ reviewId, roundOrdinal, accountId: owner.id,
                verdict: 'approve', content: { t: 'plain', v: ReviewVerdictContentV1Schema.parse({ reviewId, roundOrdinal,
                    accountId: owner.id, revision: 1, body: 'historical prose '.repeat(128) }) } })) });
            history += rounds.length;
        }
        for (const consumer of ['list', 'Inbox'] as const) {
            const measured = { requests: 0, verdicts: 0, bytes: 0 };
            statements.length = 0;
            const restore = observePrismaRequests(db, { after: (request, rows) => {
                const kind = request.model === 'ReviewRequestedReviewer' ? 'requests' : request.model === 'ReviewVerdict' ? 'verdicts' : null;
                if (!kind || request.action !== 'findMany' || !Array.isArray(rows)) return;
                measured[kind] += rows.length;
                measured.bytes += Buffer.byteLength(JSON.stringify(rows));
                for (const row of rows) expect(row).not.toHaveProperty('content');
            } });
            try {
                await inTx(async tx => {
                    const needsYou = consumer === 'list'
                        ? (await listReviewsInTx(tx, { actorAccountId: owner.id, limit: 1 })).items[0]!.needsYou
                        : (await readAdmittedReviewNeedsYouInTx(tx, { actorAccountId: owner.id, reviews: [access] })).get(reviewId);
                    expect(needsYou).toMatchObject({ roundOrdinal: currentRoundOrdinal, requestedVerdict: true, needsYou: true });
                });
            } finally { restore(); }
            expect(measured).toMatchObject({ requests: 1, verdicts: 0 });
            expect(statements.some(query => /^\s*(?:INSERT|UPDATE|DELETE)\b|"(?:Session|Machine)"/.test(query))).toBe(false);
            const sqlStatements = statements.length;
            measurements.push({ ...measured, statements: sqlStatements });
            console.info(`[review-human-read] consumer=${consumer} history=${history} sessions=${size === 10000 ? 1000 : 0} machines=${size === 10000 ? 100 : 0} rows=${measured.requests + measured.verdicts} bytes=${measured.bytes} statements=${sqlStatements}`);
        }
    }
    expect(measurements.every(row => row.bytes === measurements[0]!.bytes)).toBe(true);
    // Inventory growth must add no statements; a first-read setup query may disappear.
    expect(measurements[2]!.statements).toBeLessThanOrEqual(measurements[0]!.statements);
    expect(measurements[3]!.statements).toBeLessThanOrEqual(measurements[1]!.statements);
    if (observedClient) expect(measurements.every(row => row.statements > 0)).toBe(true);
    await db.reviewVerdict.create({ data: { reviewId, roundOrdinal: currentRoundOrdinal, accountId: owner.id, verdict: 'comment' } });
    const settled = await inTx(tx => readAdmittedReviewNeedsYouInTx(tx, { actorAccountId: owner.id, reviews: [access] }));
    expect(settled.get(reviewId)).toMatchObject({ requestedVerdict: false, needsYou: false, canSubmitVerdict: true });
    const detail = await inTx(tx => readAdmittedReviewHumanStateInTx(tx, { actorAccountId: owner.id, access }));
    expect(detail.requests.map(row => row.id)).toEqual([current.id]);
    expect(detail.verdicts).toHaveLength(history + 1);
    expect(detail.verdicts[0]!.content).toMatchObject({ t: 'plain', v: { body: expect.stringContaining('historical prose') } });
});
