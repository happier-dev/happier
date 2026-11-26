import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactStorageUsageV1Schema, StorageInventoryV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { deriveArtifactStoredKindV1, encodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { db, initDbMysql, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { readStorageInventoryInTx } from './artifactStorageService';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { auth } from '@/app/auth/auth';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { publicProfilePictureAppliedReuseKey } from '@/storage/privateFiles/accountPrivateFileCustody';
import { initFilesLocalFromEnv, loadFiles, readPrivateFile, writePrivateFile } from '@/storage/blob/files';

describe('Account storage and admitted Artifact page', () => {
    it('measures only the authenticated Account while including admitted shared rows in the page', async () => {
        const postgresUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        const mysqlUrl = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;
        const testDatabaseUrl = postgresUrl ?? mysqlUrl;
        if (testDatabaseUrl && process.env.DATABASE_URL !== testDatabaseUrl) {
            throw new Error('The inventory contract requires a disposable provider test database');
        }
        const harness = testDatabaseUrl ? { close: shutdownDbClient } : await createLightSqliteHarness({
            tempDirPrefix: 'artifact-storage-inventory-', initAuth: false, initFiles: true,
        });
        const filesDir = testDatabaseUrl ? await mkdtemp(join(tmpdir(), 'artifact-storage-inventory-pg-')) : undefined;
        if (postgresUrl) initDbPostgres();
        else if (mysqlUrl) await initDbMysql();
        vi.stubEnv('HANDY_MASTER_SECRET', 'test-storage-inventory-secret');
        vi.stubEnv('HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES', undefined);
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        try {
            if (filesDir) {
                vi.stubEnv('HAPPIER_SERVER_LIGHT_DATA_DIR', filesDir);
                initFilesLocalFromEnv(process.env);
                await loadFiles();
            }
            artifactsRoutes(app);
            await auth.init();
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
            const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
            const headers = { authorization: `Bearer ${token}` };
            const encoded = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
            const makeArtifact = (accountId: string, title: string) => db.artifact.create({ data: {
                id: randomUUID(), accountId, header: encoded({ title }), body: encoded({ body: title }),
                headerVersion: 1, bodyVersion: 2, dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            } });
            const own = await makeArtifact(owner.id, 'Own');
            const currentBlob = await db.artifactBlob.create({ data: { id: randomUUID(), artifactId: own.id, storedSizeBytes: 13n,
                storageKey: `artifacts/${own.id}/${randomUUID()}`, encryptionMode: 'plain' } });
            const historicalBlob = await db.artifactBlob.create({ data: { id: randomUUID(), artifactId: own.id, storedSizeBytes: 17n,
                storageKey: `artifacts/${own.id}/${randomUUID()}`, encryptionMode: 'plain' } });
            const currentBytes = new Uint8Array(13).fill(1);
            await writePrivateFile(currentBlob.storageKey, currentBytes);
            await writePrivateFile(historicalBlob.storageKey, Buffer.alloc(17, 2));
            const revision = await db.artifactRevision.create({ data: { artifactId: own.id, bodyVersion: 1,
                body: encoded({ body: 'Earlier' }), blobId: historicalBlob.id } });
            await db.artifact.update({ where: { id: own.id }, data: { currentBlobId: currentBlob.id } });
            const plugin = await makeArtifact(owner.id, 'Plugin package');
            await db.accountPluginRelease.create({ data: { accountId: owner.id, pluginId: 'test.inventory', version: '1.0.0',
                archiveDigestSha256: '0'.repeat(64), normalizedManifest: {}, collectionContracts: [], uiSlots: [],
                packageAssetArtifactId: plugin.id } });
            await db.pluginCollectionUsage.createMany({ data: [owner.id, foreign.id].map(accountId => ({
                accountId, pluginId: 'test.inventory', collectionId: 'fixtures', encodedBytes: 23n, rows: 1n,
            })) });
            await db.accountPetPackage.createMany({ data: [
                { accountId: owner.id, sizeBytes: 29, deletedAt: null },
                { accountId: owner.id, sizeBytes: 31, deletedAt: new Date() },
                { accountId: foreign.id, sizeBytes: 37, deletedAt: null },
            ].map(row => ({ ...row, id: randomUUID(), packageFormat: 'fixture', manifest: {}, digest: randomUUID(), origin: {} })) });
            const discussionIds = [];
            for (const [accountId, bytes] of [[owner.id, 41n], [foreign.id, 43n]] as const) {
                const discussion = await db.discussion.create({ data: { ownerAccountId: accountId, encryptionMode: 'plain',
                    dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
                    creationLocalId: randomUUID(), creationEqualityEvidenceV1: {},
                    titleContent: {}, lastMessageAt: new Date() } });
                discussionIds.push(discussion.id);
                const message = await db.discussionMessage.create({ data: { discussionId: discussion.id, localId: randomUUID(),
                    requestEqualityEvidenceV1: {}, seq: 1, authorAccountId: foreign.id, content: {} } });
                const blobId = randomUUID();
                await db.discussionAttachment.create({ data: { blobId, messageId: message.id, storageKey: blobId,
                    encryptionMode: 'plain', storedSizeBytes: bytes } });
            }
            const shared = await makeArtifact(foreign.id, 'Shared');
            const hidden = await makeArtifact(foreign.id, 'Hidden');
            await db.artifactGrant.create({ data: { artifactId: shared.id, principalKind: 'account', accountId: owner.id,
                accessLevel: 'view', createdByAccountId: foreign.id } });
            const inventoryPath = '/v1/artifacts/storage/usage?inventory=true';
            expect((await app.inject({ url: inventoryPath })).statusCode).toBe(401);
            const artifactItems = await app.inject({ url: `${inventoryPath}&paged=true&kinds=artifacts,artifactOldVersions,pluginArtifacts`, headers });
            expect(artifactItems.statusCode, artifactItems.body).toBe(200);
            expect(artifactItems.json().page.items).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: own.id, kind: 'artifacts', viewerMayTrim: true }),
                expect.objectContaining({ id: own.id, kind: 'artifactOldVersions', viewerMayTrim: true }),
                expect.objectContaining({ id: plugin.id, kind: 'pluginArtifacts', viewerMayTrim: false }),
            ]));
            expect(artifactItems.json().page.items).toHaveLength(3);
            await db.uploadedFile.create({ data: { accountId: foreign.id, path: 'foreign-profile',
                reuseKey: publicProfilePictureAppliedReuseKey } });
            await db.uploadedFile.create({ data: { accountId: owner.id, path: 'own-artifact-custody',
                reuseKey: 'artifact-blob-rejected-v1:unrelated' } });
            const historyBytes = revision.body.byteLength + 17;
            const artifacts = own.header.byteLength + own.body.byteLength + historyBytes + 13;
            const pluginArtifacts = plugin.header.byteLength + plugin.body.byteLength;
            const breakdown = { artifacts, pluginArtifacts, discussionAttachments: 41, accountPets: 29, pluginCollections: 23 };
            const totalBytes = Object.values(breakdown).reduce((total, bytes) => total + bytes, 0);
            const biggest = await app.inject({
                url: `${inventoryPath}&paged=true&kinds=artifacts,artifactOldVersions,discussionAttachments&sort=size_desc`,
                headers,
            });
            expect(biggest.statusCode, biggest.body).toBe(200);
            expect(biggest.json().page.items.map(({ kind, storedSizeBytes }: { kind: string; storedSizeBytes: number }) =>
                ({ kind, storedSizeBytes }))).toEqual([
                { kind: 'artifacts', storedSizeBytes: artifacts - historyBytes },
                { kind: 'discussionAttachments', storedSizeBytes: 41 },
                { kind: 'artifactOldVersions', storedSizeBytes: historyBytes },
            ].sort((left, right) => right.storedSizeBytes - left.storedSizeBytes));
            const inventoryResults: unknown[] = [];
            const stop = observePrismaRequests(db, { after: ({ action }, result) => {
                if (action === 'queryRaw' && Array.isArray(result) && result.some(row => row && Object.hasOwn(row, 'kind'))) {
                    inventoryResults.push(result);
                }
            } });
            const usage = await app.inject({ url: inventoryPath, headers }).finally(stop);
            expect(usage.statusCode).toBe(200);
            expect(usage.json()).toEqual({ totalBytes, byKind: breakdown, artifactLimitBytes: null,
                unmeasuredKinds: [] });
            expect(inventoryResults).toEqual([expect.arrayContaining(Object.keys(breakdown).map(kind => expect.objectContaining({ kind })))]);
            let summaryOnlyQueries = 0;
            const stopSummaryOnly = observePrismaRequests(db, { before: ({ action }) => {
                if (action === 'queryRaw') summaryOnlyQueries += 1;
            } });
            const summaryOnly = await app.inject({ url: `${inventoryPath}&paged=true&kinds=`, headers }).finally(stopSummaryOnly);
            expect(summaryOnly.statusCode, summaryOnly.body).toBe(200);
            const parsedSummary = StorageInventoryV1Schema.parse(summaryOnly.json());
            expect(parsedSummary).toMatchObject({ totalBytes, byKind: breakdown, page: { items: [] } });
            expect(parsedSummary.page?.nextCursor).toBeUndefined();
            expect(summaryOnlyQueries).toBe(1);
            vi.stubEnv('HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES', '1000');
            const quota = await app.inject({ url: '/v1/artifacts/storage/usage', headers });
            expect(quota.statusCode, quota.body).toBe(200);
            expect(quota.json()).toMatchObject({ usedBytes: artifacts, limitBytes: 1000 });
            await db.uploadedFile.create({ data: { accountId: owner.id, path: 'own-profile',
                reuseKey: publicProfilePictureAppliedReuseKey } });
            const logo = { path: 'public/teams/test/logo.png', width: 10, height: 10, thumbhash: 'test' };
            const team = await db.team.create({ data: { name: 'Owned Team', logo,
                memberships: { create: { accountId: owner.id, role: 'owner' } } } });
            await db.team.create({ data: { name: 'Foreign Team', logo, memberships: { create: [
                { accountId: foreign.id, role: 'owner' }, { accountId: owner.id, role: 'member' },
            ] } } });
            expect((await app.inject({ url: inventoryPath, headers })).json())
                .toMatchObject({ totalBytes, byKind: breakdown, artifactLimitBytes: 1000,
                    unmeasuredKinds: ['profilePictures', 'teamLogos'] });
            await db.uploadedFile.create({ data: { accountId: owner.id, path: `public/users/${owner.id}/avatars/avatar.png`,
                reuseKey: 'image-url:https://example.invalid/avatar' } });
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: owner.id } },
                data: { role: 'member' } });
            expect((await app.inject({ url: inventoryPath, headers })).json())
                .toMatchObject({ unmeasuredKinds: ['profilePictures', 'avatars'] });
            const allKinds = await inReadSnapshot(tx => readStorageInventoryInTx(tx, owner.id, {}));
            const { page, ...summary } = allKinds;
            const tablesPerStatement: string[][] = [];
            const stopItems = observePrismaRequests(db, { before: ({ action, args }) => {
                if (action !== 'queryRaw' || !args || typeof args !== 'object' || !('query' in args)
                    || typeof args.query !== 'string') return;
                tablesPerStatement.push([...new Set(Array.from(
                    args.query.matchAll(/\b(?:FROM|JOIN) ["`](\w+)["`]/gi), match => match[1]!,
                ))]);
            } });
            try {
                const pets = await inReadSnapshot(tx => readStorageInventoryInTx(tx, owner.id, { kinds: ['accountPets'] }));
                expect(pets).toEqual({
                    ...summary,
                    page: { items: page?.items.filter(item => item.kind === 'accountPets') },
                });
                expect(pets.page?.items).toMatchObject([{ kind: 'accountPets', storedSizeBytes: 29 }]);
                expect(tablesPerStatement).toHaveLength(2);
                expect(tablesPerStatement[0]).toEqual(expect.arrayContaining(['ArtifactBlob', 'AccountPetPackage']));
                expect(tablesPerStatement[1]).toEqual(['AccountPetPackage']);
            } finally { stopItems(); }
            const crossed = await app.inject({ url: `${inventoryPath}&accountId=${foreign.id}`, headers });
            expect(crossed.statusCode).toBe(400);
            const pagedPath = `${inventoryPath}&paged=true&kinds=accountPets`;
            const databasePages: number[] = [];
            const databaseSummaries: number[] = [];
            const stopPages = observePrismaRequests(db, { after: ({ action }, result) => {
                if (action !== 'queryRaw' || !Array.isArray(result)) return;
                if (result.some(row => row && Object.hasOwn(row, 'itemId'))) databasePages.push(result.length);
                if (result.some(row => row && Object.hasOwn(row, 'measuredBytes'))) databaseSummaries.push(result.length);
            } });
            try {
                const small = await app.inject({ url: pagedPath, headers });
                expect(small.statusCode, small.body).toBe(200);
                expect(small.json()).toMatchObject({ totalBytes, page: { items: [{ kind: 'accountPets', storedSizeBytes: 29 }] } });
                await db.accountPetPackage.createMany({ data: Array.from({ length: 25 }, (_, index) => ({
                    id: randomUUID(), accountId: owner.id, sizeBytes: 100 + index,
                    packageFormat: 'fixture', manifest: {}, digest: randomUUID(), origin: {},
                })) });
                const first = await app.inject({ url: pagedPath, headers });
                expect(first.statusCode, first.body).toBe(200);
                expect.soft(first.json().kinds).toMatchObject({
                    accountPets: { itemCount: 26 },
                    discussionAttachments: { itemCount: 1 },
                    profilePictures: { itemCount: 1, storedSizeBytes: null },
                    teamLogos: { itemCount: 0, storedSizeBytes: 0 },
                });
                expect(first.json().page.items.map((item: { storedSizeBytes: number }) => item.storedSizeBytes))
                    .toEqual(Array.from({ length: 10 }, (_, index) => 124 - index));
                const second = await app.inject({ url: `${pagedPath}&cursor=${first.json().page.nextCursor}`, headers });
                expect.soft(second.json().kinds).toEqual(first.json().kinds);
                expect(second.json().page.items.map((item: { storedSizeBytes: number }) => item.storedSizeBytes))
                    .toEqual(Array.from({ length: 10 }, (_, index) => 114 - index));
                expect(databasePages).toEqual([1, 11, 11]);
                expect(databaseSummaries).toEqual([8, 8, 8]);
            } finally { stopPages(); }
            const scopePath = `${inventoryPath}&paged=true&discussionId=`;
            expect((await app.inject({ url: scopePath + discussionIds[1], headers })).statusCode).toBe(404);
            const scoped = await app.inject({ url: scopePath + discussionIds[0], headers });
            expect(scoped.statusCode, scoped.body).toBe(200);
            expect.soft(scoped.json().kinds).toEqual({ discussionAttachments: { itemCount: 1, storedSizeBytes: 41 } });
            expect(scoped.json()).toMatchObject({ totalBytes: 41, artifactLimitBytes: null,
                page: { items: [{ kind: 'discussionAttachments', storedSizeBytes: 41,
                    location: { kind: 'discussion', discussionId: discussionIds[0] } }] } });
            const sizeResults: unknown[] = [];
            const stopListing = observePrismaRequests(db, { after: ({ action }, result) => {
                if (action === 'queryRaw' && Array.isArray(result) && result.some(row => row && Object.hasOwn(row, 'storedSizeBytes'))) {
                    sizeResults.push(result);
                }
            } });
            const listing = await app.inject({ url: '/v1/artifacts?includeStoredSize=true', headers }).finally(stopListing);
            expect(listing.statusCode).toBe(200);
            expect(listing.json()).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: own.id, storedSizeBytes: artifacts }),
                expect.objectContaining({ id: shared.id, storedSizeBytes: shared.header.byteLength + shared.body.byteLength }),
            ]));
            expect(listing.json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: hidden.id })]));
            expect(sizeResults).toEqual([expect.arrayContaining([
                expect.objectContaining({ artifactId: own.id }), expect.objectContaining({ artifactId: shared.id }),
            ])]);
            const revisionsUrl = `/v1/artifacts/${own.id}/revisions?projection=headers`;
            const storageReads: unknown[] = [];
            const stopRevisions = observePrismaRequests(db, { before: ({ model, args }) => {
                if (model === 'ArtifactRevision') storageReads.push(args);
            } });
            const revisions = await app.inject({ url: revisionsUrl, headers }).finally(stopRevisions);
            expect.soft(revisions.statusCode, revisions.body).toBe(200);
            expect.soft(revisions.json().revisions).toEqual([{
                bodyVersion: 1, createdAt: revision.createdAt.getTime(), sizeBytes: historyBytes,
            }]);
            expect.soft(storageReads).toEqual([]);
            const fullHistory = await app.inject({ url: `/v1/artifacts/${own.id}/revisions`, headers });
            expect(fullHistory.statusCode, fullHistory.body).toBe(200);
            expect(fullHistory.json().revisions).toMatchObject([{
                bodyVersion: 1, body: expect.any(String), sizeBytes: revision.body.byteLength,
            }]);
            expect((await app.inject({ url: `/v1/artifacts/${hidden.id}/revisions?projection=headers`, headers })).statusCode).toBe(404);
            const forbidden = await app.inject({ method: 'DELETE', url: `/v1/artifacts/${shared.id}/revisions`, headers });
            expect.soft(forbidden.statusCode).toBe(404);
            const trim = () => app.inject({ method: 'DELETE', url: `/v1/artifacts/${own.id}/revisions`, headers });
            await db.artifact.update({ where: { id: own.id },
                data: { kind: deriveArtifactStoredKindV1({ kind: APPROVAL_ARTIFACT_KINDS_V1.builtIn }) } });
            const protectedItems = await app.inject({ url: `${inventoryPath}&paged=true&kinds=artifacts,artifactOldVersions`, headers });
            expect(protectedItems.statusCode, protectedItems.body).toBe(200);
            expect(protectedItems.json().page.items).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: own.id, kind: 'artifacts', viewerMayTrim: false }),
                expect.objectContaining({ id: own.id, kind: 'artifactOldVersions', viewerMayTrim: false }),
            ]));
            expect((await trim()).statusCode).toBe(404);
            await db.artifact.update({ where: { id: own.id }, data: { kind: encodeArtifactKindV1({
                kind: 'other', kindHint: `${APPROVAL_ARTIFACT_KINDS_V1.builtIn}#${randomUUID()}`,
            }) } });
            vi.stubEnv('HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES', String(artifacts - 1));
            const exemptUsage = await app.inject({ url: '/v1/artifacts/storage/usage', headers });
            expect(exemptUsage.statusCode, exemptUsage.body).toBe(200);
            expect(ArtifactStorageUsageV1Schema.parse(exemptUsage.json())).toMatchObject({ usedBytes: 0, limitBytes: artifacts - 1 });
            const exemptInventory = await app.inject({ url: inventoryPath, headers });
            expect(exemptInventory.statusCode, exemptInventory.body).toBe(200);
            expect(StorageInventoryV1Schema.parse(exemptInventory.json())).toMatchObject({
                totalBytes: totalBytes + 25 * 112, byKind: { artifacts }, artifactBilledBytes: 0,
            });
            vi.stubEnv('HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES', '1000');
            await db.artifact.update({ where: { id: own.id }, data: { kind: own.kind, deletedAt: new Date() } });
            const retiringItems = await app.inject({ url: `${inventoryPath}&paged=true&kinds=artifacts,artifactOldVersions`, headers });
            expect(retiringItems.statusCode, retiringItems.body).toBe(200);
            expect(retiringItems.json().page.items).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: own.id, kind: 'artifacts', viewerMayTrim: false }),
                expect.objectContaining({ id: own.id, kind: 'artifactOldVersions', viewerMayTrim: false }),
            ]));
            expect((await trim()).statusCode).toBe(404);
            await db.artifact.update({ where: { id: own.id }, data: { deletedAt: null } });
            const trimmed = await trim();
            expect(trimmed.statusCode, trimmed.body).toBe(200);
            expect(trimmed.json()).toMatchObject({ artifactId: own.id, freedBytes: historyBytes,
                storageUsage: { usedBytes: artifacts - historyBytes, limitBytes: 1000 } });
            const retainedArtifact = await db.artifact.findUniqueOrThrow({ where: { id: own.id }, select: { bodyVersion: true, body: true } });
            expect(retainedArtifact.bodyVersion).toBe(own.bodyVersion);
            expect(Array.from(retainedArtifact.body)).toEqual(Array.from(own.body));
            expect(await db.artifactRevision.count({ where: { artifactId: own.id } })).toBe(0);
            expect(Array.from(await readPrivateFile(currentBlob.storageKey))).toEqual(Array.from(currentBytes));
            await expect(readPrivateFile(historicalBlob.storageKey)).rejects.toThrow();
            const profiles = [7n, null];
            await db.uploadedFile.createMany({ data: profiles.map((storedSizeBytes, index) => ({ accountId: owner.id,
                path: `picture-${index}`, reuseKey: publicProfilePictureAppliedReuseKey, storedSizeBytes })) });
            const measured = await app.inject({ url: `${inventoryPath}&paged=true&kinds=profilePictures`, headers });
            expect(measured.statusCode, measured.body).toBe(200);
            expect(measured.json()).toMatchObject({ totalBytes: totalBytes + 25 * 112 - historyBytes + 7,
                kinds: { profilePictures: { storedSizeBytes: null } },
                page: { items: [{ storedSizeBytes: 7 }, { storedSizeBytes: null }, { storedSizeBytes: null }] } });
        } finally {
            await app.close();
            await harness.close();
            if (filesDir) await rm(filesDir, { recursive: true, force: true });
            vi.unstubAllEnvs();
        }
    });
});
