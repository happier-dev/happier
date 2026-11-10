import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, DeploymentTargetLinkInputV1Schema,
    DeploymentTargetLinksListResultV1Schema } from '@happier-dev/protocol';
import { MachineDeploymentReferencesPageV1Schema } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from '@/storage/db';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { listDeploymentEnvironmentsInTx, listDeploymentReceiptsInTx, readDeploymentEnvironmentInTx, readDeploymentMachineReferencesInTx,
    readDeploymentEnvironmentAccessInTx } from './deploymentReadService';
import { linkDeploymentTargetInTx } from './deploymentTargetLinkService';
import { listDeploymentTargetLinksInTx } from './deploymentTargetLinkReadService';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { initEncrypt } from '@/modules/encrypt';
import { createDbMaintenanceClient } from '@/storage/prisma';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { createArtifact, updateArtifact } from '@/app/artifacts/artifactWriteService';
import { readArtifactForCaller } from '@/app/artifacts/artifactAccessService';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';

const provider = getDbProviderFromEnv(process.env, 'postgres');
describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('exact Machine deployment list on native providers', () => {
    const serverId = `srv_${'c'.repeat(32)}`;
    const previousIdentity = process.env.HAPPIER_SERVER_IDENTITY_ID;
    const previousMasterSecret = process.env.HANDY_MASTER_SECRET;
    let connected = false;
    beforeAll(async () => {
        const target = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID || !target || process.env.DATABASE_URL !== target) {
            throw new Error('Run with the disposable native DB-contract harness');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = serverId;
        process.env.HANDY_MASTER_SECRET ??= 'deployment-read-native-test-only';
        await initEncrypt();
        if (provider === 'mysql') await initDbMysql(); else initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        if (previousIdentity === undefined) delete process.env.HAPPIER_SERVER_IDENTITY_ID;
        else process.env.HAPPIER_SERVER_IDENTITY_ID = previousIdentity;
        if (previousMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = previousMasterSecret;
    });

    it('captures shared tunnel retirement from live Environment Domains with one admission lookup on the native provider', async () => {
        const { removeDeploymentDomainInTx } = await import('./deploymentDomainService');
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Shared tunnel consumers', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            headerVersion: 1, bodyVersion: 1, header: new Uint8Array(), body: new Uint8Array(),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const content = { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, ...content } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            createdByAccountId: owner.id, ...content } });
        const ids = [randomUUID(), randomUUID()];
        for (const id of ids) await db.deploymentDomain.create({ data: { id, environmentId: environment.id,
            targetLinkId: link.id, createdByAccountId: owner.id, state: 'removing', ...content,
            capturedPlacements: [{ placement: { serverId, accountId: owner.id, environmentId: environment.id, targetLinkId: link.id,
                domainId: id, machineId: machine.id, installationId: machine.installationId!, nativeServer: 'private',
                actionOperationId: randomUUID(), requestId: randomUUID() }, content, desired: true, listener: 'privateOrigin',
                installationPublicKey: privacyKit.encodeBase64(new Uint8Array(32)) }] } });
        const requests: { action: string; model?: string; args: unknown }[] = [];
        const stop = observePrismaRequests(db, { before: request => { requests.push(request); } });
        try {
            const remove = (id: string, expectedRevision: number) => inTx(tx => removeDeploymentDomainInTx(tx, owner.id,
                { serverId, environmentId: environment.id, domainId: id, expectedRevision, expectedDomainRevision: 1,
                    requestKey: randomUUID(), actionOperationId: randomUUID(), requestId: randomUUID() }));
            // A removing but non-tombstoned sibling is still a retained consumer.
            expect(await remove(ids[0]!, 1)).toMatchObject({ ok: true, domain: { placements: [{ retireSharedTunnel: false }] } });
            await db.deploymentDomain.update({ where: { id: ids[0]! }, data: { deletedAt: new Date() } });
            expect(await remove(ids[1]!, 2)).toMatchObject({ ok: true, domain: { placements: [{ retireSharedTunnel: true }] } });
            const reads = requests.filter(row => row.model === 'DeploymentDomain' && row.action === 'findFirst');
            expect(reads).toHaveLength(4); // Exact job row + one scope lookup per admitted removal.
            expect(requests.filter(row => row.model === 'Artifact')).toEqual([]);
        } finally { stop(); }
    });

    it('pages exact preview-template children before the native list limit without inventory fan-out', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Template previews', audience: [], repository: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/preview' }, protocol: 'https' } }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            headerVersion: 1, bodyVersion: 1, header: new Uint8Array(), body: new Uint8Array(),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const base = { projectSourceId: source.source.id, createdByAccountId: owner.id, protection: 'nonProduction',
            deployerMode: 'managers', controllerMachineId: machine.id,
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const templates = await Promise.all([0, 1].map(() =>
            db.deploymentEnvironment.create({ data: { ...base, purpose: 'standard' } })));
        const children: string[][] = [];
        for (const [index, template] of templates.entries()) {
            const link = await db.deploymentTargetLink.create({ data: { environmentId: template.id,
                createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                targetKind: 'ownServer', state: 'configured', contentArtifactId: artifact.id,
                contentHeaderVersion: 1, contentBodyVersion: 1 } });
            const ids = ['a', 'b'].map(position => `preview-${index}-${position}-${randomUUID()}`);
            await db.deploymentEnvironment.createMany({ data: ids.map((id, position) => ({ ...base, id, purpose: 'preview',
                previewTemplateEnvironmentId: template.id, previewRepositoryId: source.source.id,
                previewPullRequestId: `pr:${index}-${position}`, previewTargetLinkId: link.id })) });
            children.push(ids);
        }
        const client = await createDbMaintenanceClient(provider);
        const requests: { action: string; model?: string; args: unknown }[] = [];
        const stop = observePrismaRequests(client, { before: request => { requests.push(request); } });
        try {
            const input = { serverId, previewTemplateEnvironmentId: templates[1]!.id, limit: 1 };
            const page = await client.$transaction(tx => listDeploymentEnvironmentsInTx(tx, owner.id, input));
            expect(page).toMatchObject({ ok: true, items: [{ id: children[1]![1] }], nextCursor: children[1]![1] });
            if (!page.ok) throw new Error(page.error);
            const reads = requests.filter(row => row.model === 'DeploymentEnvironment' && row.action === 'findMany');
            expect(reads).toHaveLength(1);
            expect(reads[0]!.args).toMatchObject({ where: { purpose: 'preview', previewTemplateEnvironmentId: templates[1]!.id }, take: 2 });
            expect(requests.filter(row => row.model === 'Artifact'
                || (row.model === 'ProjectSource' || row.model === 'Machine') && row.action === 'findMany')).toEqual([]);
            const next = await client.$transaction(tx => listDeploymentEnvironmentsInTx(tx, owner.id,
                { ...input, cursor: page.nextCursor ?? undefined }));
            expect(next).toMatchObject({ ok: true, items: [{ id: children[1]![0] }], nextCursor: null });
            const exact = await client.$transaction(tx => listDeploymentEnvironmentsInTx(tx, owner.id, { serverId,
                previewRepository: { kind: 'github', deployment: 'https://github.com', repository: 'Acme/Preview' },
                previewPullRequestIds: ['pr:1-0'] }));
            expect(exact).toMatchObject({ ok: true, items: [{ id: children[1]![0] }], nextCursor: null });
            if (provider === 'postgres') {
                // This tiny fixture proves index usability, rather than scale timing.
                const plan = await client.$transaction(async tx => {
                    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
                    return tx.$queryRawUnsafe<unknown[]>(
                        'EXPLAIN (FORMAT JSON) SELECT "id" FROM "DeploymentEnvironment" WHERE "previewPullRequestId" = $1 AND "purpose" = $2 AND "deletedAt" IS NULL ORDER BY "id"',
                        'pr:1-0', 'preview');
                });
                const indexedPlan = JSON.stringify(plan);
                expect(indexedPlan).toMatch(/"Index Cond":"(?:\\.|[^"\\])*previewPullRequestId/);
                expect(indexedPlan).not.toContain('"Node Type":"Seq Scan"');
            }
        } finally { stop(); await client.$disconnect(); }
    });

    it.each(['environment', 'preview'] as const)('pages caller-sized %s selections across the PostgreSQL bind boundary', async selector => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Large exact selection', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            headerVersion: 1, bodyVersion: 1, header: new Uint8Array(), body: new Uint8Array(),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const base = { projectSourceId: source.source.id, createdByAccountId: owner.id, protection: 'nonProduction',
            deployerMode: 'managers', controllerMachineId: machine.id,
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const template = await db.deploymentEnvironment.create({ data: { ...base, purpose: 'standard' } });
        const target = await db.deploymentTargetLink.create({ data: { environmentId: template.id,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', contentArtifactId: artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1 } });
        const children = await Promise.all(['a', 'Z', '_'].map(position => db.deploymentEnvironment.create({ data: {
            ...base, id: `${position}-${randomUUID()}`, purpose: 'preview', previewTemplateEnvironmentId: template.id,
            previewRepositoryId: source.source.id, previewPullRequestId: `pr:${position}`, previewTargetLinkId: target.id,
        } })));
        // Missing selections need no rows: their bind parameters alone cross
        // Prisma/PostgreSQL's 32767-parameter query boundary.
        const selection = Array.from({ length: 32_768 }, (_, index) => `missing-${index}`);
        const selectedIds = children.map(row => selector === 'environment' ? row.id : row.previewPullRequestId!);
        selection.splice(0, 1, selectedIds[0]!);
        selection.splice(16_384, 1, selectedIds[1]!);
        selection.push(selectedIds[2]!, selectedIds[0]!);
        const input = { serverId, projectSourceId: source.source.id, limit: 1,
            ...(selector === 'environment' ? { environmentIds: selection }
                : { previewRepositoryId: source.source.id, previewPullRequestIds: selection }) };
        // The provider owns collation; concatenating chunk results and sorting
        // in JavaScript must not change the existing page/cursor contract.
        const ordered = await db.deploymentEnvironment.findMany({ where: { id: { in: children.map(row => row.id) } },
            orderBy: { id: 'desc' }, select: { id: true } });
        let cursor: string | undefined;
        for (const [index, expected] of ordered.entries()) {
            const admissions: string[] = [];
            const stop = observePrismaRequests(db, { before: request => {
                if (request.model === 'ProjectSource' && request.action === 'findUnique') admissions.push(request.model);
            } });
            const page = await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id, { ...input, cursor })).finally(stop);
            expect(page).toMatchObject({ ok: true, coverage: 'complete' });
            if (!page.ok) throw new Error(page.error);
            expect(page.items).toHaveLength(1);
            expect(page.items[0]!.id).toBe(expected.id);
            expect(page.nextCursor).toBe(index === ordered.length - 1 ? null : expected.id);
            expect(admissions, 'selection chunks share one Source admission per page').toHaveLength(1);
            cursor = page.nextCursor ?? undefined;
        }
        const intersection = await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id, {
            ...input, limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1,
            environmentIds: selector === 'environment' ? selection : [children[1]!.id],
            previewRepositoryId: source.source.id,
            previewPullRequestIds: selector === 'preview' ? selection : [children[1]!.previewPullRequestId!],
        }));
        expect(intersection).toMatchObject({ ok: true, coverage: 'complete', items: [{ id: children[1]!.id }], nextCursor: null });
        if (!intersection.ok) throw new Error(intersection.error);
        expect(intersection.items).toHaveLength(1);
    });

    it('opens only an admitted exact Artifact revision without repeating requester grants', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const content = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
        const created = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: content({ kind: 'deployment-domain.v1', title: 'Pinned' }), body: content({ body: 'captured' }),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!created.ok) throw new Error(created.error);
        // The signed Home test produces this trusted fact; this native-provider
        // check exercises only its exact Artifact query and retained-body reader.
        const input = { actorAccountId: requester.id, artifactId: created.artifact.id, admittedContent: {
            requesterAccountId: requester.id, content: { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 },
        } };
        const captured = await readArtifactForCaller(input);
        expect(captured).toMatchObject({ ok: true, artifact: { headerVersion: 1, bodyVersion: 1, access: 'view' } });
        if (!captured.ok) throw new Error(captured.error);
        expect(await updateArtifact({ actorUserId: owner.id, artifactId: created.artifact.id,
            body: { bytes: content({ body: 'replacement' }), expectedVersion: 1 } }))
            .toMatchObject({ ok: true });
        expect(await readArtifactForCaller(input)).toMatchObject({ ok: true, artifact: { bodyVersion: 1, body: captured.artifact.body } });
        expect(await readArtifactForCaller({ actorAccountId: requester.id, artifactId: created.artifact.id }))
            .toEqual({ ok: false, error: 'artifact_not_found' });
        expect(await readArtifactForCaller({ ...input, artifactId: randomUUID() })).toEqual({ ok: false, error: 'artifact_not_found' });
        expect(await updateArtifact({ actorUserId: owner.id, artifactId: created.artifact.id,
            header: { bytes: content({ title: 'Changed header' }), expectedVersion: 1 } }))
            .toMatchObject({ ok: true });
        expect(await readArtifactForCaller(input)).toMatchObject({ ok: false, error: 'artifact_content_unavailable' });
    });

    it('retains an old edge Machine reference through exact captured Domain custody until native tombstone', async () => {
        const { readDeploymentDomainEnvironmentIdsForMachineInTx, readMemberDeploymentDomainContentInTx } = await import('./deploymentDomainService');
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.projectSource.create({ data: { createdByAccountId: owner.id, name: 'Retained edge',
            owner: { kind: 'account', accountId: owner.id }, audience: [], attachments: [] } });
        const [oldEdge, current] = await Promise.all([0, 1].map(() => db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, metadata: '{}', installationId: randomUUID(),
        } })));
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            headerVersion: 1, bodyVersion: 1, header: new Uint8Array(), body: new Uint8Array(),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const content = { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.id,
            createdByAccountId: owner.id, controllerMachineId: current!.id, edgeMachineId: current!.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', ...content } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer',
            state: 'configured', createdByAccountId: owner.id, ...content } });
        const domainId = randomUUID();
        await db.deploymentDomain.create({ data: { id: domainId, environmentId: environment.id, targetLinkId: link.id,
            state: 'removing', createdByAccountId: owner.id, ...content, capturedPlacements: [{
                placement: { serverId, accountId: owner.id, environmentId: environment.id, targetLinkId: link.id, domainId,
                    machineId: oldEdge!.id, installationId: oldEdge!.installationId!, actionOperationId: randomUUID(),
                    requestId: randomUUID(), nativeServer: 'happier_public' }, listener: 'public', desired: false, content,
                installationPublicKey: 'captured-installation-key',
            }] } });
        const client = await createDbMaintenanceClient(provider);
        const requests: { action: string; model?: string; args: unknown }[] = [];
        const stop = observePrismaRequests(client, { before: request => { requests.push(request); } });
        try {
            const census = await client.$transaction(tx => readDeploymentMachineReferencesInTx(tx, owner.id,
                { homeId: serverId, machineId: oldEdge!.id }), { isolationLevel: 'Serializable' });
            expect(census).toMatchObject({ coverage: 'complete', references: [{ id: environment.id, deploymentRoles: ['retiring'] }] });
            const queries = requests.filter(item => item.action === 'queryRaw' && JSON.stringify(item.args).includes('capturedPlacements'));
            expect(queries).toHaveLength(1);
            expect(requests.filter(item => item.model === 'Artifact')).toEqual([]);
            requests.length = 0;
            const capturedRead = { environmentId: environment.id, targetLinkId: link.id, machineId: oldEdge!.id,
                installationId: oldEdge!.installationId!, artifactId: artifact.id };
            expect(await client.$transaction(tx => readMemberDeploymentDomainContentInTx(tx, capturedRead))).toEqual(content);
            expect(requests.filter(item => item.action === 'queryRaw')).toHaveLength(1);
            expect(requests.filter(item => item.model)).toEqual([]);
            for (const changed of [{ environmentId: randomUUID() }, { targetLinkId: randomUUID() },
                { machineId: current!.id }, { installationId: randomUUID() }, { artifactId: randomUUID() }]) {
                expect(await client.$transaction(tx => readMemberDeploymentDomainContentInTx(tx, { ...capturedRead, ...changed }))).toBeNull();
            }
            expect(await client.$transaction(tx => readDeploymentDomainEnvironmentIdsForMachineInTx(tx,
                { machineId: `${oldEdge!.id}-sibling`, limit: 1 }))).toEqual([]);
            await db.deploymentDomain.update({ where: { id: domainId }, data: { deletedAt: new Date() } });
            expect(await client.$transaction(tx => readDeploymentMachineReferencesInTx(tx, owner.id,
                { homeId: serverId, machineId: oldEdge!.id }))).toMatchObject({ references: [] });
        } finally { stop(); await client.$disconnect(); }
    });

    it('summarizes latest deployment activity without opening content or disclosing another Source', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Badge metadata', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            headerVersion: 1, bodyVersion: 1, header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const content = { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environments = await Promise.all([0, 1].map(() => db.deploymentEnvironment.create({ data: {
            projectSourceId: source.source.id, controllerMachineId: machine.id, createdByAccountId: owner.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', ...content,
        } })));
        const links = await Promise.all(environments.map(environment => db.deploymentTargetLink.create({ data: {
            environmentId: environment.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', createdByAccountId: owner.id, ...content,
        } })));
        const receipt = (index: number) => ({ environmentId: environments[index]!.id, targetLinkId: links[index]!.id,
            operation: 'deploy', requestedByAccountId: owner.id, requestKey: randomUUID(), actionOperationId: randomUUID(), ...content });
        await db.deployment.create({ data: { ...receipt(0), state: 'failed', requestedAt: new Date(1000) } });
        await db.deployment.create({ data: { ...receipt(0), state: 'succeeded', requestedAt: new Date(2000) } });
        const running = await db.deployment.create({ data: { ...receipt(1), state: 'running', requestedAt: new Date(2000) } });
        const requests: { model?: string; action: string }[] = [];
        let summaryReads = 0;
        const client = await createDbMaintenanceClient(provider);
        const stop = observePrismaRequests(client, { before: request => {
            requests.push({ model: request.model, action: request.action });
            const query = request.args && typeof request.args === 'object' && 'query' in request.args
                ? request.args.query : undefined;
            if (request.action === 'queryRaw' && typeof query === 'string' && query.startsWith('SELECT DISTINCT e.')) summaryReads++;
        } });
        const read = (accountId: string) => client.$transaction(tx => listDeploymentEnvironmentsInTx(tx, accountId,
            { serverId, projection: 'activity' }), { isolationLevel: 'Serializable' });
        try {
            expect(await read(owner.id)).toMatchObject({ activity: { running: true, failed: false }, items: [], nextCursor: null });
            expect(summaryReads).toBe(1);
            expect(requests.filter(request => request.model === 'Artifact')).toEqual([]);
            expect(await read(stranger.id)).toMatchObject({ activity: { running: false, failed: false }, items: [] });
            await db.deployment.update({ where: { id: running.id }, data: { state: 'failed' } });
            expect(await read(owner.id)).toMatchObject({ activity: { running: false, failed: true } });
        } finally { stop(); await client.$disconnect(); }
    });

    it.skipIf(provider !== 'postgres')('loads complete Domain inventory with one scoped native query and zero private content reads', async () => {
        const { readDeploymentDomainInventoryInTx } = await import('./deploymentDomainService');
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Domain inventory Source owner' } });
        await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: member.id, role: 'member' }] });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Native Domain inventory', audience: [],
                owner: { kind: 'team', teamId: team.id } }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            kind: 'v1:other:deployment-domain.v1', headerVersion: 1, bodyVersion: 1,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-domain.v1', title: 'Unopened' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ hostname: 'private.example.test' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        // Relational rows are the fixture boundary. The inventory owner must
        // read retained cleanup identities without opening their private body.
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, controllerMachineId: machine.id, protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            detachedAt: new Date(), createdByAccountId: owner.id, contentArtifactId: artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1 } });
        const id = randomUUID();
        await db.$executeRawUnsafe('INSERT INTO "DeploymentDomain" ("id","environmentId","targetLinkId","state","contentArtifactId","contentHeaderVersion","contentBodyVersion","createdByAccountId","updatedAt") VALUES ($1,$2,$3,\'removing\',$4,1,1,$5,CURRENT_TIMESTAMP)',
            id, environment.id, link.id, artifact.id, owner.id);
        const statements: Prisma.QueryEvent[] = [];
        const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        const input = { serverId, environmentId: environment.id, expectedRevision: environment.revision };
        try {
            const result = await client.$transaction(tx => readDeploymentDomainInventoryInTx(tx, owner.id, input),
                { isolationLevel: 'Serializable' });
            expect(result).toMatchObject({ ok: true, environmentId: environment.id,
                domains: [{ id, state: 'removing', targetLinkId: link.id }] });
            const domains = statements.filter(event => /\bFROM\s+"public"\."DeploymentDomain"/.test(event.query));
            expect(domains).toHaveLength(1);
            expect(domains[0]?.params).toContain(environment.id);
            expect(domains[0]?.query).not.toMatch(/\bLIMIT\b/);
            expect(statements.filter(event => /\bFROM\s+"public"\."Artifact"/.test(event.query))).toEqual([]);
            expect(await client.$transaction(tx => readDeploymentDomainInventoryInTx(tx, outsider.id, input)))
                .toEqual({ ok: false, error: 'deployment_unavailable' });
            // Source-derived readers may receive metadata even when private
            // Artifact content is not shared with them. Cleanup inventory is
            // not a claim that the referenced body is readable or current.
            expect(await client.$transaction(tx => readDeploymentDomainInventoryInTx(tx, member.id, input))).toEqual(result);
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: member.id } },
                data: { status: 'suspended' } });
            expect(await client.$transaction(tx => readDeploymentDomainInventoryInTx(tx, member.id, input)))
                .toEqual({ ok: false, error: 'deployment_unavailable' });
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: member.id } },
                data: { status: 'active' } });
            expect(await client.$transaction(tx => readDeploymentDomainInventoryInTx(tx, member.id, input))).toEqual(result);
        } finally { await client.$disconnect(); }
    });

    it.skipIf(provider !== 'postgres')('reads an exact Environment access set with one current Source census and no content reads', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Access census' } });
        await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: actor.id, role: 'member' }] });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Access source', owner: { kind: 'team', teamId: team.id } }));
        const hiddenSource = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Private source', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        if (!hiddenSource.ok) throw new Error(hiddenSource.error);
        const additionalSourceIds = Array.from({ length: 64 }, () => randomUUID());
        await db.projectSource.createMany({ data: additionalSourceIds.map(id => ({ id, name: source.source.name,
            createdByAccountId: owner.id, owner: { kind: 'team', teamId: team.id }, audience: [], attachments: [] })) });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}', installationId: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            kind: 'v1:other:deployment-environment.v1', headerVersion: 1, bodyVersion: 1,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Private' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ private: 'must-not-open' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id,
            accessLevel: 'admin', createdByAccountId: owner.id } });
        const environmentIds = Array.from({ length: 128 }, () => randomUUID());
        await db.deploymentEnvironment.createMany({ data: environmentIds.map((id, index) => ({ id,
            projectSourceId: additionalSourceIds[index - 64] ?? source.source.id, createdByAccountId: owner.id, controllerMachineId: machine.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: index === 1 ? 'managers' : 'members',
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
            ...(index === 0 ? { deletedAt: new Date() } : {}) })) });
        const hidden = await db.deploymentEnvironment.create({ data: {
            projectSourceId: hiddenSource.source.id, createdByAccountId: owner.id, controllerMachineId: machine.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'members',
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        } });
        const measure = async (ids: readonly string[]) => {
            const reads = new Map<string, number>();
            const statements: Prisma.QueryEvent[] = [];
            // Instrument the real SQL transport; Source and Team admission run unchanged.
            const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
            client.$on('query', event => statements.push(event));
            try {
                const result = await client.$transaction(tx => readDeploymentEnvironmentAccessInTx(tx, actor.id, { serverId, environmentIds: [...ids] }),
                    { isolationLevel: 'RepeatableRead' });
                for (const event of statements) {
                    const table = /^SELECT\b/.test(event.query.trimStart()) ? event.query.match(/\bFROM\s+"public"\."([^"]+)"/)?.[1] : undefined;
                    if (table) reads.set(table, (reads.get(table) ?? 0) + 1);
                }
                return { result, reads };
            } finally { await client.$disconnect(); }
        };
        const single = await measure([environmentIds[1]!]);
        expect(single.result).toEqual({ ok: true, items: [{ environmentId: environmentIds[1], read: true, deploy: false }] });
        const empty = await measure([]);
        expect(empty.result).toEqual({ ok: true, items: [] });
        expect(empty.reads.size).toBe(0);
        const set = await measure([...environmentIds, environmentIds[1]!, hidden.id, randomUUID()]);
        console.info('DEPLOYMENT_ACCESS_SQL', JSON.stringify({ environments: environmentIds.length, sources: additionalSourceIds.length + 1,
            single: Object.fromEntries(single.reads), set: Object.fromEntries(set.reads) }));
        expect(Object.fromEntries(set.reads)).toEqual(Object.fromEntries(single.reads));
        expect(set.reads.get('Artifact') ?? 0).toBe(0);
        expect(set.reads.get('DeploymentTargetLink') ?? 0).toBe(0);
        expect(set.result).toEqual({ ok: true, items: environmentIds.map((environmentId, index) => ({ environmentId, read: true, deploy: index > 1 })) });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: actor.id } }, data: { status: 'suspended' } });
        expect((await measure(environmentIds)).result).toEqual({ ok: true, items: [] });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: actor.id } }, data: { status: 'active' } });
        expect((await measure(environmentIds)).result).toEqual(set.result);
        await db.account.update({ where: { id: actor.id }, data: { status: 'suspended' } });
        expect((await measure(environmentIds)).result).toEqual({ ok: true, items: [] });
        await db.account.update({ where: { id: actor.id }, data: { status: 'active' } });
        expect((await measure(environmentIds)).result).toEqual(set.result);
        expect(await inReadSnapshot(tx => readDeploymentEnvironmentAccessInTx(tx, actor.id, { serverId: 'foreign-home', environmentIds })))
            .toEqual({ ok: false, error: 'deployment_unavailable' });
        const app = createAuthenticatedTestApp();
        registerDeploymentRoutes(app);
        try {
            const request = { method: 'POST' as const, url: '/v1/deployments/environments/access',
                headers: { 'x-test-user-id': actor.id }, payload: { serverId, environmentIds } };
            const response = await app.inject(request);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual(set.result);
            expect((await app.inject({ ...request, payload: { ...request.payload, extraAuthority: true } })).statusCode).toBe(400);
            expect((await app.inject({ ...request, headers: {} })).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('advances an empty partial All page without disclosing unreadable identities or crawling Sources', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sources = await Promise.all([owner, stranger].map(account => inTx(tx => createProjectSourceInTx(tx, account.id,
            { serverId, requestKey: randomUUID(), name: 'Native All inventory', audience: [] }))));
        const [visible, hidden] = sources;
        if (!visible.ok || !hidden.ok) throw new Error('Source fixture refused');
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            kind: 'v1:other:deployment-environment.v1', headerVersion: 1, bodyVersion: 1,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Native All' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ private: 'unopened' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const prefix = `zz-inventory-${randomUUID()}`;
        const ids = [2, 1, 0].map(index => `${prefix}-${index}`);
        await db.deploymentEnvironment.createMany({ data: ids.map((id, index) => ({ id,
            projectSourceId: index === 0 ? hidden.source.id : visible.source.id, createdByAccountId: owner.id,
            controllerMachineId: machine.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 })) });
        let sourceCrawls = 0;
        const read = (cursor: string, actor = owner.id, projectSourceId?: string) => inReadSnapshot(tx =>
            listDeploymentEnvironmentsInTx(new Proxy(tx, { get(target, property, receiver) {
                const delegate = Reflect.get(target, property, receiver);
                if (property !== 'projectSource') return typeof delegate === 'function' ? delegate.bind(target) : delegate;
                return new Proxy(delegate, { get(model, operation, modelReceiver) {
                    const method = Reflect.get(model, operation, modelReceiver);
                    if (typeof method !== 'function') return method;
                    return (...args: unknown[]) => {
                        if (operation === 'findMany') sourceCrawls++;
                        return Reflect.apply(method, model, args);
                    };
                } });
            } }), actor, { serverId, cursor, limit: 1, ...(projectSourceId ? { projectSourceId } : {}) }));
        const first = await read(`${prefix}-3`);
        expect(first).toMatchObject({ ok: true, items: [], coverage: 'partial' });
        if (!first.ok || !first.nextCursor) throw new Error('Empty partial page must continue');
        expect(JSON.stringify(first)).not.toContain(ids[0]);
        expect(JSON.stringify(first)).not.toContain(hidden.source.id);
        expect(await read(first.nextCursor, stranger.id)).toEqual({ ok: false, error: 'deployment_invalid' });
        expect(await read(first.nextCursor, owner.id, visible.source.id)).toEqual({ ok: false, error: 'deployment_invalid' });
        const second = await read(first.nextCursor);
        expect(second).toMatchObject({ ok: true, items: [{ id: ids[1] }], coverage: 'complete' });
        if (!second.ok || !second.nextCursor) throw new Error('Visible page must continue');
        expect(await read(second.nextCursor)).toMatchObject({ ok: true, items: [{ id: ids[2] }] });
        expect(sourceCrawls).toBe(0);
    });

    it('projects only the recorded Environment controller availability on the native provider', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Controller availability', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID(), active: false } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            kind: 'v1:other:deployment-environment.v1', headerVersion: 1, bodyVersion: 1,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Controller' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ private: 'unopened' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, controllerMachineId: machine.id, protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', contentArtifactId: artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1 } });
        const readController = () => inReadSnapshot(tx => readDeploymentEnvironmentInTx(tx, owner.id,
            { serverId, environmentId: environment.id }));
        expect(await readController()).toMatchObject({ ok: true, controller: { machineId: machine.id, state: 'paused' } });
        await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}',
            installationId: randomUUID(), active: true, lastActiveAt: new Date() } });
        expect(await readController()).toMatchObject({ ok: true, controller: { machineId: machine.id, state: 'paused' } });
        await db.machine.update({ where: { id: machine.id }, data: { active: true, lastActiveAt: new Date() } });
        expect(await readController()).toMatchObject({ ok: true, controller: { machineId: machine.id, state: 'available' } });
    });

    it('pages receipt history newest first by request time and id with Environment-bound cursors', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Chronological history', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            kind: 'v1:other:deployment-environment.v1', headerVersion: 1, bodyVersion: 1,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'History' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ private: 'unopened' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const environments = await Promise.all([0, 1].map(() => db.deploymentEnvironment.create({ data: {
            projectSourceId: source.source.id, createdByAccountId: owner.id, controllerMachineId: machine.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        } })));
        const environmentId = environments[0]!.id;
        const link = await db.deploymentTargetLink.create({ data: { environmentId, role: 'runtime', sourceKind: 'host',
            hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured', createdByAccountId: owner.id,
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
        const receiptIds = ['history-z-old', 'history-a-new', 'history-b-new'].map(id => `${id}-${randomUUID()}`);
        await db.deployment.createMany({ data: receiptIds.map((id, index) => ({ id, environmentId, targetLinkId: link.id,
            operation: 'deploy', state: 'failed', requestKey: randomUUID(), actionOperationId: randomUUID(), requestedByAccountId: owner.id,
            requestedAt: new Date(index === 0 ? 1000 : 2000), contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 })) });
        const readHistory = (cursor?: string, selectedEnvironmentId = environmentId) => inReadSnapshot(tx =>
            listDeploymentReceiptsInTx(tx, owner.id, { serverId, environmentId: selectedEnvironmentId, cursor, limit: 1 }));
        const history: string[] = [];
        let historyCursor: string | undefined;
        for (let index = 0; index < receiptIds.length; index++) {
            const page = await readHistory(historyCursor);
            expect(page).toMatchObject({ ok: true });
            if (!page.ok) throw new Error(page.error);
            history.push(...page.items.map(item => item.id));
            expect(page.nextCursor).toBe(index < receiptIds.length - 1 ? page.items[0]?.id : null);
            historyCursor = page.nextCursor ?? undefined;
        }
        expect(history).toEqual([receiptIds[2], receiptIds[1], receiptIds[0]]);
        expect(await readHistory(`missing-${randomUUID()}`)).toEqual({ ok: false, error: 'deployment_invalid' });
        expect(await readHistory(receiptIds[0], environments[1]!.id)).toEqual({ ok: false, error: 'deployment_invalid' });
        const otherActor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const filteredIds = ['filtered-newer', 'filtered-older'].map(id => `${id}-${randomUUID()}`);
        const receiptData = { environmentId, targetLinkId: link.id, state: 'failed', operation: 'rollback',
            requestedByAccountId: owner.id, contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        await db.deployment.createMany({ data: [
            ...filteredIds.map((id, index) => ({ ...receiptData, id, requestKey: randomUUID(), actionOperationId: randomUUID(),
                requestedAt: new Date(4000 - index * 1000) })),
            ...Array.from({ length: 24 }, (_, index) => ({ ...receiptData, id: randomUUID(),
                requestKey: randomUUID(), actionOperationId: randomUUID(), requestedAt: new Date(5000 + index),
                ...(index % 3 === 0 ? { state: 'succeeded' } : index % 3 === 1 ? { operation: 'deploy' }
                    : { requestedByAccountId: otherActor.id }) })),
        ] });
        const requests: { action: string; model?: string; args: unknown }[] = [];
        const returnedPages: unknown[] = [];
        const stop = observePrismaRequests(db, { before: request => { requests.push(request); },
            after: (request, result) => {
                if (request.model === 'Deployment' && request.action === 'findMany') returnedPages.push(result);
            } });
        try {
            const filter = { serverId, environmentId, state: 'failed' as const, actorAccountId: owner.id,
                operation: 'rollback' as const, limit: 1 };
            const readFiltered = (cursor?: string) => inReadSnapshot(tx => listDeploymentReceiptsInTx(tx, owner.id, { ...filter, cursor }));
            expect(await readFiltered()).toMatchObject({ ok: true, items: [{ id: filteredIds[0] }], nextCursor: filteredIds[0] });
            expect(await readFiltered(filteredIds[0])).toMatchObject({ ok: true, items: [{ id: filteredIds[1] }], nextCursor: null });
            expect(await inReadSnapshot(tx => listDeploymentReceiptsInTx(tx, owner.id,
                { ...filter, actorAccountId: `missing-${randomUUID()}` })))
                .toMatchObject({ ok: true, items: [], nextCursor: null });
            const pages = requests.filter(row => row.model === 'Deployment' && row.action === 'findMany');
            expect(pages, 'one narrow matching query per page, never a history crawl').toHaveLength(3);
            for (const page of pages) expect(page.args).toMatchObject({ where: { environmentId,
                state: 'failed', operation: 'rollback', requestedByAccountId: expect.any(String) }, take: 2 });
            expect(returnedPages.map(page => Array.isArray(page) ? page.length : -1),
                'only matching page rows plus the existing next-page sentinel leave PostgreSQL').toEqual([2, 1, 0]);
            expect(returnedPages).toMatchObject([[{ id: filteredIds[0] }, { id: filteredIds[1] }], [{ id: filteredIds[1] }], []]);
            expect(requests.filter(row => row.model === 'Artifact'), 'history filtering never opens content').toEqual([]);
        } finally { stop(); }
        // Receipt cursors are Environment-owned chronological boundaries, so
        // changing a filter continues below that receipt even when it no longer matches.
        expect(await inReadSnapshot(tx => listDeploymentReceiptsInTx(tx, owner.id,
            { serverId, environmentId, cursor: filteredIds[0], state: 'failed', operation: 'deploy', limit: 1 })))
            .toMatchObject({ ok: true, items: [{ id: receiptIds[2] }] });
        const busyInput = { serverId, environmentId, inProgressOnly: true as const };
        const readBusy = () => inReadSnapshot(tx => listDeploymentReceiptsInTx(tx, owner.id, busyInput));
        expect(await readBusy()).toMatchObject({ ok: true, items: [], nextCursor: null });
        await db.deployment.update({ where: { id: receiptIds[0] }, data: { state: 'running' } });
        const busy = await readBusy();
        expect(busy).toMatchObject({ ok: true, items: [{ id: receiptIds[0], state: 'running' }], nextCursor: null });
        if (!busy.ok) throw new Error(busy.error);
        expect(busy.items).toHaveLength(1);
        const busyFiltered = { ...busyInput, state: 'running' as const, actorAccountId: owner.id, operation: 'deploy' as const };
        expect(await inReadSnapshot(tx => listDeploymentReceiptsInTx(tx, owner.id, busyFiltered)))
            .toMatchObject({ ok: true, items: [{ id: receiptIds[0] }], nextCursor: null });
        expect(await inReadSnapshot(tx => listDeploymentReceiptsInTx(tx, owner.id, { ...busyFiltered, state: 'failed' })))
            .toMatchObject({ ok: true, items: [], nextCursor: null });
        const app = createAuthenticatedTestApp();
        registerDeploymentRoutes(app);
        try {
            const query = new URLSearchParams({ serverId, state: 'failed', actorAccountId: owner.id, operation: 'rollback', limit: '1' });
            const response = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${environmentId}/deployments?${query}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, items: [{ id: filteredIds[0] }], nextCursor: filteredIds[0] });
        } finally { await app.close(); }
    });

    it('filters membership before paging and preserves current Source admission without opening content', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sources = await Promise.all([owner, outsider].map(account => inTx(tx => createProjectSourceInTx(tx, account.id, {
            serverId, requestKey: randomUUID(), name: 'Read contract', audience: [],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/read-contract', cloneUrl: 'https://github.com/acme/read-contract.git' }, protocol: 'https' },
        }))));
        const [visibleSource, hiddenSource] = sources;
        if (!visibleSource.ok || !hiddenSource.ok) throw new Error('Source fixture admission failed');
        const machines = await Promise.all(['matching', 'unrelated'].map(label => db.machine.create({ data: {
            id: `${label}-${randomUUID()}`, accountId: owner.id, metadata: '{}', installationId: randomUUID(),
        } })));
        const [machine, peer] = machines;
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            kind: 'v1:other:deployment-environment.v1', headerVersion: 1, bodyVersion: 1,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Unopened' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'private-body-must-stay-unopened' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const common = { createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const visible = await db.deploymentEnvironment.create({ data: { ...common, id: `!inventory-${randomUUID()}`, projectSourceId: visibleSource.source.id,
            controllerMachineId: machine.id } });
        await db.deploymentEnvironment.createMany({ data: Array.from({ length: 1_000 }, () => ({ ...common,
            projectSourceId: visibleSource.source.id, controllerMachineId: peer.id })) });
        const input = { serverId, machineId: machine.id, limit: 1 };
        const read = () => inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id, input));
        expect(await read()).toMatchObject({ ok: true, coverage: 'complete', items: [{ id: visible.id }], nextCursor: null });
        expect(await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, outsider.id, input)))
            .toEqual({ ok: false, error: 'deployment_unavailable' });
        expect(await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id, { ...input, serverId: 'foreign-home' })))
            .toEqual({ ok: false, error: 'deployment_unavailable' });
        const hidden = await db.deploymentEnvironment.create({ data: { ...common, projectSourceId: hiddenSource.source.id,
            controllerMachineId: machine.id } });
        // Installed All enters this same native owner once, without listing Project sources.
        // Native collation and earlier tests can put unrelated rows before this
        // fixture; select its preceding position through that same DB ordering.
        const predecessor = await db.deploymentEnvironment.findFirst({ where: { deletedAt: null, id: { gt: visible.id } },
            orderBy: { id: 'asc' }, select: { id: true } });
        const all = await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id,
            { serverId, limit: 1, ...(predecessor ? { cursor: predecessor.id } : {}) }));
        expect(all).toMatchObject({ ok: true, items: [{ id: visible.id, projectSourceId: visibleSource.source.id }],
            runtimeTargetLinks: [], coverage: 'complete' });
        const linkArtifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            kind: 'v1:other:deployment-target-link.v1', headerVersion: 1, bodyVersion: 1,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: 'Unopened custody' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'unopened' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const retained = Array.from({ length: 100 }, () => randomUUID());
        await db.deploymentTargetLink.createMany({ data: retained.map(id => ({ id, environmentId: visible.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            createdByAccountId: owner.id, contentArtifactId: linkArtifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 })) });
        await db.deploymentTargetLinkMachine.createMany({ data: retained.map(targetLinkId => ({ targetLinkId,
            machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' })) });
        await db.deploymentEnvironment.update({ where: { id: visible.id }, data: { runtimeTargetLinkId: retained.at(-1) } });
        let artifactReads = 0;
        const detail = await inReadSnapshot(tx => readDeploymentEnvironmentInTx(new Proxy(tx, {
            get(target, property, receiver) {
                const delegate = Reflect.get(target, property, receiver);
                if (property !== 'artifact') return typeof delegate === 'function' ? delegate.bind(target) : delegate;
                // Observe the genuine Prisma boundary, preserving every query and admission decision.
                return new Proxy(delegate, { get(model, operation, modelReceiver) {
                    const method = Reflect.get(model, operation, modelReceiver);
                    if (typeof method !== 'function') return method;
                    return (...args: unknown[]) => {
                        if (String(operation).startsWith('find')) artifactReads++;
                        return Reflect.apply(method, model, args);
                    };
                } });
            },
        }), owner.id, { serverId, environmentId: visible.id }));
        expect(detail).toMatchObject({ ok: true });
        if (!detail.ok) throw new Error(detail.error);
        expect(detail.targetLinks).toHaveLength(retained.length);
        expect(artifactReads, 'one detail open batches Artifact admission independently of retained custody count').toBe(1);
        const partial = await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id, { ...input, limit: 10 }));
        expect(partial).toMatchObject({ ok: true, coverage: 'partial', items: [{ id: visible.id }], nextCursor: null });
        expect(JSON.stringify(partial)).not.toContain(hidden.id);
        expect(JSON.stringify(partial)).not.toContain(hiddenSource.source.id);
        expect(JSON.stringify(partial)).not.toContain('private-body-must-stay-unopened');
        const tombstone = await db.deploymentEnvironment.create({ data: { ...common,
            projectSourceId: visibleSource.source.id, controllerMachineId: machine.id, deletedAt: new Date() } });
        const retainedInput = { ...input, projectSourceId: visibleSource.source.id, includeDeleted: true as const };
        const retainedIds: string[] = [];
        let retainedCursor: string | undefined;
        do {
            const page = await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id,
                { ...retainedInput, ...(retainedCursor ? { cursor: retainedCursor } : {}) }));
            expect(page).toMatchObject({ ok: true, coverage: 'complete' });
            if (!page.ok) throw new Error(page.error);
            retainedIds.push(...page.items.map(item => item.id));
            retainedCursor = page.nextCursor ?? undefined;
        } while (retainedCursor);
        // Cursor ordering belongs to the provider's native collation, not JavaScript's UTF-16 sort.
        const retainedOrder = await db.deploymentEnvironment.findMany({
            where: { id: { in: [visible.id, tombstone.id] } }, orderBy: { id: 'desc' }, select: { id: true },
        });
        expect(retainedIds).toEqual(retainedOrder.map(row => row.id));
        expect(await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id,
            { ...input, projectSourceId: visibleSource.source.id })))
            .toMatchObject({ ok: true, items: [{ id: visible.id }], nextCursor: null });
        expect(await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, outsider.id, retainedInput)))
            .toEqual({ ok: false, error: 'deployment_unavailable' });
        const exactInput = { serverId, environmentIds: [visible.id, hidden.id] };
        const exact = await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id, exactInput));
        expect(exact).toMatchObject({ ok: true, items: [{ id: visible.id }], nextCursor: null });
        if (!exact.ok) throw new Error(exact.error);
        expect(exact.items.map(item => item.id)).toEqual([visible.id]);
        expect(JSON.stringify(exact)).not.toContain(hidden.id);
        expect(JSON.stringify(exact)).not.toContain(hiddenSource.source.id);
        if (provider === 'postgres') {
            const statements: Prisma.QueryEvent[] = [];
            const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
            client.$on('query', event => statements.push(event));
            try {
                await client.$transaction(tx => listDeploymentEnvironmentsInTx(tx, owner.id, exactInput));
                const environmentQuery = statements.filter(event => /\bFROM\s+"public"\."DeploymentEnvironment"/.test(event.query));
                expect(environmentQuery).toHaveLength(1);
                expect(environmentQuery[0]?.query).toMatch(/"id"\s+IN\s*\(/);
                expect(environmentQuery[0]?.params).toContain(visible.id);
                expect(environmentQuery[0]?.params).toContain(hidden.id);
                expect(statements.filter(event => /\bFROM\s+"public"\."(?:Deployment|Artifact)"/.test(event.query))).toEqual([]);
                statements.length = 0;
                await client.$transaction(tx => listDeploymentEnvironmentsInTx(tx, owner.id, retainedInput));
                const retainedQuery = statements.filter(event => /\bFROM\s+"public"\."DeploymentEnvironment"/.test(event.query));
                expect(retainedQuery).toHaveLength(1);
                expect(retainedQuery[0]?.params).toContain(visibleSource.source.id);
                expect(retainedQuery[0]?.query).not.toMatch(/"deletedAt"\s+IS\s+NULL/);
                expect(statements.filter(event => /\bFROM\s+"public"\."Artifact"/.test(event.query))).toEqual([]);
            } finally { await client.$disconnect(); }
        }
    });

    it('stores plugin data links and applies exact Source ownership before paging readable headers', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const publishedMachine = {
            metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
                host: 'Native data links', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/deployment', happyHomeDir: '/home/deployment/.happier',
            })), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        };
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            ...publishedMachine, installationId: randomUUID() } });
        const controller = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            ...publishedMachine, installationId: randomUUID() } });
        const team = await db.team.create({ data: { name: 'Native links' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        await db.machineTeamGrant.createMany({ data: [machine, controller].map(placement => ({ machineId: placement.id,
            teamId: team.id, accessLevel: 'view', createdByAccountId: custodian.id })) });
        async function content(kind: string) {
            const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
                kind: `v1:other:${kind}`, headerVersion: 1, bodyVersion: 1,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Unopened link' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'private-native-identity' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
            return { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        async function seed(scope: { kind: 'account'; accountId: string } | { kind: 'team'; teamId: string }, testUseRefusal = false) {
            const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
                serverId, requestKey: randomUUID(), name: 'Native link source', owner: scope }));
            if (!source.ok) throw new Error(source.error);
            const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
                createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: controller.id, ...await content('deployment-environment.v1') } });
            const reference = await content('deployment-target-link.v1');
            if (scope.kind === 'team') for (const ref of [environment, reference]) await db.artifactTeamGrant.create({ data: {
                artifactId: ref.contentArtifactId, teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id } });
            const input = DeploymentTargetLinkInputV1Schema.parse({ serverId, environmentId: environment.id, expectedRevision: 1,
                role: 'data', source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'database' } },
                targetId: 'example.deploy/database', targetKind: 'database', machines: [], machineId: machine.id,
                installationId: machine.installationId, requestKey: randomUUID(), ...reference });
            if (testUseRefusal) {
                // Source ownership and Team-granted Use do not authorize a definition write.
                expect(await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, input)))
                    .toEqual({ ok: false, error: 'deployment_access_denied' });
                expect(await db.deploymentTargetLink.count({ where: { environmentId: environment.id } })).toBe(0);
                expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision).toBe(1);
                await db.machineTeamGrant.updateMany({ where: { teamId: team.id }, data: { accessLevel: 'admin' } });
            }
            const linked = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, input));
            expect(linked, 'Team-granted requester Manage and exact installation must admit native storage').toMatchObject({ ok: true });
            if (!linked.ok) throw new Error(linked.error);
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).runtimeTargetLinkId).toBeNull();
            return { environment, linked, reference };
        }
        const scope = { kind: 'account' as const, accountId: owner.id };
        const [a, b, shared] = [await seed(scope, true), await seed(scope), await seed({ kind: 'team', teamId: team.id })];
        const sorted = [a.linked.targetLinkId, b.linked.targetLinkId].sort();
        const read = (cursor?: string) => inReadSnapshot(tx => listDeploymentTargetLinksInTx(tx, owner.id,
            { serverId, scope, limit: 1, ...(cursor ? { cursor } : {}) }));
        const first = DeploymentTargetLinksListResultV1Schema.parse(await read());
        expect(first).toMatchObject({ ok: true, items: [{ targetLink: { id: sorted[0], role: 'data', machines: [],
            source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'database' } },
            machineId: machine.id, installationId: machine.installationId } }], nextCursor: sorted[0], coverage: 'complete' });
        const last = await read(sorted[0]);
        expect(last).toMatchObject({ ok: true, items: [{ targetLink: { id: sorted[1] } }], nextCursor: null, coverage: 'complete' });
        expect(JSON.stringify(first) + JSON.stringify(last)).not.toContain('private-native-identity');
        const teamRead = await inReadSnapshot(tx => listDeploymentTargetLinksInTx(tx, owner.id,
            { serverId, scope: { kind: 'team', teamId: team.id } }));
        expect(teamRead).toMatchObject({ ok: true, items: [{ targetLink: { id: shared.linked.targetLinkId } }], nextCursor: null, coverage: 'complete' });
        expect(await inReadSnapshot(tx => listDeploymentTargetLinksInTx(tx, outsider.id, { serverId, scope })))
            .toEqual({ ok: false, error: 'deployment_unavailable' });
        const references = MachineDeploymentReferencesPageV1Schema.parse(await inReadSnapshot(tx =>
            readDeploymentMachineReferencesInTx(tx, owner.id, { homeId: serverId, machineId: machine.id })));
        expect(references.coverage).toBe('complete');
        expect(references.references.map(reference => reference.id).sort()).toEqual([a.environment.id, b.environment.id, shared.environment.id].sort());
        expect(references.references.map(reference => reference.deploymentRoles)).toEqual([['data'], ['data'], ['data']]);
        const onMachine = await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id, { serverId, machineId: machine.id }));
        expect(onMachine).toMatchObject({ ok: true, coverage: 'complete', nextCursor: null });
        if (!onMachine.ok) throw new Error(onMachine.error);
        expect(onMachine.items.map(item => item.id).sort()).toEqual([a.environment.id, b.environment.id, shared.environment.id].sort());
        // Same-owner unrelated links must never consume a comparison page or its content admissions.
        await db.deploymentTargetLink.createMany({ data: Array.from({ length: 120 }, (_, index) => ({
            id: `0-unrelated-${index}-${randomUUID()}`, environmentId: a.environment.id, createdByAccountId: owner.id,
            role: 'data', sourceKind: 'plugin', pluginId: index % 3 === 0 ? 'other.deploy' : 'example.deploy',
            contributionLocalId: index % 3 === 1 ? 'platform' : 'database', targetKind: index % 3 === 2 ? 'platform' : 'database',
            state: 'configured', contentArtifactId: a.reference.contentArtifactId,
            contentHeaderVersion: 99, contentBodyVersion: 1,
        })) });
        const requests: { action: string; model?: string; args: unknown }[] = [];
        const client = await createDbMaintenanceClient(provider);
        const stop = observePrismaRequests(client, { before: request => { requests.push(request); } });
        const selection = { source: { kind: 'plugin' as const, contribution: { pluginId: 'example.deploy', localId: 'database' } }, targetKind: 'database' };
        try {
            const page = await client.$transaction(tx => listDeploymentTargetLinksInTx(tx, owner.id, { serverId, scope, selection, limit: 1 }));
            expect(page).toMatchObject({ ok: true, items: [{ targetLink: { id: sorted[0] } }], nextCursor: sorted[0], coverage: 'complete' });
            expect(requests.filter(request => request.model === 'DeploymentTargetLink' && request.action === 'findMany'))
                .toMatchObject([{ args: { where: { sourceKind: 'plugin', pluginId: 'example.deploy', contributionLocalId: 'database', targetKind: 'database' }, take: 2 } }]);
            const artifactReads = requests.filter(request => request.model === 'Artifact' && request.action === 'findMany');
            expect(artifactReads).toHaveLength(1);
            expect(artifactReads[0]?.args).toMatchObject({ where: { id: { in: expect.any(Array) } }, select: { body: false } });
            expect(await client.$transaction(tx => listDeploymentTargetLinksInTx(tx, owner.id,
                { serverId, scope, selection, limit: 1, cursor: sorted[0] })))
                .toMatchObject({ items: [{ targetLink: { id: sorted[1] } }], nextCursor: null, coverage: 'complete' });
        } finally { stop(); await client.$disconnect(); }
    });
});
