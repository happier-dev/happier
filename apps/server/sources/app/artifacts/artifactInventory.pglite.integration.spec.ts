import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { ArtifactReadHeadersBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { applyPostgresMigrations } from '../../../scripts/prismaMigrations';
import { openPgliteMigrationSession, type PgliteMigrationSession } from '../../../scripts/pgliteMigrationSession';
import { db, initDbPostgres, shutdownDbClient, prismaRuntime } from '@/storage/db';
import { resourceGrantAccessSqlPredicate, resourceGrantArmWheres } from '@/app/teams/resourceGrantAccess';
import { readMachineAudienceAccountIdsInTx, readMachineRecipientWorkInTx } from '@/app/machines/machineRecipientWork';
import { createSavedSecretResourceInTx, listSavedSecretResourceMaterialsForAccountInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { inTx } from '@/storage/inTx';
import { readArtifactCandidateWhereInTx } from './artifactAccessService';
import { artifactPageReadCaptureSql, materializeArtifactPageRead, type ArtifactPageReadCapture } from './artifactPageReadCapture';
import { projectArtifactSourceReadersFromFacts } from './artifactSourceReaders';
import { createProjectSourceInTx, resolveProjectSourceAccessInTx } from '@/app/projects/sources/projectSourceService';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol';
import { listDeploymentDataPageInTx } from '@/app/deployments/deploymentAccountPageReadService';
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import type { Tx } from '@/storage/inTx';

describe('Artifact inventory through PostgreSQL wire protocol', () => {
    const originalEnv = snapshotEnv();
    let root: string | undefined;
    let session: PgliteMigrationSession | undefined;
    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-artifact-inventory-pg-'));
        const databaseDir = join(root, 'pglite');
        const database = new PGlite(databaseDir);
        try {
            await database.waitReady;
            await applyPostgresMigrations({ db: database, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        } finally { await database.close(); }
        applyEnvValues({ HAPPIER_SERVER_LIGHT_DB_DIR: databaseDir, HAPPIER_SERVER_LIGHT_DATA_DIR: root });
        session = await openPgliteMigrationSession(process.env, { purpose: 'artifact-inventory-test' });
        // Use the deployed PostgreSQL Prisma client/query strategy, not the PGlite adapter.
        applyEnvValues({ HAPPIER_DB_PROVIDER: 'postgres', HAPPY_DB_PROVIDER: 'postgres', DATABASE_URL: session.databaseUrl });
        initDbPostgres();
        await db.$connect();
    }, 120_000);
    afterAll(async () => {
        try { await shutdownDbClient(); } finally {
            await session?.close();
            restoreEnv(originalEnv);
            if (root) await rm(root, { recursive: true, force: true });
        }
    });

    it('opens captured page content only through current Artifact grants and Account mode', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const artifact = await db.artifact.create({ data: {
            id: randomUUID(), accountId: owner.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: 'Captured' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: 'Page content' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1,
        } });
        const read = async (actorAccountId: string) => {
            const [row] = await db.$queryRaw<Array<{ capture: ArtifactPageReadCapture }>>(artifactPageReadCaptureSql({
                actorAccountId, artifactId: prismaRuntime.sql`${artifact.id}`,
            }));
            return materializeArtifactPageRead(row?.capture ?? null, { actorAccountId, sourceReaderAccounts: [] });
        };
        expect(await read(reader.id)).toEqual({ ok: false, error: 'artifact_not_found' });
        expect(await read(owner.id)).toMatchObject({ ok: true, artifact: { id: artifact.id, access: 'owner', publicAudience: 'none' } });
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        expect(await read(reader.id)).toMatchObject({ ok: true, artifact: { body: artifact.body, access: 'view' } });
        await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
        expect(await read(owner.id)).toMatchObject({ ok: false, error: 'artifact_content_unavailable' });
    });

    it('derives captured readers from an actual Team Source content reference only while admin custody holds', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Captured Source custody' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: member.id, role: 'member' },
        ] });
        const created = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId: `srv_${'c'.repeat(32)}`, requestKey: randomUUID(), name: 'Captured Source',
            owner: { kind: 'team', teamId: team.id }, audience: [],
        }));
        if (!created.ok) throw new Error(created.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        const artifact = await db.artifact.create({ data: {
            id: randomUUID(), accountId: owner.id, kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: 'Captured Source' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1,
        } });
        const environment = await db.deploymentEnvironment.create({ data: {
            projectSourceId: created.source.id, createdByAccountId: owner.id,
            controllerMachineId: machine.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        } });
        const admission = await inTx(tx => resolveProjectSourceAccessInTx(tx, member.id, created.source.id));
        if (!admission.ok) throw new Error(JSON.stringify(admission.failure));
        const readers = [{ accountId: member.id, account: { status: member.status } }];
        const capturedReaders = async () => {
            const [row] = await db.$queryRaw<Array<{ capture: ArtifactPageReadCapture }>>(artifactPageReadCaptureSql({
                actorAccountId: member.id, artifactId: prismaRuntime.sql`${artifact.id}`,
            }));
            return projectArtifactSourceReadersFromFacts({ artifact: row!.capture,
                reference: { projectSourceId: environment.projectSourceId, contentArtifactId: environment.contentArtifactId,
                    expectedStoredKind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 },
                admittedSource: admission, readers });
        };
        expect(await capturedReaders()).toEqual([]);
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id,
            accessLevel: 'admin', createdByAccountId: owner.id } });
        expect(await capturedReaders()).toEqual(readers);
        const pageEnv = snapshotEnv();
        const statements: string[] = [];
        const client = new PrismaClient({ datasources: { db: { url: session!.databaseUrl } },
            log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event.query));
        // The framed PGlite harness holds runExclusive for a connection's lifetime.
        await db.$disconnect();
        try {
            await client.$connect();
            // Exercise the default embedded-Home provider decision over the same PostgreSQL wire engine.
            applyEnvValues({ HAPPIER_DB_PROVIDER: 'pglite', HAPPY_DB_PROVIDER: 'pglite',
                HAPPIER_SERVER_IDENTITY_ID: `srv_${'c'.repeat(32)}` });
            const page = () => client.$transaction(tx => listDeploymentDataPageInTx(tx, member.id, {
                serverId: `srv_${'c'.repeat(32)}`, projectSourceId: created.source.id, limit: 2,
            }));
            const dataStatements = () => statements.filter(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i.test(sql.trim()));
            statements.length = 0;
            expect(await page()).toMatchObject({ ok: true, coverage: 'complete',
                items: [{ environment: { id: environment.id } }], artifacts: [{ id: artifact.id }] });
            expect.soft(dataStatements(), 'embedded Home page includes all Source and Artifact admission').toHaveLength(1);
            await client.artifactTeamGrant.update({ where: { artifactId_teamId: { artifactId: artifact.id, teamId: team.id } },
                data: { accessLevel: 'edit' } });
            statements.length = 0;
            expect(await page()).toMatchObject({ ok: true, coverage: 'partial', items: [], artifacts: [] });
            expect.soft(dataStatements(), 'revoked custody is captured in the same page statement').toHaveLength(1);
        } finally {
            await client.$disconnect();
            restoreEnv(pageEnv);
            await db.$connect();
        }
        expect(await capturedReaders()).toEqual([]);
    });

    it('excludes Team guests from resource SQL and grant queries while admitting explicit Group and Account guests', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Resource guest audience' } });
        const guestMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: 'guest' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Explicit guests', nameKey: randomUUID() } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
            teamMembershipId: guestMembership.id, nativeContribution: true } });
        const [teamArtifact, groupArtifact, directArtifact] = await Promise.all(['team', 'group', 'direct'].map(() => db.artifact.create({ data: {
            id: randomUUID(), accountId: owner.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'document' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: 'fixture' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1,
        } })));
        await db.artifactTeamGrant.create({ data: { artifactId: teamArtifact.id, teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await db.artifactGroupGrant.create({ data: { artifactId: groupArtifact.id, teamGroupId: group.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await db.artifactAccountGrant.create({ data: { artifactId: directArtifact.id, accountId: guest.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const artifactIds = [teamArtifact.id, groupArtifact.id, directArtifact.id];
        for (const [accountId, expectedIds] of [[guest.id, [groupArtifact.id, directArtifact.id]], [member.id, [teamArtifact.id]]] as const) {
            const sqlRows = await db.$queryRaw<Array<{ id: string }>>(prismaRuntime.sql`
                SELECT a.id FROM "Artifact" a WHERE a.id IN (${prismaRuntime.join(artifactIds)})
                AND ${resourceGrantAccessSqlPredicate({ actorAccountId: accountId,
                    resourceTablePrefix: 'Artifact', resourceIdColumn: 'artifactId' })}`);
            expect.soft(new Set(sqlRows.map(row => row.id)), `SQL audience for ${accountId}`).toEqual(new Set(expectedIds));
            const captures = await db.$queryRaw<Array<{ capture: ArtifactPageReadCapture }>>(prismaRuntime.sql`
                SELECT captured.capture FROM "Artifact" selected
                CROSS JOIN LATERAL (${artifactPageReadCaptureSql({ actorAccountId: accountId,
                    artifactId: prismaRuntime.sql`selected."id"` })}) captured
                WHERE selected."id" IN (${prismaRuntime.join(artifactIds)})`);
            const capturedIds = captures.flatMap(({ capture }) => {
                const read = materializeArtifactPageRead(capture, { actorAccountId: accountId, sourceReaderAccounts: [] });
                return read.ok ? [read.artifact.id] : [];
            });
            expect.soft(new Set(capturedIds), `captured audience for ${accountId}`).toEqual(new Set(expectedIds));
            const arms = resourceGrantArmWheres(accountId);
            const [accountRows, teamRows, groupRows] = await Promise.all([
                db.artifactAccountGrant.findMany({ where: { artifactId: { in: artifactIds }, ...arms.account }, select: { artifactId: true } }),
                db.artifactTeamGrant.findMany({ where: { artifactId: { in: artifactIds }, ...arms.team }, select: { artifactId: true } }),
                db.artifactGroupGrant.findMany({ where: { artifactId: { in: artifactIds }, ...arms.group }, select: { artifactId: true } }),
            ]);
            expect.soft(new Set([...accountRows, ...teamRows, ...groupRows].map(row => row.artifactId)),
                `Prisma grant audience for ${accountId}`).toEqual(new Set(expectedIds));
        }
    });

    it('excludes Team guests from Machine audience and recipient work while admitting explicit Group and Account guests', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Machine guest audience' } });
        const guestMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: 'guest' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Machine explicit guests', nameKey: randomUUID() } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
            teamMembershipId: guestMembership.id, nativeContribution: true } });
        const [teamMachine, groupMachine, directMachine] = await Promise.all(['team', 'group', 'direct'].map(() => db.machine.create({
            data: { id: randomUUID(), accountId: owner.id, metadata: 'fixture' },
        })));
        await db.machineTeamGrant.create({ data: { machineId: teamMachine.id, teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await db.machineGroupGrant.create({ data: { machineId: groupMachine.id, teamGroupId: group.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await db.machineAccountGrant.create({ data: { machineId: directMachine.id, accountId: guest.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const machines = [teamMachine, groupMachine, directMachine];
        const work = await readMachineRecipientWorkInTx(db, { actorAccountId: owner.id,
            ownerFingerprints: new Map(machines.map(machine => [machine.id, null])) });
        for (const [machine, expectedRecipients] of [[teamMachine, [member.id]], [groupMachine, [guest.id]], [directMachine, [guest.id]]] as const) {
            expect.soft(new Set(await readMachineAudienceAccountIdsInTx(db, machine.id)), `Machine audience for ${machine.id}`)
                .toEqual(new Set([owner.id, ...expectedRecipients]));
            expect.soft(new Set(work.get(machine.id)?.recipients.map(recipient => recipient.recipientAccountId)),
                `Machine recipient work for ${machine.id}`).toEqual(new Set(expectedRecipients));
        }
    });

    it('admits Saved Secret Group guests and Team members while denying Team guests', async () => {
        const testEnv = snapshotEnv();
        applyEnvValues({ HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: 'none' });
        try {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
            const member = await db.account.create({ data: { encryptionMode: 'plain' } });
            const team = await db.team.create({ data: { name: 'Saved Secret guest audience' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
            const guestMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: 'guest' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
            const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Secret explicit guests', nameKey: randomUUID() } });
            await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
                teamMembershipId: guestMembership.id, nativeContribution: true } });
            const groupResourceId = randomUUID();
            const teamResourceId = randomUUID();
            for (const [resourceId, audience] of [[groupResourceId, { groupGrants: [group.id] }], [teamResourceId, { teamGrants: [team.id] }]] as const) {
                expect(await inTx(tx => createSavedSecretResourceInTx(tx, {
                    accountId: owner.id, resourceId, displayName: 'Shared token', kind: 'token', encryptionMode: 'plain',
                    storedContent: { t: 'plain', v: { v: 1, name: 'Shared token', kind: 'token', value: 'fixture' } },
                    ...audience,
                }))).toMatchObject({ ok: true });
            }
            for (const [accountId, expectedIds] of [[guest.id, [groupResourceId]], [member.id, [teamResourceId]]] as const) {
                const listed = await inTx(tx => listSavedSecretResourceMaterialsForAccountInTx(tx, accountId));
                expect.soft(new Set(listed.map(row => {
                    if (!('resourceId' in row)) expect.fail('Expected healthy Saved Secret material');
                    return row.resourceId;
                })), `Saved Secret list for ${accountId}`).toEqual(new Set(expectedIds));
                const exact = await inTx(tx => listSavedSecretResourceMaterialsForAccountInTx(tx, accountId, undefined, [groupResourceId, teamResourceId]));
                expect.soft(new Set(exact.map(row => {
                    if (!('resourceId' in row)) expect.fail('Expected healthy Saved Secret material');
                    return row.resourceId;
                })), `Saved Secret exact materials for ${accountId}`).toEqual(new Set(expectedIds));
            }
            const publishedRecipients = await db.accountChange.findMany({ where: { entityId: groupResourceId, kind: 'savedSecretResource' }, select: { accountId: true } });
            expect.soft(new Set(publishedRecipients.map(row => row.accountId)), 'Saved Secret Group publication audience')
                .toEqual(new Set([owner.id, guest.id]));
        } finally { restoreEnv(testEnv); }
    });

    it('returns only the browser policy complement before paging thousands of private records', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const data = { accountId: owner.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'approval_request.v1' })),
            body: new Uint8Array([0xff]), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1 };
        const template = await db.artifact.create({ data: { ...data, id: randomUUID(), kind: 'v1:other:approval_request.v1' } });
        await db.$executeRawUnsafe(`INSERT INTO "Artifact" ("id", "accountId", "kind", "header", "headerVersion", "body", "bodyVersion",
            "dataEncryptionKey", "seq", "createdAt", "updatedAt")
            SELECT $1 || n::text, "accountId", "kind", "header", "headerVersion", "body", "bodyVersion",
                "dataEncryptionKey", "seq", "createdAt", "updatedAt"
            FROM generate_series(1, 2500) n CROSS JOIN "Artifact" WHERE "Artifact"."id" = $2`, `${randomUUID()}-`, template.id);
        const documentIds: string[] = [];
        for (const [kind, header] of [
            ['v1:other:future.document.v3', { kind: 'future.document.v3' }], ['v1:other:', {}],
            [null, { kind: 'document' }], ['other', { kind: 'document' }],
        ] as const) {
            documentIds.push((await db.artifact.create({ data: { ...data, id: randomUUID(), kind,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent(header)), updatedAt: new Date(0) } })).id);
        }
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };
            const response = await app.inject({ method: 'GET', url: '/v1/artifacts?browserListed=true&limit=500', headers });
            expect(response.statusCode, response.body).toBe(200);
            const payload = response.json();
            const physical = Array.isArray(payload) ? payload : payload.items;
            expect(physical).toHaveLength(documentIds.length);
            expect(new Set(physical.map((row: { id: string }) => row.id))).toEqual(new Set(documentIds));
            expect(payload.coverage).toEqual({ status: 'partial', unclassifiedCount: 2, reason: 'unclassified_legacy_rows' });
        });
    });

    it('selects exact kinds before paging and classifies only headers through PostgreSQL SQL', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const data = { accountId: owner.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'account_notice.v1' })),
            body: new Uint8Array([0xff]), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1 };
        const selected = await db.artifact.create({ data: { ...data, id: randomUUID(), kind: 'v1:other:account_notice.v1' } });
        for (const [count, kind] of [[500, 'v1:other:account_notice.v1'], [2500, 'v1:other:unrelated.v1']] as const) {
            // The existing PG-wire fixture clones bytea in SQL to avoid the PGlite multi-row bytea adapter trap.
            await db.$executeRawUnsafe(`INSERT INTO "Artifact" ("id", "accountId", "kind", "header", "headerVersion", "body", "bodyVersion",
                "dataEncryptionKey", "seq", "createdAt", "updatedAt")
                SELECT $1 || n::text, "accountId", $2, "header", "headerVersion", "body", "bodyVersion",
                    "dataEncryptionKey", "seq", "createdAt", "updatedAt"
                FROM generate_series(1, $3::integer) n CROSS JOIN "Artifact" WHERE "Artifact"."id" = $4`,
            `${randomUUID()}-`, kind, count, selected.id);
        }
        const legacy = await db.artifact.create({ data: { ...data, id: randomUUID(), kind: 'other' } });
        await db.publicSessionShare.create({ data: { artifactId: selected.id, createdByUserId: owner.id,
            keyDerivation: 'fragment_v1', tokenHash: randomBytes(32) } });
        const selectedIds = new Set((await db.artifact.findMany({ where: { accountId: owner.id, kind: 'v1:other:account_notice.v1' },
            select: { id: true } })).map(row => row.id));
        const headerIds: string[] = [];
        let bodyReads = 0;
        const transaction = db.$transaction;
        // Observe genuine Prisma/PG-wire acquisitions; all internal admission and SQL remain real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== 'artifact') {
                    const value = Reflect.get(inner, property, innerReceiver);
                    return typeof value === 'function' ? value.bind(inner) : value;
                }
                return new Proxy(inner.artifact, { get(delegate, operation, delegateReceiver) {
                    const value = Reflect.get(delegate, operation, delegateReceiver);
                    if (operation !== 'findMany' && operation !== 'findFirst' && operation !== 'findUnique') return value;
                    return async (...queryArgs: Parameters<typeof inner.artifact.findMany>) => {
                        const rows = await Reflect.apply(value, delegate, queryArgs);
                        const identities = (Array.isArray(rows) ? rows : rows ? [rows] : []).map(row => row.id);
                        if (queryArgs[0]?.select?.body) bodyReads += identities.length;
                        if (queryArgs[0]?.select?.header) headerIds.push(...identities);
                        return rows;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(artifactsRoutes, async app => {
                const headers = { 'x-test-user-id': owner.id,
                    'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };
                const kinds = encodeURIComponent(JSON.stringify(['account_notice.v1',
                    ...Array.from({ length: 130 }, (_, index) => `absent.${index}.v1`)]));
                const first = await app.inject({ method: 'GET', url: `/v1/artifacts?kinds=${kinds}&limit=500`, headers });
                expect(first.statusCode, first.body).toBe(200);
                expect(first.json().items).toHaveLength(500);
                expect(first.json().hasUnclassified).toBe(true);
                expect(first.json().coverage).toEqual({ status: 'partial', unclassifiedCount: 1, reason: 'unclassified_legacy_rows' });
                const last = first.json().items[499];
                const cursor = Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString('base64url');
                const second = await app.inject({ method: 'GET', url: `/v1/artifacts?kinds=${kinds}&limit=500&cursor=${cursor}`, headers });
                expect(second.statusCode, second.body).toBe(200);
                expect(second.json().items).toHaveLength(1);
                const items = [...first.json().items, ...second.json().items];
                expect(new Set(items.map(row => row.id))).toEqual(selectedIds);
                expect(items.find(row => row.id === selected.id)).toMatchObject({ kind: 'other', kindHint: 'account_notice.v1', publicAudience: 'retained' });
                expect(new Set(headerIds)).toEqual(selectedIds);
                headerIds.length = 0;
                const repaired = await app.inject({ method: 'POST', url: `/v1/artifacts/${legacy.id}`, headers,
                    payload: { kind: 'v1:other:account_notice.v1', expectedHeaderVersion: 1 } });
                expect(repaired.statusCode, repaired.body).toBe(200);
                expect(repaired.json()).toEqual({ success: true });
                expect(new Set(headerIds)).toEqual(new Set([legacy.id]));
                expect(await db.artifact.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({
                    kind: 'v1:other:account_notice.v1', headerVersion: 1, bodyVersion: 1, body: data.body });
                expect((await app.inject({ method: 'GET', url: `/v1/artifacts?kinds=${kinds}&limit=1`, headers })).json().coverage)
                    .toEqual({ status: 'complete', unclassifiedCount: 0 });
                headerIds.length = 0;
                // Empty item demand still reports the actual scoped legacy count, without opening private bytes.
                await db.artifact.update({ where: { id: legacy.id }, data: { kind: 'other' } });
                const empty = await app.inject({ method: 'GET', url: '/v1/artifacts?kinds=%5B%5D&includeBody=true', headers });
                expect(empty.statusCode, empty.body).toBe(200);
                expect(empty.json()).toEqual({ items: [], hasUnclassified: true,
                    coverage: { status: 'partial', unclassifiedCount: 1, reason: 'unclassified_legacy_rows' } });
                expect(headerIds).toEqual([]);
                expect(bodyReads).toBe(0);
            });
        } finally { db.$transaction = transaction; }
    });

    it('pages beyond the bind boundary and projects current public audience without foreign rows', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const data = (accountId: string) => ({ id: randomUUID(), accountId,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: 'fixture' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 });
        const template = await db.artifact.create({ data: data(owner.id) });
        const hidden = await db.artifact.create({ data: data(foreign.id) });
        await db.$executeRawUnsafe(`INSERT INTO "Artifact" ("id", "accountId", "header", "headerVersion", "body", "bodyVersion",
            "dataEncryptionKey", "seq", "createdAt", "updatedAt")
            SELECT $1 || lpad(n::text, 5, '0'), "accountId", "header", "headerVersion", "body", "bodyVersion",
                "dataEncryptionKey", "seq", "createdAt", "updatedAt"
            FROM generate_series(1, 35000) n CROSS JOIN "Artifact" WHERE "Artifact"."id" = $2`, `pg-${template.id.slice(0, 8)}-`, template.id);
        const newest = await db.artifact.create({ data: { ...data(owner.id), updatedAt: new Date(template.updatedAt.getTime() + 1) } });
        const publication = await db.publicSessionShare.create({ data: { artifactId: newest.id,
            createdByUserId: owner.id, keyDerivation: 'fragment_v1', tokenHash: new Uint8Array(32) } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };
            const read = async (cursor?: string) => {
                const response = await app.inject({ method: 'GET', url: `/v1/artifacts?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, headers });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            };
            const first = await read();
            expect(first).toHaveLength(2);
            expect(first).toMatchObject([{ id: newest.id, publicAudience: 'retained' }, { publicAudience: 'none' }]);
            const last = first[first.length - 1];
            const cursor = Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString('base64url');
            const second = await read(cursor);
            const ids = [...first, ...second].map((row: { id: string }) => row.id);
            expect(new Set(ids).size).toBe(4);
            expect(ids).not.toContain(hidden.id);
            const expected = await db.artifact.findMany({ where: { accountId: owner.id },
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 4, select: { id: true } });
            expect(ids).toEqual(expected.map(row => row.id));
            const fullPage = await app.inject({ method: 'GET', url: '/v1/artifacts?limit=500', headers });
            expect(fullPage.statusCode, fullPage.body).toBe(200);
            expect(fullPage.json()).toHaveLength(500);
            expect(fullPage.json()[0]).toMatchObject({ id: newest.id, publicAudience: 'retained' });
            await db.publicSessionShare.delete({ where: { id: publication.id } });
            expect((await read())[0]).toMatchObject({ id: newest.id, publicAudience: 'none', headerVersion: 1, bodyVersion: 1 });
            const retained = await db.artifact.findMany({ where: { accountId: owner.id }, take: 35000, select: { id: true } });
            await db.publicSessionShare.create({ data: { artifactId: retained[0].id,
                createdByUserId: owner.id, keyDerivation: 'fragment_v1', tokenHash: new Uint8Array(32) } });
            const detail = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers,
                payload: { artifactIds: [...retained.map(row => row.id), hidden.id] } });
            expect(detail.statusCode, detail.body).toBe(200);
            const items = detail.json().items;
            expect(items).toHaveLength(35001);
            const expectedBody = encodePlainArtifactStoredContent({ value: 'fixture' });
            expect(items.slice(0, 35000).every((item: { ok: boolean; artifact?: { access: string; bodyVersion: number; body: string }; recipientCensus: unknown }) =>
                item.ok && item.artifact?.access === 'owner' && item.artifact.bodyVersion === 1
                && item.artifact.body === expectedBody && item.recipientCensus === null)).toBe(true);
            expect(items[0]).toMatchObject({ artifact: { publicAudience: 'retained' } });
            expect(items.slice(1, 35000).every((item: { artifact: { publicAudience: string } }) => item.artifact.publicAudience === 'none')).toBe(true);
            expect(items.map((item: { artifactId: string }) => item.artifactId)).toEqual([...retained.map(row => row.id), hidden.id]);
            expect(items[35000]).toMatchObject({ artifactId: hidden.id, ok: false, error: 'artifact_not_found' });
            const headersOnly = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers,
                payload: { artifactIds: [...retained.map(row => row.id), hidden.id], projection: 'headers' } });
            expect(headersOnly.statusCode, headersOnly.body).toBe(200);
            const narrow = ArtifactReadHeadersBatchResponseV1Schema.parse(headersOnly.json());
            expect(narrow.items.map(item => item.artifactId)).toEqual([...retained.map(row => row.id), hidden.id]);
            expect(narrow.items[0]).toMatchObject({ ok: true, artifact: { publicAudience: 'retained', bodyVersion: 1 } });
            expect(narrow.items.slice(0, 35000).every(item => item.ok && !('body' in item.artifact) && !('recipientCensus' in item))).toBe(true);
            expect(narrow.items[35000]).toMatchObject({ artifactId: hidden.id, ok: false, error: 'artifact_not_found' });
        });
    });

    it('keeps direct, Team and Group candidates subject to current access admission', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const artifacts = await Promise.all(['direct', 'team', 'group'].map(() => db.artifact.create({ data: {
            id: randomUUID(), accountId: owner.id, kind: 'skill',
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: 'fixture' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1,
        } })));
        await db.artifactAccountGrant.create({ data: { artifactId: artifacts[0].id, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const team = await db.team.create({ data: { name: 'Inventory Team' } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Inventory Group', nameKey: randomUUID() } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
            teamMembershipId: member.id, nativeContribution: true } });
        await db.artifactTeamGrant.create({ data: { artifactId: artifacts[1].id, teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await db.artifactGroupGrant.create({ data: { artifactId: artifacts[2].id, teamGroupId: group.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const selectedIds = [...artifacts.map(row => row.id), ...Array.from({ length: 34997 }, (_, index) => `missing-${index}`)];
            const readBatch = async () => {
                const response = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers: {
                    'x-test-user-id': reader.id,
                    'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                }, payload: { artifactIds: selectedIds } });
                expect(response.statusCode, response.body).toBe(200);
                const items = response.json().items;
                expect(items.map((item: { artifactId: string }) => item.artifactId)).toEqual(selectedIds);
                expect(items.slice(3).every((item: { ok: boolean; error: string }) => !item.ok && item.error === 'artifact_not_found')).toBe(true);
                return items.slice(0, 3);
            };
            const read = async () => {
                const candidates = await db.$queryRaw<Array<{ id: string }>>(prismaRuntime.sql`
                    SELECT a.id FROM "Artifact" a WHERE a.id IN (${prismaRuntime.join(artifacts.map(row => row.id))})
                    AND ${resourceGrantAccessSqlPredicate({ actorAccountId: reader.id,
                        resourceTablePrefix: 'Artifact', resourceIdColumn: 'artifactId' })}`);
                const admitted = await db.artifact.findMany({ where: { id: { in: artifacts.map(row => row.id) },
                    ...await readArtifactCandidateWhereInTx(db, reader.id) }, select: { id: true } });
                expect(new Set(candidates.map(row => row.id))).toEqual(new Set(admitted.map(row => row.id)));
                const result = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill&limit=3', headers: {
                    'x-test-user-id': reader.id,
                    'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                } });
                expect(result.statusCode, result.body).toBe(200);
                return result.json();
            };
            expect((await read()).items.map((row: { id: string }) => row.id).sort()).toEqual(artifacts.map(row => row.id).sort());
            expect(await readBatch()).toMatchObject(artifacts.map(() => ({ ok: true, artifact: { access: 'view' }, recipientCensus: null })));
            await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
            expect((await read()).items).toMatchObject([{ id: artifacts[0].id, access: 'view' }]);
            expect(await readBatch()).toMatchObject([{ ok: true, artifact: { access: 'view' } },
                { ok: false, error: 'artifact_not_found' }, { ok: false, error: 'artifact_not_found' }]);
            await db.artifactAccountGrant.deleteMany({ where: { accountId: reader.id } });
            expect((await read()).items).toEqual([]);
            expect(await readBatch()).toMatchObject(artifacts.map(() => ({ ok: false, error: 'artifact_not_found' })));
        });
    });
});
