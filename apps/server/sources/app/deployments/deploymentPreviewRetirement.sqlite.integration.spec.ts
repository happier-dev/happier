import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, encodePlainMachineStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { AutomationDefinitionCreateRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { createProjectSourceInTx, updateProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createAutomation, runAutomationNow } from '@/app/automations/automationCrudService';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { linkDeploymentTargetInTx } from './deploymentTargetLinkService';
import { retireDeploymentPreviewsForSourceReplacementInTx } from './deploymentPreviewRetirement';

const serverId = `srv_${'c'.repeat(32)}`;
let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-preview-retirement-', initEncrypt: true,
    env: { HAPPIER_SERVER_IDENTITY_ID: serverId, HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' } }); }, 180_000);
afterAll(async () => { await harness?.close(); });

async function createPreviewTemplateFixture() {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const repository = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.example' },
        repository: { nameWithOwner: 'owner/app', cloneUrl: 'https://github.example/owner/app.git' }, protocol: 'https' as const };
    const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
        requestKey: crypto.randomUUID(), name: 'Preview repository', audience: [], repository }));
    if (!source.ok) throw new Error(source.error);
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        installationId: crypto.randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'Preview', platform: 'linux',
            happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
        dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
    const composeDocument = '{"services":{"app":{"image":"app:1"}}}';
    const artifact = async (kind: string) => {
        const stored = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Preview' })),
            // Environment create opens plain content through its canonical schema (717576ac290).
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: kind === 'deployment-environment.v1'
                ? JSON.stringify(DeploymentEnvironmentContentV1Schema.parse({ name: 'Preview', retainPreviousDeployments: 1, bindings: [],
                    definition: { kind: 'stored', contentRevision: 1, document: composeDocument, profiles: [], services: ['app'],
                        composeDigest: `sha256:${createHash('sha256').update(composeDocument).digest('hex')}` } }))
                : '{}' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!stored.ok) throw new Error(stored.error);
        return { contentArtifactId: stored.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
    };
    const placement = { serverId, projectSourceId: source.source.id, protection: 'nonProduction' as const,
        deployerMode: 'managers' as const, controllerMachineId: machine.id };
    const parentContent = await artifact('deployment-environment.v1');
    const parent = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
        ...placement, ...parentContent, purpose: 'standard', requestKey: crypto.randomUUID() }));
    if (!parent.ok) throw new Error(parent.error);
    const linkContent = await artifact('deployment-target-link.v1');
    const link = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId, environmentId: parent.environmentId,
        expectedRevision: parent.revision, requestKey: crypto.randomUUID(), targetId: 'own-server', role: 'runtime',
        machines: [{ machineId: machine.id, installationId: machine.installationId! }], ...linkContent }));
    if (!link.ok) throw new Error(link.error);
    return { owner, repository, source, machine, artifact, placement, parent, link };
}

