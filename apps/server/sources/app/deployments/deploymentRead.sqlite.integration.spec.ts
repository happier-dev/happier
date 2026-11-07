import { randomUUID } from 'node:crypto';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { DeploymentEnvironmentListResultV1Schema } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createProjectSourceInTx, updateProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createAuthenticatedTestApp, withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { listDeploymentEnvironmentsInTx } from './deploymentReadService';
import { sealDeploymentReadCursor } from './deploymentReadCursor';

describe('deployment detail admission cost', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-deployment-read-', initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('shows a created Environment in the first Account inventory page without extra inventory reads', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Hub inventory', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'Hub inventory', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: randomUUID() } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            kind: 'v1:other:deployment-environment.v1',
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'jop83-env' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(createDeploymentEnvironmentDetailV1().content) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const base = { projectSourceId: source.source.id, createdByAccountId: owner.id,
            protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            controllerMachineId: machine.id, contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        // The live hub spent its entire 500-row window on older ids; its Project had 12 rows.
        const olderIds = Array.from({ length: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 }, (_, index) =>
            `a-hub-${source.source.id}-${String(index).padStart(4, '0')}`);
        await db.deploymentEnvironment.createMany({ data: olderIds.map(id => ({ ...base, id })) });
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id,
            { ...base, serverId, requestKey: randomUUID() }));
        if (!created.ok) throw new Error(created.error);
        const app = createAuthenticatedTestApp();
        registerDeploymentRoutes(app);
        const inventoryReads: unknown[] = [];
        const stop = observeSqliteRequests({ before: request => {
            if (request.model === 'DeploymentEnvironment' && request.action === 'findMany') inventoryReads.push(request.args);
        } });
        const read = async (cursor?: string) => {
            const query = new URLSearchParams({ serverId, ...(cursor ? { cursor } : {}) });
            const response = await app.inject({ method: 'GET', url: `/v1/deployments/environments?${query}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(response.statusCode, response.body).toBe(200);
            return DeploymentEnvironmentListResultV1Schema.parse(response.json());
        };
        try {
            const page = await read();
            if (!page.ok) throw new Error(page.error);
            expect(page.items[0]?.id).toBe(created.environmentId);
            expect(page.items).toHaveLength(ARTIFACT_LIST_PAGE_MAX_ITEMS_V1);
            expect(inventoryReads, 'one bounded page, no inventory drain to find the created row').toHaveLength(1);
            const next = await read(page.nextCursor ?? undefined);
            if (!next.ok) throw new Error(next.error);
            expect(next.items.map(row => row.id)).toEqual([olderIds[0]]);
            expect(next.nextCursor).toBeNull();
            expect(new Set([...page.items, ...next.items].map(row => row.id)).size).toBe(olderIds.length + 1);
        } finally { stop(); await app.close(); }
    });

    it('preserves valid deployment list rows and continuation when stored siblings are malformed', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Partial deployment lists', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const content = async (kind: string) => {
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'List row' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'unopened' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            return { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const environmentContent = await content('deployment-environment.v1');
        const base = { projectSourceId: source.source.id, createdByAccountId: owner.id,
            protection: 'nonProduction', deployerMode: 'managers', controllerMachineId: machine.id, ...environmentContent };
        const valid = await db.deploymentEnvironment.create({ data: { ...base, id: `a-${source.source.id}`, purpose: 'standard' } });
        const invalid = await db.deploymentEnvironment.create({ data: { ...base, id: `b-${source.source.id}`, purpose: 'standard', createdAt: new Date(-1) } });
        const later = await db.deploymentEnvironment.create({ data: { ...base, id: `c-${source.source.id}`, purpose: 'standard' } });
        const targetContent = await content('deployment-target-link.v1');
        const targetBase = { environmentId: valid.id, createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host',
            hostTargetId: 'own-server', targetKind: 'ownServer', ...targetContent,
            machines: { create: { machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' } } };
        const target = await db.deploymentTargetLink.create({ data: { ...targetBase, id: `b-${valid.id}`, state: 'configured' } });
        const badTarget = await db.deploymentTargetLink.create({ data: { ...targetBase, id: `a-${valid.id}`, state: 'configured', updatedAt: new Date(-1) } });
        await db.deploymentEnvironment.update({ where: { id: valid.id }, data: { runtimeTargetLinkId: badTarget.id } });
        await db.deploymentTargetLink.create({ data: { ...targetBase, id: `c-${valid.id}`, environmentId: invalid.id, state: 'configured' } });
        const receiptContent = await content('deployment-receipt.v1');
        const receiptBase = { environmentId: valid.id, targetLinkId: target.id, operation: 'deploy',
            requestedByAccountId: owner.id, ...receiptContent };
        const receipt = await db.deployment.create({ data: { ...receiptBase, state: 'failed', requestedAt: new Date(1000),
            requestKey: randomUUID(), actionOperationId: randomUUID() } });
        await db.deployment.create({ data: { ...receiptBase, state: 'failed', requestedAt: new Date(2000),
            requestKey: '', actionOperationId: randomUUID() } });
        const domainContent = await content('deployment-domain.v1');
        const domainBase = { environmentId: valid.id, targetLinkId: target.id, createdByAccountId: owner.id, ...domainContent };
        const domain = await db.deploymentDomain.create({ data: { ...domainBase, state: 'active' } });
        await db.deploymentDomain.create({ data: { ...domainBase, state: 'active', createdAt: new Date(-1) } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const read = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
            const query = new URLSearchParams({ serverId, projectSourceId: source.source.id, limit: '2' });
            const first = await read(`/v1/deployments/environments?${query}`);
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json()).toMatchObject({ ok: true, items: [{ id: later.id }], currentDeployments: [],
                runtimeTargetLinks: [], coverage: 'partial' });
            expect(first.json().items).toHaveLength(1);
            expect(first.json().nextCursor).toBeTruthy();
            expect(first.body).not.toContain(invalid.id);
            query.set('cursor', first.json().nextCursor);
            expect((await read(`/v1/deployments/environments?${query}`)).json()).toMatchObject({ items: [{ id: valid.id }], nextCursor: null });
            const history = await read(`/v1/deployments/environments/${valid.id}/deployments?serverId=${serverId}&limit=1`);
            expect(history.statusCode, history.body).toBe(200);
            expect(history.json()).toMatchObject({ ok: true, items: [] });
            expect(history.json().nextCursor).toBeTruthy();
            const next = await read(`/v1/deployments/environments/${valid.id}/deployments?${new URLSearchParams({ serverId, cursor: history.json().nextCursor })}`);
            expect(next.json()).toMatchObject({ ok: true, items: [{ id: receipt.id }], nextCursor: null });
            const links = await app.inject({ method: 'POST', url: '/v1/deployments/targets/list',
                headers: { 'x-test-user-id': owner.id }, payload: { serverId, scope: { kind: 'account', accountId: owner.id } } });
            expect(links.statusCode, links.body).toBe(200);
            expect(links.json()).toMatchObject({ ok: true, items: [{ targetLink: { id: target.id } }], coverage: 'partial' });
            expect(links.json().items).toHaveLength(1);
            const firstLinks = await app.inject({ method: 'POST', url: '/v1/deployments/targets/list',
                headers: { 'x-test-user-id': owner.id }, payload: { serverId, scope: { kind: 'account', accountId: owner.id }, limit: 1 } });
            expect(firstLinks.json()).toMatchObject({ ok: true, items: [], coverage: 'partial' });
            expect(firstLinks.json().nextCursor).toBeTruthy();
            expect(firstLinks.body).not.toContain(badTarget.id);
            const nextLinks = await app.inject({ method: 'POST', url: '/v1/deployments/targets/list',
                headers: { 'x-test-user-id': owner.id }, payload: { serverId, scope: { kind: 'account', accountId: owner.id },
                    cursor: firstLinks.json().nextCursor, limit: 1 } });
            expect(nextLinks.json()).toMatchObject({ ok: true, items: [{ targetLink: { id: target.id } }] });
            const domains = await read(`/v1/deployments/environments/${valid.id}/domains?serverId=${serverId}`);
            expect(domains.statusCode, domains.body).toBe(200);
            expect(domains.json()).toMatchObject({ ok: true, domains: [{ id: domain.id }] });
            expect(domains.json().domains).toHaveLength(1);
        });
    });

    it('reads exact PR preview relations through the existing list GET without a Source or Machine census', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Preview list', audience: [], repository: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/preview' }, protocol: 'https' } }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Preview' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'unopened-preview-body' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const base = { projectSourceId: source.source.id, createdByAccountId: owner.id,
            protection: 'nonProduction', deployerMode: 'managers', controllerMachineId: machine.id,
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const template = await db.deploymentEnvironment.create({ data: { ...base, purpose: 'standard' } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: template.id, createdByAccountId: owner.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
        const children = await Promise.all(['pr:17', 'pr:18', 'pr:19'].map(previewPullRequestId =>
            db.deploymentEnvironment.create({ data: { ...base, purpose: 'preview', previewTemplateEnvironmentId: template.id,
                previewRepositoryId: source.source.id, previewPullRequestId, previewTargetLinkId: link.id } })));
        const peerTemplate = await db.deploymentEnvironment.create({ data: { ...base, purpose: 'standard' } });
        const peerLink = await db.deploymentTargetLink.create({ data: { environmentId: peerTemplate.id, createdByAccountId: owner.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
        await db.deploymentEnvironment.create({ data: { ...base, purpose: 'preview', previewTemplateEnvironmentId: peerTemplate.id,
            previewRepositoryId: source.source.id, previewPullRequestId: 'pr:sibling', previewTargetLinkId: peerLink.id } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const templateQuery = new URLSearchParams({ serverId, previewTemplateEnvironmentId: template.id, limit: '1' });
            const templateRequests: { model?: string; action: string; args?: unknown }[] = [];
            const stopTemplate = observeSqliteRequests({ before: request => { templateRequests.push(request); } });
            const templatePage = await app.inject({ method: 'GET', url: `/v1/deployments/environments?${templateQuery}`,
                headers: { 'x-test-user-id': owner.id } }).finally(stopTemplate);
            expect(templatePage.statusCode, templatePage.body).toBe(200);
            expect(templateRequests.filter(row => row.model === 'DeploymentEnvironment' && row.action === 'findMany'))
                .toEqual([expect.objectContaining({ args: expect.objectContaining({ where: expect.objectContaining({
                    purpose: 'preview', previewTemplateEnvironmentId: template.id,
                }) }) })]);
            expect(templatePage.json().items.map((row: { id: string }) => row.id)).toEqual([children.map(row => row.id).sort().reverse()[0]]);
            expect(templatePage.json().nextCursor).toBeTruthy();
            expect(templateRequests.filter(row => row.model === 'Artifact')).toEqual([]);
            templateQuery.set('cursor', templatePage.json().nextCursor);
            const templateNext = await app.inject({ method: 'GET', url: `/v1/deployments/environments?${templateQuery}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(templateNext.json().items.map((row: { id: string }) => row.id)).toEqual([children.map(row => row.id).sort().reverse()[1]]);
            const sealedCursor = sealDeploymentReadCursor(owner.id, { serverId, previewTemplateEnvironmentId: template.id },
                children.map(row => row.id).sort().reverse()[0]!);
            expect(await inTx(tx => listDeploymentEnvironmentsInTx(tx, owner.id,
                { serverId, previewTemplateEnvironmentId: template.id, cursor: sealedCursor, limit: 1 })))
                .toMatchObject({ ok: true, items: [{ id: children.map(row => row.id).sort().reverse()[1] }] });
            expect(await inTx(tx => listDeploymentEnvironmentsInTx(tx, owner.id,
                { serverId, previewTemplateEnvironmentId: peerTemplate.id, cursor: sealedCursor, limit: 1 })))
                .toEqual({ ok: false, error: 'deployment_invalid' });
            const queries: { model?: string; action: string }[] = [];
            const stop = observeSqliteRequests({ before: request => { queries.push(request); } });
            const query = new URLSearchParams({ serverId, previewRepositoryId: source.source.id });
            query.append('previewPullRequestIds', 'pr:17');
            query.append('previewPullRequestIds', 'pr:18');
            const response = await app.inject({ method: 'GET', url: `/v1/deployments/environments?${query}`,
                headers: { 'x-test-user-id': owner.id } }).finally(stop);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().items.map((row: { id: string }) => row.id).sort())
                .toEqual(children.slice(0, 2).map(row => row.id).sort());
            expect(response.json().projectSources).toEqual([{ id: source.source.id, name: source.source.name }]);
            const identityQuery = new URLSearchParams({ serverId, previewRepository: JSON.stringify({
                kind: 'github', deployment: 'https://github.com', repository: 'Acme/Preview' }), previewPullRequestIds: 'pr:17' });
            const predicates: unknown[] = [];
            const stopIdentity = observeSqliteRequests({ before: request => {
                if (request.model === 'DeploymentEnvironment' && request.action === 'findMany') predicates.push(request.args);
            } });
            const identityRead = await app.inject({ method: 'GET', url: `/v1/deployments/environments?${identityQuery}`,
                headers: { 'x-test-user-id': owner.id } }).finally(stopIdentity);
            expect(identityRead.statusCode, identityRead.body).toBe(200);
            expect(identityRead.json().items.map((row: { id: string }) => row.id)).toEqual([children[0]!.id]);
            const plan = await db.$queryRawUnsafe<{ detail: string }[]>(
                'EXPLAIN QUERY PLAN SELECT "id" FROM "DeploymentEnvironment" WHERE "previewPullRequestId" = ? AND "purpose" = ? AND "deletedAt" IS NULL ORDER BY "id"',
                'pr:17', 'preview');
            expect(plan.map(row => row.detail).join('\n')).toContain('DeploymentEnvironment_preview_scope_idx');
            expect(predicates).toEqual([expect.objectContaining({ where: expect.objectContaining({
                purpose: 'preview', previewPullRequestId: { in: ['pr:17'] } }) })]);
            identityQuery.set('previewRepository', JSON.stringify({ kind: 'github', deployment: 'https://github.com', repository: 'acme/other' }));
            const otherRepository = await app.inject({ method: 'GET', url: `/v1/deployments/environments?${identityQuery}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(otherRepository.json()).toMatchObject({ ok: true, items: [] });
            expect(queries.filter(row => row.model === 'DeploymentEnvironment' && row.action === 'findMany')).toHaveLength(1);
            expect(queries.filter(row => row.model === 'ProjectSource' && row.action === 'findUnique')).toHaveLength(1);
            expect(queries.filter(row => (row.model === 'ProjectSource' || row.model === 'Machine') && row.action === 'findMany')).toEqual([]);
            expect(response.body).not.toContain('unopened-preview-body');
            const denied = await app.inject({ method: 'GET', url: `/v1/deployments/environments?${query}`,
                headers: { 'x-test-user-id': stranger.id } });
            expect(denied.body).not.toContain(children[0]!.id);
            expect(denied.body).not.toContain(source.source.id);
            expect(denied.body).not.toContain(source.source.name);
            const renamed = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: source.source.id,
                expectedRevision: source.source.revision, patch: { name: 'Renamed preview Project' } }));
            expect(renamed).toMatchObject({ ok: true });
            const updated = await app.inject({ method: 'GET', url: `/v1/deployments/environments?${query}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(updated.json().projectSources).toEqual([{ id: source.source.id, name: 'Renamed preview Project' }]);
            // The failed receipt is outside the demanded PR page. The Projects
            // badge must read the list owner's metadata summary, not page it in.
            const runtime = await db.deploymentTargetLink.create({ data: { environmentId: children[2]!.id,
                createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                targetKind: 'ownServer', state: 'configured', contentArtifactId: artifact.artifact.id,
                contentHeaderVersion: 1, contentBodyVersion: 1 } });
            const receipt = { environmentId: children[2]!.id, targetLinkId: runtime.id, operation: 'deploy',
                requestKey: randomUUID(), actionOperationId: randomUUID(), requestedByAccountId: owner.id,
                contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
            await db.deployment.create({ data: { ...receipt, state: 'failed', requestedAt: new Date(1000) } });
            const summaryQuery = new URLSearchParams({ serverId, projectSourceId: source.source.id, projection: 'activity' });
            const summaryRequests: { model?: string; action: string }[] = [];
            const stopSummary = observeSqliteRequests({ before: request => { summaryRequests.push(request); } });
            const summary = await app.inject({ method: 'GET', url: `/v1/deployments/environments?${summaryQuery}`,
                headers: { 'x-test-user-id': owner.id } }).finally(stopSummary);
            expect(summary.statusCode, summary.body).toBe(200);
            expect(summary.json()).toMatchObject({ activity: { running: false, failed: true }, items: [], nextCursor: null });
            expect(summaryRequests.filter(row => row.model === 'Artifact'
                || row.model === 'DeploymentEnvironment' && row.action === 'findMany'
                || row.model === 'ProjectSource' && row.action === 'findMany'
                || row.model === 'Machine' && row.action === 'findMany')).toEqual([]);
            const hiddenSummary = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments?${new URLSearchParams({ serverId, projection: 'activity' })}`,
                headers: { 'x-test-user-id': stranger.id } });
            expect(hiddenSummary.json()).toMatchObject({ activity: { running: false, failed: false }, items: [] });
            await db.deployment.create({ data: { ...receipt, requestKey: randomUUID(), actionOperationId: randomUUID(),
                state: 'succeeded', requestedAt: new Date(2000) } });
            const recovered = await app.inject({ method: 'GET', url: `/v1/deployments/environments?${summaryQuery}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(recovered.json()).toMatchObject({ activity: { running: false, failed: false } });
        });
    });

    it('pages retained Source Environments only on explicit demand and keeps Source disclosure', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Retained Move inventory', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Retained' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'private-retained-body' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const ids = [0, 1, 2].map(index => `retained-${source.source.id}-${index}`);
        await db.deploymentEnvironment.createMany({ data: ids.map((id, index) => ({ id,
            projectSourceId: source.source.id, createdByAccountId: owner.id, controllerMachineId: machine.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
            deletedAt: index === 1 ? null : new Date(),
        })) });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const base = `/v1/deployments/environments?serverId=${serverId}&projectSourceId=${source.source.id}`;
            const read = (url: string, actor = owner.id) => app.inject({ method: 'GET', url,
                headers: { 'x-test-user-id': actor } });
            const live = await read(base);
            expect(live.statusCode, live.body).toBe(200);
            expect(live.json().items.map((item: { id: string }) => item.id)).toEqual([ids[1]]);
            let cursor: string | null = null;
            const found: string[] = [];
            do {
                const queries: { model?: string; action: string }[] = [];
                const stop = observeSqliteRequests({ before: request => { queries.push(request); } });
                const page = await read(`${base}&includeDeleted=true&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
                    .finally(stop);
                expect(page.statusCode, page.body).toBe(200);
                expect(queries.filter(query => query.model === 'DeploymentEnvironment' && query.action === 'findMany')).toHaveLength(1);
                expect(queries.filter(query => query.model === 'Artifact')).toEqual([]);
                expect(page.body).not.toContain('private-retained-body');
                const result = page.json();
                expect(result.coverage).toBe('complete');
                found.push(...result.items.map((item: { id: string }) => item.id));
                cursor = result.nextCursor;
            } while (cursor);
            expect(found).toEqual([...ids].reverse());
            const hidden = await read(`${base}&includeDeleted=true`, outsider.id);
            expect(hidden.statusCode).toBe(404);
            expect(hidden.json()).toMatchObject({ ok: false, error: 'deployment_unavailable' });
            expect(hidden.body).not.toContain(ids[0]);
            for (const url of [`${base}&includeDeleted=false`, `${base}&includeDeleted=1`,
                `/v1/deployments/environments?serverId=${serverId}&includeDeleted=true`]) {
                const refused = await read(url);
                expect(refused.statusCode, refused.body).toBe(400);
            }
        });
    });

    it('pages All across unreadable candidates without disclosing them or crawling Project sources', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sources = await Promise.all([owner, stranger].map(account => inTx(tx => createProjectSourceInTx(tx, account.id,
            { serverId, requestKey: randomUUID(), name: account.id === owner.id ? 'All inventory' : 'Private Source name', audience: [] }))));
        const [visible, hidden] = sources;
        if (!visible.ok || !hidden.ok) throw new Error('Source fixture refused');
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}', installationId: randomUUID() } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'All inventory' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'unopened' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const prefix = `inventory-${randomUUID()}`;
        const ids = [2, 1, 0].map(index => `${prefix}-${index}`);
        await db.deploymentEnvironment.createMany({ data: ids.map((id, index) => ({ id,
            projectSourceId: index === 0 ? hidden.source.id : visible.source.id,
            createdByAccountId: owner.id, controllerMachineId: machine.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        })) });
        // Start at this fixture's range: existing unrelated fixture rows are not this demand.
        let cursor: string | undefined = `${prefix}-3`;
        const found: string[] = [];
        for (let index = 0; index < ids.length; index++) {
            const queries: { model?: string; action: string }[] = [];
            const stop = observeSqliteRequests({ before: request => { queries.push(request); } });
            const page = await inTx(tx => listDeploymentEnvironmentsInTx(tx, owner.id, { serverId, cursor, limit: 1 }));
            stop();
            expect(page).toMatchObject({ ok: true });
            if (!page.ok) throw new Error(page.error);
            expect(queries.filter(query => query.model === 'ProjectSource' && query.action === 'findMany')).toHaveLength(0);
            expect(page.items.length).toBeLessThanOrEqual(1);
            expect(page).toMatchObject({ projectSources: index === 0 ? [] : [{ id: visible.source.id, name: visible.source.name }] });
            expect(JSON.stringify(page)).not.toContain(hidden.source.name);
            if (index === 0) {
                expect(page).toMatchObject({ coverage: 'partial', items: [] });
                expect(page.nextCursor).toBeTruthy();
                expect(JSON.stringify(page)).not.toContain(ids[0]);
                expect(JSON.stringify(page)).not.toContain(hidden.source.id);
                const continuation = page.nextCursor!;
                expect(await inTx(tx => listDeploymentEnvironmentsInTx(tx, stranger.id,
                    { serverId, cursor: continuation, limit: 1 }))).toEqual({ ok: false, error: 'deployment_invalid' });
                expect(await inTx(tx => listDeploymentEnvironmentsInTx(tx, owner.id,
                    { serverId, projectSourceId: visible.source.id, cursor: continuation, limit: 1 })))
                    .toEqual({ ok: false, error: 'deployment_invalid' });
            }
            found.push(...page.items.map(item => item.id));
            cursor = page.nextCursor ?? undefined;
        }
        expect(found).toEqual(ids.slice(1));

        // Machine Services names its visible owner groups, not the Account's
        // inventory. The same list owner applies Source disclosure before
        // returning those exact headers; an unreadable id stays absent.
        const selectedInput = { serverId, environmentIds: [ids[0]!, ids[2]!] };
        const selected = await inTx(tx => listDeploymentEnvironmentsInTx(tx, owner.id, selectedInput));
        expect(selected).toMatchObject({ ok: true, items: [{ id: ids[2] }] });
        if (!selected.ok) throw new Error(selected.error);
        expect(selected.items.map(item => item.id)).toEqual([ids[2]]);
        expect(JSON.stringify(selected)).not.toContain(ids[0]);
        expect(JSON.stringify(selected)).not.toContain(hidden.source.id);
        const emptyInput = { serverId, environmentIds: [] as string[] };
        expect(await inTx(tx => listDeploymentEnvironmentsInTx(tx, owner.id, emptyInput)))
            .toMatchObject({ ok: true, items: [], nextCursor: null });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            // A single selected owner must decode as the same vector as a
            // multi-owner request at the genuine GET boundary.
            const response = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments?serverId=${serverId}&environmentIds=${encodeURIComponent(ids[2]!)}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().items.map((item: { id: string }) => item.id)).toEqual([ids[2]]);
        });
    });

    it.each(['account', 'team'] as const)('batches %s Artifact admission across retained links without weakening revision or grant checks', async kind => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Read owner' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: randomUUID(), name: 'Read owner',
            owner: kind === 'team' ? { kind, teamId: team.id } : { kind, accountId: owner.id },
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        async function content(artifactKind: string) {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: artifactKind, title: 'Read owner' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'unopened' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            if (kind === 'team') await db.artifactTeamGrant.create({ data: { artifactId: created.artifact.id,
                teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id } });
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, ...await content('deployment-environment.v1') } });
        const reference = await content('deployment-target-link.v1');
        const ids = Array.from({ length: 100 }, () => randomUUID());
        // Storage fixtures preserve the real relation/header shape; the route performs all admission.
        await db.deploymentTargetLink.createMany({ data: ids.map(id => ({ id, environmentId: environment.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            createdByAccountId: owner.id, ...reference })) });
        await db.deploymentTargetLinkMachine.createMany({ data: ids.map(targetLinkId => ({ targetLinkId,
            machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' })) });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: ids.at(-1) } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const read = () => app.inject({ method: 'GET', url: `/v1/deployments/environments/${environment.id}?serverId=${serverId}`,
                headers: { 'x-test-user-id': owner.id } });
            const queries: string[] = [];
            const stop = observeSqliteRequests({ before: request => {
                if (request.model === 'Artifact' || request.model === 'ArtifactTeamGrant') queries.push(`${request.model}.${request.action}`);
            } });
            try {
                const result = await read();
                expect(result.statusCode, result.body).toBe(200);
                expect(result.json()).toMatchObject({ ok: true, environment: { runtimeTargetLinkId: ids.at(-1) } });
                expect(result.json().targetLinks).toHaveLength(ids.length);
                expect(queries.filter(query => query.startsWith('Artifact.'))).toHaveLength(1);
                expect(queries.filter(query => query.startsWith('ArtifactTeamGrant.'))).toHaveLength(kind === 'team' ? 1 : 0);
            } finally { stop(); }
            await db.deploymentTargetLink.update({ where: { id: ids[0]! }, data: { contentBodyVersion: 2 } });
            expect((await read()).json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
            await db.deploymentTargetLink.update({ where: { id: ids[0]! }, data: { contentBodyVersion: 1 } });
            if (kind === 'team') {
                await db.artifactTeamGrant.deleteMany({ where: { artifactId: reference.contentArtifactId, teamId: team.id } });
                expect((await read()).json()).toMatchObject({ ok: false, error: 'deployment_content_unavailable' });
            }
        });
    });
});
