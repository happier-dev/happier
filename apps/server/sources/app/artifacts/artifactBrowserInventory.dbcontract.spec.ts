import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { ArtifactHttpHeaderReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactKindCoverageV1Schema, deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { listArtifactHeadersV1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres, prismaRuntime } from '@/storage/db';
import { listArtifactHeadersForCallerInTx, readArtifactCandidateWhereInTx } from './artifactAccessService';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { createArtifact } from './artifactWriteService';
import * as resourceGrants from '@/app/teams/resourceGrantAccess';

const provider = getDbProviderFromEnv(process.env, 'postgres');
const headersSchema = z.array(ArtifactHttpHeaderReadV1Schema);
const pageSchema = z.object({ items: headersSchema, hasUnclassified: z.boolean(), coverage: ArtifactKindCoverageV1Schema });
const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
const encodeCursor = (row: Readonly<{ artifactId: string; updatedAt: number }>) =>
    Buffer.from(JSON.stringify({ id: row.artifactId, updatedAt: row.updatedAt })).toString('base64url');

describe.skipIf(provider !== 'postgres' && provider !== 'mysql')(`browser Artifact inventory (${provider})`, () => {
    let connected = false;
    const plainAtRest = process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST;
    beforeAll(async () => {
        const supplied = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error('Use the disposable DB-contract harness');
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = 'none';
        if (provider === 'mysql') await initDbMysql(); else initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        try { if (connected) await db.$disconnect(); }
        finally {
            if (plainAtRest === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST;
            else process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = plainAtRest;
        }
    });

    it.skipIf(provider !== 'postgres')('reads two open approvals and a notice without acquiring ten thousand settled receipts', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const created: string[] = [];
        for (const header of [
            { kind: 'approval_request.v1', approvalStatus: 'executed', sessionId: 'session' },
            { kind: 'approval_request.v1', approvalStatus: 'open', sessionId: 'second-open-session' },
            { kind: 'target_action_approval.v1', approvalStatus: 'open', sessionId: 'other-session' },
            { kind: 'account_notice.v1' },
        ]) {
            const id = randomUUID();
            expect(await createArtifact({ actorUserId: owner.id, artifactId: id, header: bytes(header), body: bytes({ receipt: true }),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) })).toMatchObject({ ok: true });
            created.push(id);
        }
        // Clone the producer's whole current row, including every admitted query hint.
        await db.$executeRawUnsafe(`INSERT INTO "Artifact"
            SELECT (jsonb_populate_record(NULL::"Artifact", to_jsonb(a) || jsonb_build_object('id', $1 || n::text))).*
            FROM "Artifact" a CROSS JOIN generate_series(1, 10000) n WHERE a."id" = $2`, `${randomUUID()}-`, created[0]);
        await db.$transaction(async tx => {
            const observed = observePrismaReads(tx, ['artifact']);
            const selected = await listArtifactHeadersForCallerInTx(observed.tx, { actorAccountId: owner.id, cursor: null, limit: 500,
                kinds: ['approval_request.v1', 'target_action_approval.v1', 'account_notice.v1'], approvalStates: ['open'] });
            expect(new Set(selected.map(row => row.id))).toEqual(new Set(created.slice(1)));
            expect(observed.rows.flatMap(row => row.ids)).toHaveLength(3);
            expect(selected.every(row => row.body === undefined)).toBe(true);
            const related = observePrismaReads(tx, ['artifact']);
            const receipts = await listArtifactHeadersForCallerInTx(related.tx, { actorAccountId: owner.id, cursor: null, limit: 500,
                kinds: ['approval_request.v1', 'target_action_approval.v1'],
                approvalSessionIds: [...Array.from({ length: 1000 }, (_, index) => `absent-session-${index}`), 'other-session', 'second-open-session'] });
            expect(new Set(receipts.map(row => row.id))).toEqual(new Set([created[1], created[2]]));
            expect(related.rows.flatMap(row => row.ids)).toHaveLength(2);
            const empty = observePrismaReads(tx, ['artifact']);
            expect(await listArtifactHeadersForCallerInTx(empty.tx, { actorAccountId: owner.id, cursor: null, limit: 500,
                approvalSessionIds: [] })).toEqual([]);
            expect(empty.reads).toEqual([]);
        }, { isolationLevel: 'RepeatableRead' });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };
            const response = await app.inject({ method: 'GET', url: '/v1/artifacts?' + new URLSearchParams({
                kinds: JSON.stringify(['approval_request.v1', 'target_action_approval.v1', 'account_notice.v1']), approvalStates: '["open"]' }), headers });
            expect(response.statusCode, response.body).toBe(200);
            expect(new Set(response.json().items.map((row: { id: string }) => row.id))).toEqual(new Set(created.slice(1)));
            const receipts = await app.inject({ method: 'GET', url: '/v1/artifacts?' + new URLSearchParams({
                approvalSessionIds: '["other-session","second-open-session"]' }), headers });
            expect(receipts.statusCode, receipts.body).toBe(200);
            expect(new Set(receipts.json().items.map((row: { id: string }) => row.id))).toEqual(new Set([created[1], created[2]]));
        });
        expect(await db.artifact.count({ where: { accountId: owner.id } })).toBe(10004);
    });

    it('preserves raw exact kinds that resemble encoded storage values', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ids: string[] = [];
        for (const kind of ['foo', 'v1:other:foo']) {
            const id = randomUUID();
            expect(await createArtifact({ actorUserId: owner.id, artifactId: id, header: bytes({ kind }), body: bytes({ receipt: true }),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) })).toMatchObject({ ok: true });
            ids.push(id);
        }
        await db.$transaction(async tx => {
            const rows = await listArtifactHeadersForCallerInTx(tx, { actorAccountId: owner.id, cursor: null, limit: 500, kinds: ['v1:other:foo'] });
            expect(rows.map(row => row.id)).toEqual([ids[1]]);
        });
    });

    it('selects the exact browser complement before paging through the real route and shared selector', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const base = { accountId: owner.id, body: new Uint8Array([0xff]),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 };
        const privateHeader = { kind: 'approval_request.v1' };
        await db.artifact.createMany({ data: Array.from({ length: 2500 }, () => ({ ...base, id: randomUUID(),
            kind: deriveArtifactStoredKindV1(privateHeader), header: bytes(privateHeader) })) });
        const listedIds: string[] = [];
        for (const kind of ['future.document.v3', undefined, 'APPROVAL_REQUEST.v1', 'ápproval_request.v1', 'approval_request.v1 ',
            'approval_request.v1#managed-delete:contract']) {
            const header = kind === undefined ? {} : { kind };
            listedIds.push((await db.artifact.create({ data: { ...base, id: randomUUID(), header: bytes(header),
                kind: deriveArtifactStoredKindV1(header), updatedAt: new Date(0) } })).id);
        }
        const legacy = await db.artifact.create({ data: { ...base, id: randomUUID(), kind: null,
            header: bytes({ kind: 'document' }), updatedAt: new Date(0) } });
        const legacyPrivate = await db.artifact.create({ data: { ...base, id: randomUUID(), kind: 'other',
            header: bytes(privateHeader), updatedAt: new Date(0) } });
        const annotatedHeader = { kind: 'approval_request.v1', approvalSubjectKey: 'managed-delete:contract' };
        const annotatedPrivate = await db.artifact.create({ data: { ...base, id: randomUUID(),
            kind: deriveArtifactStoredKindV1(annotatedHeader), header: bytes(annotatedHeader), updatedAt: new Date(0) } });
        listedIds.push(legacy.id);
        const physicalIds: string[] = [];
        let pages = 0;
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };
            const result = await listArtifactHeadersV1({ options: { browserListed: true }, encodeCursor,
                readPage: async options => {
                    const query = new URLSearchParams({ limit: String(options?.limit ?? 500) });
                    if (options?.browserListed) query.set('browserListed', 'true');
                    if (options?.unclassified) query.set('unclassified', 'true');
                    if (options?.cursor) query.set('cursor', options.cursor);
                    const response = await app.inject({ method: 'GET', url: `/v1/artifacts?${query}`, headers });
                    expect(response.statusCode, response.body).toBe(200);
                    const payload = response.json();
                    const physical = headersSchema.parse(Array.isArray(payload) ? payload : payload.items);
                    pages++;
                    physicalIds.push(...physical.map(row => row.id));
                    // Count physical responses before private-header policy filtering.
                    expect(physical).toHaveLength(listedIds.length + 2);
                    const page = pageSchema.parse(payload);
                    const items = page.items.map(row => ({ artifactId: row.id, header: ArtifactHeaderMetadataV1Schema.parse(
                        decodePlainArtifactStoredContent(row.header)), createdAt: row.createdAt, updatedAt: row.updatedAt }));
                    return { items, hasUnclassified: page.hasUnclassified, kindCoverage: page.coverage };
                },
            });
            expect(result.coverage).toBe('complete');
            expect(result.kindCoverage).toEqual({ status: 'partial', unclassifiedCount: 2, reason: 'unclassified_legacy_rows' });
            expect(new Set(result.items.map(row => row.artifactId))).toEqual(new Set(listedIds));
            expect(pages).toBe(1);
            expect(new Set(physicalIds)).toEqual(new Set([...listedIds, legacyPrivate.id, annotatedPrivate.id]));
            for (const conflicting of ['kind=other', 'kinds=%5B%5D', 'unclassified=true']) {
                expect((await app.inject({ method: 'GET', url: `/v1/artifacts?browserListed=true&${conflicting}`, headers })).statusCode).toBe(400);
            }
        });
        await db.$transaction(async tx => {
            const observed = observePrismaReads(tx, ['artifact']);
            const page = await listArtifactHeadersForCallerInTx(observed.tx, { actorAccountId: owner.id, browserListed: true, limit: 500, cursor: null });
            expect(page).toHaveLength(listedIds.length + 2);
            expect(new Set(observed.rows.flatMap(row => row.ids))).toEqual(new Set([...listedIds, legacyPrivate.id, annotatedPrivate.id]));
        }, { isolationLevel: 'RepeatableRead' });
    });

    it('keeps SQL grant candidates equal to Prisma admission through direct, Team, Group and lifecycle changes', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const otherMember = await db.account.create({ data: { encryptionMode: 'plain' } });
        const makeDocument = (accountId: string, unreadable = false) => db.artifact.create({ data: {
            id: randomUUID(), accountId, kind: 'v1:other:', header: unreadable ? new Uint8Array([0xff]) : bytes({}),
            body: new Uint8Array([0xff]), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1,
        } });
        const owned = await makeDocument(reader.id);
        const direct = await makeDocument(owner.id);
        const teamDocument = await makeDocument(owner.id);
        const groupDocument = await makeDocument(owner.id);
        const denied = await makeDocument(owner.id);
        const unreadable = await makeDocument(owner.id, true);
        for (const document of [direct, unreadable]) await db.artifactGrant.create({ data: { principalKind: 'account',
            artifactId: document.id, accountId: reader.id, accessLevel: 'view', createdByAccountId: owner.id,
        } });
        const team = await db.team.create({ data: { name: 'Artifact access contract' } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: 'member' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: otherMember.id, role: 'member' } });
        await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: teamDocument.id, teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const groupTeam = await db.team.create({ data: { name: 'Artifact Group access contract' } });
        const groupMember = await db.teamMembership.create({ data: { teamId: groupTeam.id, accountId: reader.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: groupTeam.id, name: 'Artifact Group', nameKey: randomUUID() } });
        await db.teamGroupMembership.create({ data: { teamId: groupTeam.id, teamGroupId: group.id, teamMembershipId: groupMember.id } });
        await db.artifactGrant.create({ data: { principalKind: 'group', artifactId: groupDocument.id, teamGroupId: group.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const allIds = [owned, direct, teamDocument, groupDocument, denied, unreadable].map(row => row.id);
        const verify = async (expectedIds: readonly string[]) => db.$transaction(async tx => {
            const table = prismaRuntime.raw(provider === 'mysql' ? '`Artifact`' : '"Artifact"');
            const candidates = await tx.$queryRaw<Array<{ id: string }>>(prismaRuntime.sql`
                SELECT a.id FROM ${table} a WHERE a.id IN (${prismaRuntime.join(allIds)})
                AND ${resourceGrants.resourceGrantAccessSqlPredicate({ actorAccountId: reader.id,
                    resourceTablePrefix: 'Artifact', resourceIdColumn: 'artifactId' })}`);
            const canonical = await tx.artifact.findMany({ where: { id: { in: allIds }, ...await readArtifactCandidateWhereInTx(tx, reader.id) }, select: { id: true } });
            expect(new Set(candidates.map(row => row.id))).toEqual(new Set(expectedIds));
            expect(new Set(canonical.map(row => row.id))).toEqual(new Set(expectedIds));
            // Candidate discovery never replaces current private-content admission.
            const page = await listArtifactHeadersForCallerInTx(tx, { actorAccountId: reader.id, browserListed: true, limit: 500, cursor: null });
            expect(new Set(page.map(row => row.id))).toEqual(new Set(expectedIds.filter(id => id !== unreadable.id)));
        }, { isolationLevel: 'RepeatableRead' });
        const initial = [owned.id, direct.id, teamDocument.id, groupDocument.id, unreadable.id];
        await verify(initial);
        await db.teamMembership.update({ where: { id: member.id }, data: { status: 'suspended' } });
        await verify(initial.filter(id => id !== teamDocument.id));
        await db.teamMembership.update({ where: { id: member.id }, data: { status: 'active' } });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        await verify(initial.filter(id => id !== teamDocument.id));
        await db.team.update({ where: { id: team.id }, data: { archivedAt: null } });
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        await verify(initial.filter(id => id !== groupDocument.id));
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: null } });
        await db.teamMembership.update({ where: { id: groupMember.id }, data: { status: 'suspended' } });
        await verify(initial.filter(id => id !== groupDocument.id));
        await db.teamMembership.update({ where: { id: groupMember.id }, data: { status: 'active' } });
        await db.team.update({ where: { id: groupTeam.id }, data: { archivedAt: new Date() } });
        await verify(initial.filter(id => id !== groupDocument.id));
        await db.team.update({ where: { id: groupTeam.id }, data: { archivedAt: null } });
        await db.account.update({ where: { id: reader.id }, data: { status: 'suspended' } });
        await verify([owned.id]);
        await db.account.update({ where: { id: reader.id }, data: { status: 'active' } });
        await db.artifactGrant.delete({ where: { principalKind: 'account', artifactId_accountId: { artifactId: direct.id, accountId: reader.id } } });
        await verify(initial.filter(id => id !== direct.id));
        await db.teamGroupMembership.delete({ where: { teamGroupId_teamMembershipId: { teamGroupId: group.id, teamMembershipId: groupMember.id } } });
        await verify([owned.id, teamDocument.id, unreadable.id]);
    });

    it('preserves the owner intersection and updated-at/id keyset over repeated browser pages', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const data = { kind: 'v1:other:', header: bytes({}), body: new Uint8Array([0xff]),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 };
        const rows = await Promise.all(Array.from({ length: 6 }, (_, index) => db.artifact.create({ data: {
            ...data, id: randomUUID(), accountId: owner.id, updatedAt: new Date(index < 3 ? 0 : 1),
        } })));
        const shared = await db.artifact.create({ data: { ...data, id: randomUUID(), accountId: foreign.id } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: shared.id, accountId: owner.id,
            accessLevel: 'view', createdByAccountId: foreign.id } });
        const seen: string[] = [];
        let cursor: Parameters<typeof listArtifactHeadersForCallerInTx>[1]['cursor'] = null;
        do {
            const after = cursor;
            const page: Awaited<ReturnType<typeof listArtifactHeadersForCallerInTx>> = await db.$transaction(tx => listArtifactHeadersForCallerInTx(tx, {
                actorAccountId: owner.id, ownerAccountId: owner.id, browserListed: true, limit: 2, cursor: after,
            }), { isolationLevel: 'RepeatableRead' });
            seen.push(...page.map(row => row.id));
            const last = page.at(-1);
            cursor = page.length === 2 && last ? { updatedAt: last.updatedAt, id: last.id } : null;
        } while (cursor);
        expect(seen).toEqual(rows.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
            || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0)).map(row => row.id));
    });
});