it.each(['Source CAS', 'transaction helper'] as const)('%s retires only preview admission and queues normal cleanup atomically with repository replacement', async entry => {
    const { owner, repository, source, machine, artifact, placement, parent, link } = await createPreviewTemplateFixture();
    const jobs = await Promise.all([undefined, 'preview_admission', 'preview_cleanup'].map(async previewRole => {
        const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Private saved workflow' });
        return createAutomation({ accountId: owner.id, input: AutomationDefinitionCreateRequestSchema.parse({
            automationId: crypto.randomUUID(), name: previewRole ?? 'Unrelated Environment job', enabled: true,
            triggers: [], assignments: [{ machineId: machine.id }], executionRecipe: { ...recipe,
                deploymentEnvironment: { serverId, projectSourceId: source.source.id, environmentId: parent.environmentId,
                    ...(previewRole ? { previewRole } : {}) } } }) });
    }));
    const [ordinary, admission, cleanup] = jobs;
    const childContent = await artifact('deployment-environment.v1');
    const childInput = { ...placement, ...childContent, purpose: 'preview' as const, requestKey: crypto.randomUUID(),
        preview: { templateEnvironmentId: parent.environmentId, expectedTemplateRevision: link.revision,
            runtimeTargetLinkId: link.targetLinkId, pullRequestId: 'opaque-pr-17' } };
    const child = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, childInput));
    if (!child.ok) throw new Error(child.error);
    const rename = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: source.source.id,
        expectedRevision: source.source.revision, patch: { name: 'Renamed only' } }));
    if (!rename.ok) throw new Error(rename.error);
    const neutral = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: source.source.id,
        expectedRevision: rename.source.revision, patch: { repository, defaultRef: 'release', subdir: 'packages/app' } }));
    if (!neutral.ok) throw new Error(neutral.error);
    expect(await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: source.source.id,
        expectedRevision: neutral.source.revision, patch: { repository } }))).toEqual(neutral);
    expect(await db.automation.findMany({ where: { id: { in: jobs.map(job => job.id) } }, select: { enabled: true } }))
        .toEqual(jobs.map(() => ({ enabled: true })));
    expect(await db.automationRun.count({ where: { automationId: { in: jobs.map(job => job.id) } } })).toBe(0);
    const replacement = { serverId, sourceId: source.source.id, expectedRevision: neutral.source.revision,
        patch: { repository: { ...repository, repository: { nameWithOwner: 'owner/replacement',
            cloneUrl: 'https://github.example/owner/replacement.git' } } } };
    const previous = await runAutomationNow({ accountId: owner.id, automationId: cleanup.id,
        idempotencyKey: `repository-replacement:${neutral.source.revision}` });
    if (!previous) throw new Error('Public cleanup invocation was not admitted');
    // A retained terminal occurrence is a database fixture, not a second Run owner.
    await db.automationRun.update({ where: { id: previous.id },
        data: { state: 'succeeded', workflowCustodyState: 'settled', finishedAt: new Date() } });
    const replaceRepository = async (tx: Parameters<typeof updateProjectSourceInTx>[0]) => {
        if (entry === 'Source CAS') return updateProjectSourceInTx(tx, owner.id, replacement);
        // A real database CAS isolates this helper without calling it twice when
        // the independently tested production Source caller is wired to retire.
        const updated = await tx.projectSource.updateMany({
            where: { id: source.source.id, revision: replacement.expectedRevision },
            data: { repository: replacement.patch.repository, revision: { increment: 1 } },
        });
        if (updated.count !== 1) return { ok: false as const, error: 'source_conflict' as const };
        await retireDeploymentPreviewsForSourceReplacementInTx(tx, {
            projectSourceId: source.source.id,
        });
        return { ok: true as const };
    };
    await expect(inTx(async tx => {
        const updated = await replaceRepository(tx);
        if (!updated.ok) throw new Error(updated.error);
        expect((await tx.automation.findUniqueOrThrow({ where: { id: admission.id } })).enabled).toBe(false);
        expect(await tx.automationRun.count({ where: { automationId: cleanup.id } })).toBe(2);
        throw new Error('rollback whole Source transaction');
    })).rejects.toThrow('rollback whole Source transaction');
    expect((await db.automation.findUniqueOrThrow({ where: { id: admission.id } })).enabled).toBe(true);
    expect(await db.automationRun.count({ where: { automationId: cleanup.id } })).toBe(1);
    const replaced = await inTx(replaceRepository);
    expect(replaced).toMatchObject({ ok: true });
    expect((await db.automation.findUniqueOrThrow({ where: { id: admission.id } })).enabled).toBe(false);
    expect((await db.automation.findUniqueOrThrow({ where: { id: ordinary.id } })).enabled).toBe(true);
    expect((await db.automation.findUniqueOrThrow({ where: { id: cleanup.id } })).enabled).toBe(true);
    const runs = await db.automationRun.findMany({ where: { automationId: cleanup.id, state: 'queued' } });
    expect(runs).toMatchObject([{ state: 'queued', workflowCustodyState: 'pending' }]);
    expect(runs[0]?.id).not.toBe(previous.id);
    expect(await db.automationRun.count({ where: { automationId: { in: [admission.id, ordinary.id] } } })).toBe(0);
    expect((await db.automation.findUniqueOrThrow({ where: { id: cleanup.id } })).templateCiphertext).toBe(cleanup.templateCiphertext);
    expect(await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, { ...childInput,
        requestKey: crypto.randomUUID(), preview: { ...childInput.preview, pullRequestId: 'opaque-pr-18' } })))
        .toMatchObject({ ok: false, error: 'deployment_conflict' });
    expect(await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, childInput)))
        .toEqual({ ...child, replayed: true });
    expect(await inTx(tx => updateProjectSourceInTx(tx, owner.id, replacement))).toMatchObject({ ok: false, error: 'source_conflict' });
    expect(await db.automationRun.count({ where: { automationId: cleanup.id } })).toBe(2);
}, 60_000);

