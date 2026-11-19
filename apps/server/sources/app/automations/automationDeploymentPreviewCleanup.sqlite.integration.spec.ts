import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { AutomationDefinitionCreateRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { parseAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { eventRouter } from '@/app/events/eventRouter';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx, updateProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { linkDeploymentTargetInTx } from '@/app/deployments/deploymentTargetLinkService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createAutomation, updateAutomation } from './automationCrudService';
import { claimAutomationRun } from './automationClaimService';

describe('preview retirement through the ordinary Automation Run wake', () => {
    const serverId = `srv_${'e'.repeat(32)}`;
    const repository = {
        provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.example' },
        repository: { nameWithOwner: 'owner/before', cloneUrl: 'https://github.example/owner/before.git' },
        protocol: 'https',
    };
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-preview-cleanup-wake-', initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId, HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(() => { eventRouter.clearIo(); });

    it('commits only the related cleanup Workflow, publishes its incumbent queued wake, and permits the normal daemon claim', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'Preview cleanup', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), active: false } });
        const source = await inTx(tx => createProjectSourceInTx(tx, account.id, {
            serverId, requestKey: randomUUID(), name: 'Preview cleanup', repository,
        }));
        if (!source.ok) throw new Error(source.error);
        const artifact = async (kind: string, content: unknown) => {
            const stored = await createArtifact({ actorUserId: account.id, artifactId: randomUUID(),
                kind: `v1:other:${kind}`,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Preview' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!stored.ok) throw new Error(stored.error);
            return { contentArtifactId: stored.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const placement = { serverId, projectSourceId: source.source.id, controllerMachineId: machine.id,
            protection: 'nonProduction' as const, deployerMode: 'managers' as const };
        const fixtureContent = createDeploymentEnvironmentDetailV1();
        const templateContent = await artifact('deployment-environment.v1', fixtureContent.content);
        const template = await inTx(tx => createDeploymentEnvironmentInTx(tx, account.id, { ...placement,
            ...templateContent, purpose: 'standard', requestKey: randomUUID() }));
        if (!template.ok) throw new Error(template.error);
        const linkContent = await artifact('deployment-target-link.v1', fixtureContent.targetLinks[0]!.content);
        const link = await inTx(tx => linkDeploymentTargetInTx(tx, account.id, { serverId,
            environmentId: template.environmentId, expectedRevision: template.revision, requestKey: randomUUID(),
            targetId: 'own-server', role: 'runtime', machines: [{ machineId: machine.id, installationId: machine.installationId! }],
            ...linkContent }));
        if (!link.ok) throw new Error(link.error);
        const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Unrelated job' });
        const cleanupRecipeFor = (environmentId: string, templateVersion: number) => ({ ...recipe, templateVersion, workflow: { t: 'plain' as const, v: {
            workspace: { directory: '/workspace/app' }, executionTarget: { kind: 'session' },
            inlineDefinition: { version: 1, blocks: [
                // The wake/claim slice starts cleanup at its ordinary current
                // child read; native teardown/delete effects are a separate composed owner gate.
                { kind: 'action', id: 'read-child', actionId: 'deployments.environments.get',
                    input: { serverId: { kind: 'literal', value: serverId },
                        environmentId: { kind: 'literal', value: environmentId } } },
            ] },
        } } });
        const author = async (previewRole?: 'preview_admission' | 'preview_cleanup') => await createAutomation({
            accountId: account.id,
            input: AutomationDefinitionCreateRequestSchema.parse({ automationId: randomUUID(), name: previewRole ?? 'Unrelated job',
                enabled: true, triggers: [], assignments: [{ machineId: machine.id }],
                executionRecipe: { ...(previewRole === 'preview_cleanup' ? cleanupRecipeFor(template.environmentId, 1) : recipe),
                    deploymentEnvironment: { serverId, projectSourceId: source.source.id, environmentId: template.environmentId,
                        ...(previewRole ? { previewRole } : {}) } } }),
        });
        const cleanup = await author('preview_cleanup');
        const admission = await author('preview_admission');
        const unrelated = await author();
        const childContent = await artifact('deployment-environment.v1', fixtureContent.content);
        const child = await inTx(tx => createDeploymentEnvironmentInTx(tx, account.id, { ...placement,
            ...childContent, purpose: 'preview', requestKey: randomUUID(), preview: {
                templateEnvironmentId: template.environmentId, expectedTemplateRevision: link.revision,
                runtimeTargetLinkId: link.targetLinkId, pullRequestId: 'pull-request-before',
            } }));
        if (!child.ok) throw new Error(child.error);
        const savedCleanup = await updateAutomation({ accountId: account.id, automationId: cleanup.id,
            input: { executionRecipe: cleanupRecipeFor(child.environmentId, 2) } });
        const cleanupRecipe = parseAutomationStoredWorkflowDefinitionRecipeV2(savedCleanup?.templateCiphertext);
        if (cleanupRecipe.kind !== 'available') throw new Error('Expected the current saved cleanup Workflow');
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit }) } as never); // Socket transport boundary.
        const replacement = { ...repository, repository: {
            nameWithOwner: 'owner/after', cloneUrl: 'https://github.example/owner/after.git',
        } };
        const result = await inTx(async tx => {
            const updated = await updateProjectSourceInTx(tx, account.id, { serverId, sourceId: source.source.id,
                expectedRevision: source.source.revision, patch: { repository: replacement } });
            expect(emit.mock.calls.filter(call => call[0] === 'update'
                && call[1]?.body?.t === 'automation-run-updated')).toEqual([]);
            return updated;
        });
        expect(result).toMatchObject({ ok: true, source: { revision: source.source.revision + 1 } });
        const runs = await db.automationRun.findMany({ where: { automationId: { in: [cleanup.id, admission.id, unrelated.id] } } });
        expect(runs).toHaveLength(1);
        const run = runs[0]!;
        expect(run).toMatchObject({ automationId: cleanup.id, state: 'queued', workflowCustodyState: 'pending' });
        expect(JSON.parse(run.executionInputEnvelope!)).toEqual(cleanupRecipe.recipe.workflow);
        expect(emit.mock.calls).toContainEqual(['update', expect.objectContaining({ body: expect.objectContaining({
            t: 'automation-run-updated', automationId: cleanup.id, runId: run.id, state: 'queued', targetMachineId: machine.id,
        }) })]);
        const claimed = await claimAutomationRun({ accountId: account.id, machineId: machine.id, leaseDurationMs: 30_000 });
        expect(claimed).toMatchObject({ run: { id: run.id, automationId: cleanup.id, state: 'claimed', attempt: 1 } });
        expect(await db.automationRun.count({ where: { automationId: { in: [admission.id, unrelated.id] } } })).toBe(0);
    });
});
