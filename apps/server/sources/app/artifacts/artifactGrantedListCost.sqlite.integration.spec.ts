import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import type { Prisma } from '@prisma/client';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { createDbMaintenanceClient, onDbClientQuery } from '@/storage/prisma';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { storedPlainPrivateLabel } from '@/testkit/privateLabelFixture';
import { listArtifactHeaderPageForCaller } from './artifactAccessService';

const postgres = Boolean(process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL);
const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
const boundValues = (value: unknown): number => Array.isArray(value) ? value.reduce<number>((sum, item) => sum + boundValues(item), 0)
    : value !== null && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Uint8Array)
        ? Object.values(value).reduce<number>((sum, item) => sum + boundValues(item), 0)
        : typeof value === 'boolean' ? 0 : 1;
const transferredBytes = (value: unknown) => {
    let total = 0;
    JSON.stringify(value, (_key, item: unknown) => {
        if (item instanceof Uint8Array) { total += item.byteLength; return undefined; }
        if (typeof item === 'string') total += item.length;
        return item;
    });
    return total;
};

/**
 * Cost contract of one shared-Artifact list page: what the page reads and binds is
 * bounded by the page, never by how many Artifacts every grant arm shares with the reader.
 */
describe(`shared Artifact list page cost (${postgres ? 'postgres' : 'sqlite'})`, () => {
    it('reads one kind-filtered page without materializing every received grant', async () => {
        if (postgres) {
            initDbPostgres();
            await db.$connect();
        }
        const harness = postgres ? { close: shutdownDbClient } : await createLightSqliteHarness({ tempDirPrefix: 'artifact-list-cost-',
            initAuth: false, env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' } });
        const plainAtRest = process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST;
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = 'none';
        const client = await createDbMaintenanceClient(postgres ? 'postgres' : 'sqlite', undefined, { log: [{ emit: 'event', level: 'query' }] });
        const statements: Array<{ query: string; params: string }> = [];
        onDbClientQuery(client, event => statements.push(event));
        const originalTransaction = db.$transaction;
        try {
            const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const team = await db.team.create({ data: { name: 'Shared inventory' } });
            const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: 'member' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
            const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Readers') } });
            await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true } });
            const template = (accountId: string, kind: string, updatedAt: Date) => ({ accountId, header: bytes({ kind }), kind: deriveArtifactStoredKindV1({ kind }),
                body: bytes({ body: 'private' }), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
                headerVersion: 1, bodyVersion: 1, id: randomUUID(), updatedAt });
            const arms = ['account', 'team', 'group'] as const;
            const grant = (artifactId: string, arm: typeof arms[number]): Prisma.ArtifactGrantCreateManyInput => ({ artifactId, principalKind: arm,
                accessLevel: 'view', createdByAccountId: owner.id, ...(arm === 'account' ? { accountId: reader.id }
                    : arm === 'team' ? { teamId: team.id } : { teamGroupId: group.id }) });
            // The demanded rows are the oldest, so the page must look past every newer unrelated share.
            const wanted = [
                template(owner.id, 'cost.wanted.v1', new Date(1000)),
                template(owner.id, 'cost.wanted.v1', new Date(2000)),
                template(owner.id, 'cost.wanted.v1', new Date(3000)),
                template(reader.id, 'cost.wanted.v1', new Date(1500)),
            ];
            await db.artifact.createMany({ data: wanted });
            await db.artifactGrant.createMany({ data: [grant(wanted[0]!.id, 'account'), grant(wanted[1]!.id, 'team'), grant(wanted[2]!.id, 'group')] });
            const expected = [...wanted].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()).map(row => row.id);
            db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
                return Reflect.apply(client.$transaction, client, args);
            } });
            const scales = (process.env.HAPPIER_ARTIFACT_LIST_COST_SCALES ?? '300,1500').split(',').map(Number);
            const measured: Array<{ shared: number; failed: string | null; statements: number; maxParams: number; paramChars: number;
                requests: number; maxRequestValues: number; grantRows: number; artifactRows: number; resultBytes: number; elapsedMs: number }> = [];
            let shared = 0;
            for (const scale of scales) {
                const noise = Array.from({ length: scale - shared }, (_, index) => template(owner.id, 'cost.noise.v1', new Date(10_000 + shared + index)));
                for (let offset = 0; offset < noise.length; offset += 2000) {
                    const chunk = noise.slice(offset, offset + 2000);
                    await db.artifact.createMany({ data: chunk });
                    await db.artifactGrant.createMany({ data: chunk.map((row, index) => grant(row.id, arms[(shared + offset + index) % 3]!)) });
                }
                shared = scale;
                for (const pass of ['warm', 'measured'] as const) {
                    statements.length = 0;
                    const reads = { requests: 0, maxRequestValues: 0, grantRows: 0, artifactRows: 0, resultBytes: 0 };
                    const stop = observePrismaRequests(db, { after: (request, result) => {
                        reads.requests++;
                        reads.maxRequestValues = Math.max(reads.maxRequestValues, boundValues(request.args));
                        const rows = Array.isArray(result) ? result.length : result ? 1 : 0;
                        if (request.model === 'ArtifactGrant') reads.grantRows += rows;
                        if (request.model === 'Artifact') reads.artifactRows += rows;
                        reads.resultBytes += transferredBytes(result);
                    } });
                    const started = performance.now();
                    let page: Awaited<ReturnType<typeof listArtifactHeaderPageForCaller>> | Error;
                    try {
                        page = await listArtifactHeaderPageForCaller({ actorAccountId: reader.id, cursor: null, limit: 50, kinds: ['cost.wanted.v1'] });
                    } catch (error) {
                        page = error instanceof Error ? error : new Error(String(error));
                    } finally { stop(); }
                    const elapsedMs = performance.now() - started;
                    if (!(page instanceof Error)) {
                        expect(page.items.map(item => item.id)).toEqual(expected);
                        expect(page.coverage).toEqual({ status: 'complete', unclassifiedCount: 0 });
                    }
                    if (pass === 'warm') continue;
                    measured.push({ shared: scale, failed: page instanceof Error ? page.message.split('\n').filter(Boolean).at(-1)! : null,
                        statements: statements.length,
                        maxParams: Math.max(0, ...statements.map(statement => (JSON.parse(statement.params) as unknown[]).length)),
                        paramChars: statements.reduce((sum, statement) => sum + statement.params.length, 0),
                        ...reads, elapsedMs: Math.round(elapsedMs * 10) / 10 });
                }
            }
            console.info(`artifact list page cost ${postgres ? 'postgres' : 'sqlite'} ${JSON.stringify(measured)}`);
            // Same operations, statements and binds at every inventory size; grant rows never reach the app server.
            expect(measured.filter(row => row.failed !== null)).toEqual([]);
            const shape = (row: typeof measured[number]) => ({ requests: row.requests, maxRequestValues: row.maxRequestValues,
                statements: row.statements, maxParams: row.maxParams, grantRows: row.grantRows });
            const [first, ...rest] = measured;
            for (const row of rest) expect(shape(row)).toEqual(shape(first!));
            expect(first!.grantRows).toBe(0);
        } finally {
            db.$transaction = originalTransaction;
            if (plainAtRest === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST;
            else process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = plainAtRest;
            await client.$disconnect();
            await harness.close();
        }
    }, 600_000);
});
