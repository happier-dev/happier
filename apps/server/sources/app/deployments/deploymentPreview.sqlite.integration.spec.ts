import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, DeploymentEnvironmentCreateResultV1Schema,
    DeploymentEnvironmentCreateStorageInputV1Schema,
    MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { createDeploymentEnvironmentInTx, projectDeploymentEnvironmentHeader, loadDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { linkDeploymentTargetInTx } from './deploymentTargetLinkService';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { registerAutomationV3Routes } from '@/app/api/routes/automations/registerAutomationV3Routes';
import { updateAutomation } from '@/app/automations/automationCrudService';
import { admitPreviewEnvironmentRelationInTx } from './previewEnvironmentRelation';

describe('preview Environment relation admission', () => {
    const serverId = `srv_${'b'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-preview-environment-', initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('preserves private preview lineage through ordinary HTTP edits before storage', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Preview lineage', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'Preview runtime', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/preview', happyHomeDir: '/home/preview/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: crypto.randomUUID() } });
        const repository = { kind: 'github', deployment: 'https://github.example/enterprise', repository: 'owner/app' };
        const templateEnvironmentId = crypto.randomUUID();
        const runtimeTargetLinkId = crypto.randomUUID();
        const previewProvenance = { v: 1, templateEnvironmentId, runtimeTargetLinkId,
            repository, pullRequestId: 'opaque-pr-17', pullRequestNumber: 17,
            author: { id: 'author', login: 'contributor' }, headRepository: repository };
        const content = { name: 'Preview', retainPreviousDeployments: 1, bindings: [], previewProvenance,
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } } };
        const artifactFor = async (body: unknown) => {
            const stored = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Preview' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!stored.ok) throw new Error(stored.error);
            return { contentArtifactId: stored.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const original = await artifactFor(content);
        // Retained rows are this storage-boundary fixture. Preview creation and
        // lifecycle admission are exercised separately, never inferred here.
        await db.deploymentEnvironment.create({ data: { id: templateEnvironmentId, projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, ...original } });
        await db.deploymentTargetLink.create({ data: { id: runtimeTargetLinkId, environmentId: templateEnvironmentId,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', ...original } });
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers',
            previewTemplateEnvironmentId: templateEnvironmentId, previewRepositoryId: source.source.id,
            previewPullRequestId: previewProvenance.pullRequestId, previewTargetLinkId: runtimeTargetLinkId,
            controllerMachineId: machine.id, ...original } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            for (const provenance of [undefined, { ...previewProvenance, templateEnvironmentId: 'foreign-template' },
                { ...previewProvenance, headRepository: { ...repository, repository: 'foreign/app' } }]) {
                const candidate = await artifactFor({ ...content, name: 'Edited', previewProvenance: provenance });
                const response = await app.inject({ method: 'PATCH', url: `/v1/deployments/environments/${environment.id}`,
                    headers: { 'x-test-user-id': owner.id }, payload: { serverId, environmentId: environment.id,
                        expectedRevision: environment.revision, ...candidate } });
                expect(response.statusCode, response.body).toBe(409);
                expect(response.json()).toEqual({ ok: false, error: 'deployment_conflict' });
            }
            expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } }))
                .toMatchObject({ revision: environment.revision, ...original });
            const candidate = await artifactFor({ ...content, name: 'Edited' });
            const response = await app.inject({ method: 'PATCH', url: `/v1/deployments/environments/${environment.id}`,
                headers: { 'x-test-user-id': owner.id }, payload: { serverId, environmentId: environment.id,
                    expectedRevision: environment.revision, ...candidate } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ ok: true, environmentId: environment.id, revision: environment.revision + 1 });
        });
    });

    it('creates and replays a child through the exact current template Source and link, without private metadata columns', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: crypto.randomUUID(),
            name: 'Preview source', audience: [], repository: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.example/enterprise' },
                repository: { nameWithOwner: 'owner/app', cloneUrl: 'https://github.example/enterprise/owner/app.git' }, protocol: 'https',
            } }));
        if (!source.ok) throw new Error(source.error);
        const repository = { kind: 'github', deployment: 'https://github.example/enterprise', repository: 'owner/app' };
        const content = { name: 'Preview', retainPreviousDeployments: 1, bindings: [],
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } } };
        const artifactFor = async (kind: string, body: unknown) => {
            const stored = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Preview' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!stored.ok) throw new Error(stored.error);
            return { contentArtifactId: stored.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const parentContent = await artifactFor('deployment-environment.v1', content);
        const installationId = crypto.randomUUID();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, installationId,
            metadata: encodePlainMachineStoredContent({ host: 'Preview runtime', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/preview', happyHomeDir: '/home/preview/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const placement = { serverId, projectSourceId: source.source.id, protection: 'nonProduction' as const,
            deployerMode: 'managers' as const, controllerMachineId: machine.id };
        const parent = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            ...placement, ...parentContent, purpose: 'standard', requestKey: crypto.randomUUID() }));
        if (!parent.ok) throw new Error(parent.error);
        const linkContent = await artifactFor('deployment-target-link.v1', {});
        const link = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId, environmentId: parent.environmentId,
            expectedRevision: parent.revision, requestKey: crypto.randomUUID(), targetId: 'own-server', role: 'runtime',
            machines: [{ machineId: machine.id, installationId }], ...linkContent }));
        if (!link.ok) throw new Error(link.error);
        const otherTemplate = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            ...placement, ...parentContent, purpose: 'standard', requestKey: crypto.randomUUID() }));
        if (!otherTemplate.ok) throw new Error(otherTemplate.error);
        const otherLink = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId,
            environmentId: otherTemplate.environmentId, expectedRevision: otherTemplate.revision,
            requestKey: crypto.randomUUID(), targetId: 'own-server', role: 'runtime',
            machines: [{ machineId: machine.id, installationId }], ...linkContent }));
        if (!otherLink.ok) throw new Error(otherLink.error);
        const sourceDataContent = await artifactFor('deployment-target-link.v1', {});
        const dataLink = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId,
            environmentId: parent.environmentId, expectedRevision: link.revision, requestKey: crypto.randomUUID(),
            targetId: 'database', role: 'data', source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.supabase', localId: 'database' } },
            targetKind: 'postgres', machines: [], ...sourceDataContent }));
        if (!dataLink.ok) throw new Error(dataLink.error);
        const childDataContent = await artifactFor('deployment-target-link.v1', {});
        const childRuntimeContent = await artifactFor('deployment-target-link.v1', {});
        const childContent = await artifactFor('deployment-environment.v1', { ...content, previewProvenance: {
            v: 1, templateEnvironmentId: parent.environmentId, runtimeTargetLinkId: link.targetLinkId, repository,
            pullRequestId: 'opaque-pr-17', pullRequestNumber: 17, author: { id: 'author', login: 'contributor' }, headRepository: repository,
        } });
        const input = { ...placement, ...childContent, purpose: 'preview' as const, requestKey: crypto.randomUUID(),
            preview: { templateEnvironmentId: parent.environmentId, expectedTemplateRevision: dataLink.revision,
                pullRequestId: 'opaque-pr-17', runtimeTargetLinkId: link.targetLinkId },
            firstTargetLink: { ...childRuntimeContent, machines: [{ machineId: machine.id, installationId }] },
            previewDataTargetLinks: [{ templateDataTargetLinkId: dataLink.targetLinkId,
                expectedTemplateTargetLinkRevision: dataLink.targetLinkRevision, ...childDataContent }] };
        // AM-10 admits the prepared storage relationship. Artifact preparation,
        // explicit Duplicate choices and SCM/fork execution keep their own owners.
        const admissionAutomationId = crypto.randomUUID();
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const denied = await app.inject({ method: 'POST', url: '/v1/deployments/environments',
                headers: { 'x-test-user-id': owner.id }, payload: input });
            expect(denied.statusCode, denied.body).toBe(409);
            expect(denied.json()).toEqual({ ok: false, error: 'deployment_conflict' });
        });
        await withAuthenticatedTestApp(registerAutomationV3Routes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v3/automations',
                headers: { 'x-test-user-id': owner.id }, payload: {
                    automationId: admissionAutomationId, name: 'Preview admission', enabled: true, triggers: [],
                    assignments: [{ machineId: machine.id }], executionRecipe: {
                        ...createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Preview' }),
                        deploymentEnvironment: { serverId, projectSourceId: source.source.id,
                            environmentId: parent.environmentId, previewRole: 'preview_admission' },
                    },
                } });
            expect(response.statusCode, response.body).toBe(200);
        });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const postCreate = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/deployments/environments',
                headers: { 'x-test-user-id': owner.id, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
            for (const candidate of [
                { ...input.previewDataTargetLinks[0], templateDataTargetLinkId: link.targetLinkId },
                { ...input.previewDataTargetLinks[0], expectedTemplateTargetLinkRevision: dataLink.targetLinkRevision + 1 },
                { ...input.previewDataTargetLinks[0], ...sourceDataContent },
            ]) {
                const refused = await postCreate({ ...input, requestKey: crypto.randomUUID(), previewDataTargetLinks: [candidate] });
                expect(refused.statusCode, refused.body).toBe(409);
                expect(await db.deploymentEnvironment.count({ where: { previewTemplateEnvironmentId: parent.environmentId } })).toBe(0);
            }
            const response = await postCreate(input);
            expect(response.statusCode, response.body).toBe(200);
            const created = DeploymentEnvironmentCreateResultV1Schema.parse(response.json());
            if (!created.ok) throw new Error(created.error);
            expect(created).toMatchObject({ revision: 3, runtimeTargetLinkId: expect.any(String),
                previewDataTargets: [{ templateDataTargetLinkId: dataLink.targetLinkId,
                targetLinkId: expect.any(String), targetLinkRevision: 1 }] });
            const childLinks = await db.deploymentTargetLink.findMany({ where: { environmentId: created.environmentId } });
            expect(childLinks).toHaveLength(2);
            const childData = childLinks.find(row => row.role === 'data');
            expect(childData).toMatchObject({ role: 'data', pluginId: 'happier.deploy.supabase', contributionLocalId: 'database',
                targetKind: 'postgres', ...childDataContent });
            expect(childData!.id).not.toBe(dataLink.targetLinkId);
            expect(childLinks.find(row => row.role === 'runtime')).toMatchObject({ id: created.runtimeTargetLinkId,
                hostTargetId: 'own-server', ...childRuntimeContent });
            expect(created.runtimeTargetLinkId).not.toBe(link.targetLinkId);
            const companionContent = await artifactFor('deployment-environment.v1', {
                name: 'Preview data', retainPreviousDeployments: 1, bindings: [],
                definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
                    document: 'services:\n  database:\n    image: postgres:17\n', profiles: [], services: ['database'] },
            });
            const companionRuntimeContent = await artifactFor('deployment-target-link.v1', {});
            const companionInput = { ...placement, ...companionContent, purpose: 'standard',
                requestKey: crypto.randomUUID(), previewCompanionOfEnvironmentId: created.environmentId,
                preview: input.preview,
                firstTargetLink: { ...companionRuntimeContent, machines: [{ machineId: machine.id, installationId }] } };
            expect(await inTx(tx => admitPreviewEnvironmentRelationInTx(tx, owner.id,
                DeploymentEnvironmentCreateStorageInputV1Schema.parse(companionInput), {}))).toMatchObject({
                ok: true, relation: { previewCompanionOfEnvironmentId: created.environmentId } });
            for (const substitution of [
                { previewCompanionOfEnvironmentId: parent.environmentId },
                { preview: { ...input.preview, pullRequestId: 'another-pr' } },
                { controllerMachineId: crypto.randomUUID() },
                { buildMachineId: crypto.randomUUID() },
                { protection: 'production' },
            ]) {
                const denied = await postCreate({ ...companionInput, ...substitution, requestKey: crypto.randomUUID() });
                expect(denied.statusCode, denied.body).toBe(409);
            }
            const companionInventoryUrl = `/v1/deployments/environments?serverId=${encodeURIComponent(serverId)}&previewCompanionOfEnvironmentId=${encodeURIComponent(created.environmentId)}`;
            const refusedCompanions = await app.inject({ method: 'GET', url: `${companionInventoryUrl}&includeDeleted=true`,
                headers: { 'x-test-user-id': owner.id } });
            expect(refusedCompanions.statusCode, refusedCompanions.body).toBe(200);
            expect(refusedCompanions.json()).toMatchObject({ ok: true, items: [] });
            const companionResponse = await postCreate(companionInput);
            expect(companionResponse.statusCode, companionResponse.body).toBe(200);
            const companion = DeploymentEnvironmentCreateResultV1Schema.parse(companionResponse.json());
            if (!companion.ok) throw new Error(companion.error);
            expect((await postCreate(companionInput)).json()).toEqual({ ...companion, replayed: true });
            const companionDuplicate = await postCreate({ ...companionInput, requestKey: crypto.randomUUID() });
            expect(companionDuplicate.statusCode, companionDuplicate.body).toBe(409);
            const companionList = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments?serverId=${encodeURIComponent(serverId)}&previewCompanionOfEnvironmentId=${encodeURIComponent(created.environmentId)}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(companionList.statusCode, companionList.body).toBe(200);
            expect(companionList.json()).toMatchObject({ ok: true, items: [{ id: companion.environmentId,
                purpose: 'standard', previewCompanionOfEnvironmentId: created.environmentId,
                previewTemplateEnvironmentId: parent.environmentId }] });
            for (const key of ['previewRepositoryId', 'previewPullRequestId', 'previewTargetLinkId']) {
                expect(companionList.json().items[0]).not.toHaveProperty(key);
            }
            const companionRead = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${encodeURIComponent(companion.environmentId)}?serverId=${encodeURIComponent(serverId)}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(companionRead.statusCode, companionRead.body).toBe(200);
            expect(companionRead.json()).toMatchObject({ ok: true, environment: {
                id: companion.environmentId, purpose: 'standard', previewCompanionOfEnvironmentId: created.environmentId,
                previewTemplateEnvironmentId: parent.environmentId } });
            const companionApproval = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${encodeURIComponent(companion.environmentId)}?serverId=${encodeURIComponent(serverId)}&projection=approvalScope`,
                headers: { 'x-test-user-id': owner.id } });
            expect(companionApproval.statusCode, companionApproval.body).toBe(200);
            expect(companionApproval.json()).toEqual({ ok: true, environment: { id: companion.environmentId,
                projectSourceId: source.source.id, purpose: 'standard', previewCompanionOfEnvironmentId: created.environmentId,
                previewTemplateEnvironmentId: parent.environmentId } });
            const replay = await postCreate(input);
            expect(replay.statusCode, replay.body).toBe(200);
            expect(DeploymentEnvironmentCreateResultV1Schema.parse(replay.json())).toEqual({ ...created, replayed: true });
            const admitted = await inTx(tx => loadDeploymentEnvironmentInTx(tx, owner.id, serverId, created.environmentId));
            if (!admitted.ok) throw new Error(admitted.error);
            expect(projectDeploymentEnvironmentHeader(admitted.row, serverId, admitted.admission)).toMatchObject({
                purpose: 'preview', previewTemplateEnvironmentId: parent.environmentId, previewRepositoryId: source.source.id,
                previewPullRequestId: 'opaque-pr-17', previewTargetLinkId: link.targetLinkId,
            });
            expect(JSON.stringify(admitted.row)).not.toContain('github.example');
            expect(JSON.stringify(admitted.row)).not.toContain('contributor');
            await withAuthenticatedTestApp(registerAutomationV3Routes, async automationApp => {
                const response = await automationApp.inject({ method: 'POST', url: '/v3/automations',
                    headers: { 'x-test-user-id': owner.id }, payload: {
                        automationId: crypto.randomUUID(), name: 'Child cannot admit previews', enabled: true, triggers: [],
                        assignments: [{ machineId: machine.id }], executionRecipe: {
                            ...createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Preview' }),
                            deploymentEnvironment: { serverId, projectSourceId: source.source.id,
                                environmentId: created.environmentId, previewRole: 'preview_admission' },
                        },
                    } });
                expect(response.statusCode, response.body).toBe(400);
            });
            const standard = await inTx(tx => loadDeploymentEnvironmentInTx(tx, owner.id, serverId, parent.environmentId));
            if (!standard.ok) throw new Error(standard.error);
            const standardHeader = projectDeploymentEnvironmentHeader(standard.row, serverId, standard.admission);
            for (const key of ['previewTemplateEnvironmentId', 'previewRepositoryId', 'previewPullRequestId', 'previewTargetLinkId']) {
                expect(standardHeader).not.toHaveProperty(key);
            }
            const before = await db.deploymentEnvironment.count({ where: { projectSourceId: source.source.id } });
            const stale = await postCreate({ ...input, requestKey: crypto.randomUUID(),
                preview: { ...input.preview, expectedTemplateRevision: dataLink.revision + 1 } });
            expect(stale.statusCode, stale.body).toBe(409);
            expect(stale.json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
            const otherSource = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
                serverId, requestKey: crypto.randomUUID(), name: 'Foreign preview Source', audience: [],
            }));
            if (!otherSource.ok) throw new Error(otherSource.error);
            const foreign = await postCreate({ ...input, projectSourceId: otherSource.source.id, requestKey: crypto.randomUUID() });
            expect(foreign.statusCode, foreign.body).toBe(409);
            const repoLessTemplate = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
                ...placement, projectSourceId: otherSource.source.id, ...parentContent,
                purpose: 'standard', requestKey: crypto.randomUUID() }));
            if (!repoLessTemplate.ok) throw new Error(repoLessTemplate.error);
            const repoLessLink = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId,
                environmentId: repoLessTemplate.environmentId, expectedRevision: repoLessTemplate.revision,
                requestKey: crypto.randomUUID(), targetId: 'own-server', role: 'runtime',
                machines: [{ machineId: machine.id, installationId }], ...linkContent }));
            if (!repoLessLink.ok) throw new Error(repoLessLink.error);
            await withAuthenticatedTestApp(registerAutomationV3Routes, async automationApp => {
                const saved = await automationApp.inject({ method: 'POST', url: '/v3/automations',
                    headers: { 'x-test-user-id': owner.id }, payload: {
                        automationId: crypto.randomUUID(), name: 'Repository-only previews', enabled: true, triggers: [],
                        assignments: [{ machineId: machine.id }], executionRecipe: {
                            ...createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Preview' }),
                            deploymentEnvironment: { serverId, projectSourceId: otherSource.source.id,
                                environmentId: repoLessTemplate.environmentId, previewRole: 'preview_admission' },
                        },
                    } });
                expect(saved.statusCode, saved.body).toBe(200);
            });
            const noRepository = await postCreate({ ...input, projectSourceId: otherSource.source.id,
                requestKey: crypto.randomUUID(), preview: { ...input.preview,
                    templateEnvironmentId: repoLessTemplate.environmentId, expectedTemplateRevision: repoLessLink.revision,
                    runtimeTargetLinkId: repoLessLink.targetLinkId } });
            expect(noRepository.statusCode, noRepository.body).toBe(409);
            const wrongLink = await postCreate({ ...input, requestKey: crypto.randomUUID(),
                preview: { ...input.preview, runtimeTargetLinkId: otherLink.targetLinkId } });
            expect(wrongLink.statusCode, wrongLink.body).toBe(409);
            const childTemplate = await postCreate({ ...input, requestKey: crypto.randomUUID(),
                preview: { ...input.preview, templateEnvironmentId: created.environmentId,
                    expectedTemplateRevision: created.revision } });
            expect(childTemplate.statusCode, childTemplate.body).toBe(409);
            const standardWithPreview = await postCreate({ ...input, requestKey: crypto.randomUUID(), purpose: 'standard' });
            expect(standardWithPreview.statusCode, standardWithPreview.body).toBe(400);
            const duplicate = await postCreate({ ...input, requestKey: crypto.randomUUID() });
            expect(duplicate.statusCode, duplicate.body).toBe(409);
            await updateAutomation({ accountId: owner.id, automationId: admissionAutomationId, input: { enabled: false } });
            const disabled = await postCreate({ ...input, requestKey: crypto.randomUUID(),
                preview: { ...input.preview, pullRequestId: 'opaque-pr-18' } });
            expect(disabled.statusCode, disabled.body).toBe(409);
            const committedRetry = await postCreate(input);
            expect(committedRetry.statusCode, committedRetry.body).toBe(200);
            expect(DeploymentEnvironmentCreateResultV1Schema.parse(committedRetry.json())).toEqual({ ...created, replayed: true });
            expect(await db.deploymentEnvironment.count({ where: { projectSourceId: source.source.id } })).toBe(before);
            // Close/recovery discovers the same relation after ordinary soft deletion.
            await db.deploymentEnvironment.updateMany({ where: { id: { in: [created.environmentId, companion.environmentId] } },
                data: { deletedAt: new Date() } });
            const removedCompanions = await app.inject({ method: 'GET', url: `${companionInventoryUrl}&includeDeleted=true`,
                headers: { 'x-test-user-id': owner.id } });
            expect(removedCompanions.statusCode, removedCompanions.body).toBe(200);
            expect(removedCompanions.json()).toMatchObject({ ok: true, items: [{ id: companion.environmentId,
                previewCompanionOfEnvironmentId: created.environmentId, previewTemplateEnvironmentId: parent.environmentId,
                deletedAtMs: expect.any(Number) }] });
        });
    });
});