it.each(['disabled', 'missing'] as const)('Source PATCH refuses %s cleanup with a typed conflict and rolls back every preview and Source write', async cleanupState => {
    const { owner, repository, source, machine, artifact, placement, parent, link } = await createPreviewTemplateFixture();
    const jobs = await Promise.all(['preview_admission', 'preview_cleanup'].map(async previewRole => {
        const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Private saved workflow' });
        return createAutomation({ accountId: owner.id, input: AutomationDefinitionCreateRequestSchema.parse({
            automationId: crypto.randomUUID(), name: previewRole, enabled: true, triggers: [],
            assignments: [{ machineId: machine.id }], executionRecipe: { ...recipe,
                deploymentEnvironment: { serverId, projectSourceId: source.source.id,
                    environmentId: parent.environmentId, previewRole } },
        }) });
    }));
    const [admission, cleanup] = jobs;
    const childContent = await artifact('deployment-environment.v1');
    const child = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
        ...placement, ...childContent, purpose: 'preview', requestKey: crypto.randomUUID(),
        preview: { templateEnvironmentId: parent.environmentId, expectedTemplateRevision: link.revision,
            runtimeTargetLinkId: link.targetLinkId, pullRequestId: 'opaque-pr-refusal' },
    }));
    if (!child.ok) throw new Error(child.error);
    // Construct retained disabled/missing cleanup at the persistence boundary.
    await db.automation.update({ where: { id: cleanup.id }, data: cleanupState === 'disabled'
        ? { enabled: false } : { deletedAt: new Date(), enabled: false } });
    const before = await db.projectSource.findUniqueOrThrow({ where: { id: source.source.id } });
    const beforeJobs = await db.automation.findMany({ where: { id: { in: jobs.map(job => job.id) } }, orderBy: { id: 'asc' } });
    await withAuthenticatedTestApp(projectSourceRoutes, async app => {
        const response = await app.inject({ method: 'PATCH', url: `/v1/projects/sources/${source.source.id}`,
            headers: { 'x-test-user-id': owner.id }, payload: { serverId, sourceId: source.source.id,
                expectedRevision: source.source.revision, patch: { repository: { ...repository,
                    repository: { nameWithOwner: 'owner/refused', cloneUrl: 'https://github.example/owner/refused.git' } } } } });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ ok: false, error: 'source_conflict' });
    });
    expect(await db.projectSource.findUniqueOrThrow({ where: { id: source.source.id } })).toEqual(before);
    expect(await db.automation.findMany({ where: { id: { in: jobs.map(job => job.id) } }, orderBy: { id: 'asc' } })).toEqual(beforeJobs);
    expect(await db.automationRun.count({ where: { automationId: { in: jobs.map(job => job.id) } } })).toBe(0);
    expect((await db.automation.findUniqueOrThrow({ where: { id: admission.id } })).enabled).toBe(true);
    expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: child.environmentId } })).deletedAt).toBeNull();
}, 60_000);

it('reads preview jobs and live child presence in two set queries for five locked templates', async () => {
    const { owner, source, machine, artifact, placement, parent } = await createPreviewTemplateFixture();
    const templateIds = [parent.environmentId];
    for (let index = 1; index < 5; index++) {
        const content = await artifact('deployment-environment.v1');
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            ...placement, ...content, purpose: 'standard', requestKey: crypto.randomUUID(),
        }));
        if (!environment.ok) throw new Error(environment.error);
        templateIds.push(environment.environmentId);
    }
    const jobs = [];
    for (const environmentId of templateIds) {
        const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Private saved workflow' });
        jobs.push(await createAutomation({ accountId: owner.id, input: AutomationDefinitionCreateRequestSchema.parse({
            automationId: crypto.randomUUID(), name: 'Preview admission', enabled: true, triggers: [],
            assignments: [{ machineId: machine.id }], executionRecipe: { ...recipe, deploymentEnvironment: {
                serverId, projectSourceId: source.source.id, environmentId, previewRole: 'preview_admission',
            } },
        }) }));
    }
    const reads: string[] = [];
    await inTx(tx => retireDeploymentPreviewsForSourceReplacementInTx(new Proxy(tx, { get(target, property, receiver) {
        if (property !== 'automation' && property !== 'deploymentEnvironment') return Reflect.get(target, property, receiver);
        const delegate = target[property];
        return new Proxy(delegate, { get(target, method, receiver) {
            const call = Reflect.get(target, method, receiver);
            if (method !== 'findMany' && method !== 'findFirst' && method !== 'groupBy') return call;
            return (query: { where?: Record<string, unknown> }) => {
                if (property === 'automation' && query.where?.deploymentPreviewRole !== undefined
                    || property === 'deploymentEnvironment' && query.where?.previewTemplateEnvironmentId !== undefined) {
                    reads.push(property);
                }
                return Reflect.apply(call, delegate, [query]);
            };
        } });
    } }), { projectSourceId: source.source.id }));
    expect(await db.automation.count({ where: { id: { in: jobs.map(job => job.id) }, enabled: false } })).toBe(5);
    expect(reads.sort()).toEqual(['automation', 'deploymentEnvironment']);
}, 60_000);
