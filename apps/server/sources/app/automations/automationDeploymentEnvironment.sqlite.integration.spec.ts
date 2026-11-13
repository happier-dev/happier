import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, sealAutomationTriggerDefinitionStoredEnvelopeV1, AutomationTriggerIdSchema, AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol';
import { AutomationDefinitionCreateRequestSchema, AutomationDefinitionReconcileRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { createDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { setDeploymentEnvironmentControllerInTx } from '@/app/deployments/deploymentControllerService';
import { createAutomation, createAutomationTrigger, deleteAutomation, getAutomation, updateAutomation, reconcileAutomationDefinition, runAutomationNow } from '@/app/automations/automationCrudService';
import { AutomationValidationError } from '@/app/automations/automationValidation';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAutomationV3Routes } from '@/app/api/routes/automations/registerAutomationV3Routes';
import { removeAutomationMachineAssignmentsTx } from '@/app/automations/automationMachineAssignmentRemoval';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createDeploymentEnvironmentV1 } from '@happier-dev/deployment-protocol/testing/v1';

const publishedMachine = { metadata: encodePlainMachineStoredContent({ host: 'Controller', platform: 'linux',
    happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
    dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) };
const environmentContent = createDeploymentEnvironmentV1().content;
if (environmentContent.t !== 'plain') throw new Error('Expected plain Environment fixture');
const environmentArtifactBody = privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(environmentContent.v) }));

describe('Environment-owned Automation controller assignment', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-controller-automations-', initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('round-trips owner-qualified preview roles and keeps saved role and Environment immutable', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Preview template', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            ...publishedMachine, installationId: crypto.randomUUID(), active: false } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Preview' })),
            body: environmentArtifactBody,
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id,
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        }));
        if (!environment.ok) throw new Error(environment.error);
        const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Preview' });
        const ordinary = await createAutomation({ accountId: owner.id, input: AutomationDefinitionCreateRequestSchema.parse({
            automationId: crypto.randomUUID(), name: 'Unrelated Workflow', enabled: true, triggers: [],
            assignments: [{ machineId: machine.id }], executionRecipe: { ...recipe, deploymentEnvironment: {
                serverId, projectSourceId: source.source.id, environmentId: environment.environmentId,
            } },
        }) });
        await expect(updateAutomation({ accountId: owner.id, automationId: ordinary.id, input: {
            executionRecipe: { ...recipe, templateVersion: 2, deploymentEnvironment: {
                serverId, projectSourceId: source.source.id, environmentId: environment.environmentId, previewRole: 'preview_admission',
            } },
        } })).rejects.toBeInstanceOf(AutomationValidationError);
        await withAuthenticatedTestApp(registerAutomationV3Routes, async app => {
            for (const previewRole of ['preview_admission', 'preview_cleanup'] as const) {
                const reference = { serverId, projectSourceId: source.source.id, environmentId: environment.environmentId, previewRole };
                const payload = { automationId: crypto.randomUUID(), name: previewRole, enabled: true, triggers: [],
                    assignments: [{ machineId: machine.id }], executionRecipe: { ...recipe, deploymentEnvironment: reference } };
                const created = await app.inject({ method: 'POST', url: '/v3/automations',
                    headers: { 'x-test-user-id': owner.id }, payload });
                expect(created.statusCode, created.body).toBe(200);
                expect(created.json()).toMatchObject({ deploymentEnvironment: reference });
                const retained = await getAutomation({ accountId: owner.id, automationId: payload.automationId });
                expect(retained).toMatchObject({ deploymentEnvironmentId: environment.environmentId, deploymentPreviewRole: previewRole });
                const read = await app.inject({ method: 'GET', url: `/v3/automations/${payload.automationId}`,
                    headers: { 'x-test-user-id': owner.id } });
                expect(read.statusCode, read.body).toBe(200);
                expect(read.json()).toMatchObject({ deploymentEnvironment: reference });
                await expect(updateAutomation({ accountId: owner.id, automationId: payload.automationId, input: {
                    executionRecipe: { ...recipe, templateVersion: 2, deploymentEnvironment: { ...reference,
                        previewRole: previewRole === 'preview_admission' ? 'preview_cleanup' : 'preview_admission' } },
                } })).rejects.toBeInstanceOf(AutomationValidationError);
                const updated = await updateAutomation({ accountId: owner.id, automationId: payload.automationId,
                    input: { executionRecipe: { ...recipe, templateVersion: 2 } } });
                expect(updated).toMatchObject({ templateVersion: 1, deploymentEnvironmentId: environment.environmentId, deploymentPreviewRole: previewRole });
                const omittedRole = await app.inject({ method: 'PATCH', url: `/v3/automations/${payload.automationId}`,
                    headers: { 'x-test-user-id': owner.id }, payload: { expectedTemplateVersion: 1, executionRecipe: { ...recipe, templateVersion: 2,
                        deploymentEnvironment: { serverId, projectSourceId: source.source.id, environmentId: environment.environmentId } } } });
                expect(omittedRole.statusCode, omittedRole.body).toBe(200);
                expect(omittedRole.json()).toMatchObject({ templateVersion: 1, deploymentEnvironment: reference });
                const removedRole = await app.inject({ method: 'PATCH', url: `/v3/automations/${payload.automationId}`,
                    headers: { 'x-test-user-id': owner.id }, payload: { expectedTemplateVersion: 1, executionRecipe: { ...recipe, templateVersion: 2,
                        deploymentEnvironment: { ...reference, previewRole: null } } } });
                expect(removedRole.statusCode).toBe(400);
                const forbidden = await app.inject({ method: 'POST', url: '/v3/automations',
                    headers: { 'x-test-user-id': stranger.id }, payload: { ...payload, automationId: crypto.randomUUID() } });
                expect(forbidden.statusCode).toBe(400);
                expect(await updateAutomation({ accountId: stranger.id, automationId: payload.automationId,
                    input: { executionRecipe: { ...recipe, templateVersion: 3, deploymentEnvironment: reference } } })).toBeNull();
                const foreignSource = await app.inject({ method: 'POST', url: '/v3/automations',
                    headers: { 'x-test-user-id': owner.id }, payload: { ...payload, automationId: crypto.randomUUID(),
                        executionRecipe: { ...recipe, deploymentEnvironment: { ...reference, projectSourceId: crypto.randomUUID() } } } });
                expect(foreignSource.statusCode).toBe(400);
            }
        });
    });

    it.each(['plain', 'e2ee'] as const)('reads a %s observation-only health definition without resolving its private Domain subject', async encryptionMode => {
        const owner = await db.account.create({ data: { encryptionMode,
            ...(encryptionMode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const stranger = await db.account.create({ data: { encryptionMode,
            ...(encryptionMode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: crypto.randomUUID() } });
        const observation = await createAutomation({ accountId: owner.id, input: {
            automationId: crypto.randomUUID(), name: 'Saved Domain health', enabled: true, triggers: [], assignments: [],
            observationOnly: { kind: 'observationOnly', templateVersion: 1 },
        } });
        const triggerId = AutomationTriggerIdSchema.parse(crypto.randomUUID());
        const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(crypto.randomUUID());
        const eventRef = { pluginId: 'happier.machine.services', localId: 'health-status' };
        const sealed = sealAutomationTriggerDefinitionStoredEnvelopeV1({
            ...(encryptionMode === 'plain' ? { mode: 'plain' as const } : { mode: 'e2ee' as const,
                material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
                randomBytes: length => new Uint8Array(length).fill(9) }),
            binding: { v: 1, automationId: observation.id, triggerId, triggerRevision: 0,
                triggerKind: 'pluginEvent', eventRef, sourceSelectorId },
            definition: { v: 1, sourceInstanceId: 'health:saved-domain', displayLabel: null, filter: null,
                maximumObservationAgeMs: null, sourceConfig: { v: 1,
                    subject: { kind: 'environment', environmentId: 'unresolved-environment' },
                    checks: [{ checkId: 'domain-http', kind: { pluginId: eventRef.pluginId, localId: 'http' },
                        binding: { kind: 'domain', domainId: 'unresolved-domain', targetLinkId: 'unresolved-target',
                            condition: 'domain_probe_failed' }, config: {}, periodMs: 60_000,
                        consecutiveFailuresBeforeAlerting: 1 }] } },
        });
        // Seed the persisted transport boundary: public reads cannot open E2EE source content or resolve its Domain.
        await db.automationTrigger.create({ data: { id: triggerId, automationId: observation.id,
            kind: 'pluginEvent', enabled: true, revision: 0, eventPluginId: eventRef.pluginId,
            eventLocalId: eventRef.localId, sourceSelectorId, sourceContractVersion: 1,
            observationTransport: 'checkpointedPull', watcherMachineId: machine.id,
            watcherMachineInstallationId: machine.installationId, watcherPluginId: eventRef.pluginId,
            watcherMaterializationId: 'daemon-selected:happier.machine.services', definitionEnvelope: JSON.stringify(sealed) } });
        await withAuthenticatedTestApp(registerAutomationV3Routes, async app => {
            for (const request of [
                { method: 'GET' as const, url: '/v3/automations' },
                { method: 'POST' as const, url: '/v3/automations/query', payload: { details: true } },
            ]) {
                const response = await app.inject({ ...request, headers: { 'x-test-user-id': owner.id } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json().automations).toEqual(expect.arrayContaining([
                    expect.objectContaining({ id: observation.id, observationOnly: { kind: 'observationOnly', templateVersion: 1 } }),
                ]));
            }
            const detail = await app.inject({ method: 'GET', url: `/v3/automations/${observation.id}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(detail.statusCode, detail.body).toBe(200);
            expect(detail.json()).toMatchObject({ id: observation.id,
                triggers: [{ id: triggerId, triggerDefinitionEnvelope: JSON.stringify(sealed) }] });
            const foreign = await app.inject({ method: 'GET', url: `/v3/automations/${observation.id}`,
                headers: { 'x-test-user-id': stranger.id } });
            expect(foreign.statusCode).toBe(404);
        });
    });

    it('refuses generic moves and provenance removal, but changes only linked definitions through controller.set', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Environment controller jobs', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const [first, next] = await Promise.all([0, 1].map(() => db.machine.create({ data: { id: crypto.randomUUID(),
            accountId: owner.id, ...publishedMachine, installationId: crypto.randomUUID(), active: false } })));
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Controller' })),
            body: environmentArtifactBody,
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', controllerMachineId: first.id,
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        }));
        if (!environment.ok) throw new Error(environment.error);
        const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Deploy' });
        const observation = await createAutomation({ accountId: owner.id, input: {
            automationId: crypto.randomUUID(), name: 'Production source', enabled: false, triggers: [], assignments: [],
            observationOnly: { kind: 'observationOnly', templateVersion: 1, deploymentEnvironment: {
                serverId, projectSourceId: source.source.id, environmentId: environment.environmentId,
            } },
        } });
        expect(observation).toMatchObject({ deploymentEnvironmentId: environment.environmentId, assignments: [] });
        await withAuthenticatedTestApp(registerAutomationV3Routes, async app => {
            for (const request of [
                { method: 'GET' as const, url: '/v3/automations' },
                { method: 'POST' as const, url: '/v3/automations/query', payload: { details: true } },
            ]) {
                const listed = await app.inject({ ...request, headers: { 'x-test-user-id': owner.id } });
                expect(listed.statusCode, listed.body).toBe(200);
                expect(listed.json().automations).toEqual(expect.arrayContaining([
                    expect.objectContaining({ id: observation.id, observationOnly: expect.objectContaining({ kind: 'observationOnly' }) }),
                ]));
            }
        });
        const createInput = AutomationDefinitionCreateRequestSchema.parse({ automationId: crypto.randomUUID(),
            name: 'Environment deployment', enabled: true, triggers: [], assignments: [{ machineId: first.id }],
            executionRecipe: { ...recipe, deploymentEnvironment: { serverId, projectSourceId: source.source.id,
                environmentId: environment.environmentId } } });
        await withAuthenticatedTestApp(registerAutomationV3Routes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v3/automations',
                headers: { 'x-test-user-id': owner.id }, payload: createInput });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ id: createInput.automationId,
                deploymentEnvironment: { serverId, projectSourceId: source.source.id, environmentId: environment.environmentId } });
        });
        const linked = await getAutomation({ accountId: owner.id, automationId: createInput.automationId });
        if (!linked) throw new Error('Expected the HTTP-created Environment Automation');
        const ordinary = await createAutomation({ accountId: owner.id, input: AutomationDefinitionCreateRequestSchema.parse({
            automationId: crypto.randomUUID(), name: 'Independent job', enabled: true, triggers: [],
            assignments: [{ machineId: first.id }], executionRecipe: recipe,
        }) });
        const before = await getAutomation({ accountId: owner.id, automationId: linked.id });
        expect(before?.assignments.map(row => row.machineId)).toEqual([first.id]);
        const running = await runAutomationNow({ accountId: owner.id, automationId: linked.id,
            recipeFeaturePolicy: { workflowsEnabled: true } });
        if (!running) throw new Error('Expected admitted Workflow Run');
        const frozen = await db.automationRun.findUniqueOrThrow({ where: { id: running.id } });
        const frozenAssignments = await db.automationRunAssignment.findMany({ where: { runId: running.id } });
        await expect(updateAutomation({ accountId: owner.id, automationId: linked.id,
            input: { assignments: [{ machineId: next.id }] } })).rejects.toBeInstanceOf(AutomationValidationError);
        const reconcile = AutomationDefinitionReconcileRequestSchema.parse({ expectedTemplateVersion: linked.templateVersion,
            name: linked.name, description: null, enabled: true, triggers: [], removedTriggers: [],
            assignments: [{ machineId: next.id }],
        });
        await expect(reconcileAutomationDefinition({ accountId: owner.id, automationId: linked.id, input: reconcile }))
            .rejects.toBeInstanceOf(AutomationValidationError);
        await expect(updateAutomation({ accountId: owner.id, automationId: linked.id, input: {
            observationOnly: { kind: 'observationOnly', templateVersion: linked.templateVersion + 1 },
            assignments: [], enabled: false,
        } })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(updateAutomation({ accountId: owner.id, automationId: linked.id, input: {
            executionRecipe: { ...recipe, templateVersion: linked.templateVersion + 1,
                deploymentEnvironment: { serverId, projectSourceId: source.source.id, environmentId: crypto.randomUUID() } },
        } })).rejects.toBeInstanceOf(AutomationValidationError);
        const edited = await updateAutomation({ accountId: owner.id, automationId: linked.id, input: {
            executionRecipe: { ...recipe, templateVersion: linked.templateVersion + 1 },
        } });
        expect(edited?.deploymentEnvironmentId).toBe(environment.environmentId);
        const moved = await inTx(tx => setDeploymentEnvironmentControllerInTx(tx, owner.id, { serverId,
            environmentId: environment.environmentId, expectedRevision: environment.revision, controllerMachineId: next.id }));
        expect(moved).toEqual({ ok: true, environmentId: environment.environmentId, revision: environment.revision + 1 });
        expect((await getAutomation({ accountId: owner.id, automationId: linked.id }))?.assignments.map(row => row.machineId)).toEqual([next.id]);
        expect(await getAutomation({ accountId: owner.id, automationId: observation.id }))
            .toMatchObject({ deploymentEnvironmentId: environment.environmentId, assignments: [] });
        expect((await getAutomation({ accountId: owner.id, automationId: ordinary.id }))?.assignments.map(row => row.machineId)).toEqual([first.id]);
        let writes = 0;
        const stop = observeSqliteRequests({ before: request => {
            if (['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'].includes(request.action)) writes++;
        } });
        try {
            expect(await inTx(tx => setDeploymentEnvironmentControllerInTx(tx, owner.id, { serverId,
                environmentId: environment.environmentId, expectedRevision: environment.revision + 1, controllerMachineId: next.id })))
                .toEqual(moved);
            expect(writes, 'equal controller input must not republish linked Automation assignments').toBe(0);
        } finally { stop(); }
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: running.id } })).toEqual(frozen);
        expect(await db.automationRunAssignment.findMany({ where: { runId: running.id } })).toEqual(frozenAssignments);
        const nextRun = await runAutomationNow({ accountId: owner.id, automationId: linked.id,
            recipeFeaturePolicy: { workflowsEnabled: true } });
        if (!nextRun) throw new Error('Expected future Workflow Run');
        expect((await db.automationRunAssignment.findMany({ where: { runId: nextRun.id } })).map(row => row.machineId)).toEqual([next.id]);
        expect((await updateAutomation({ accountId: owner.id, automationId: ordinary.id,
            input: { assignments: [{ machineId: next.id }] } }))?.assignments.map(row => row.machineId)).toEqual([next.id]);
    });

    it.each([
        'view-only displaced controller',
        'revoked displaced controller',
        'view-only new controller',
        'displaced controller retained as builder',
    ] as const)('authorizes only resulting controller placement: %s', async scenario => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Controller replacement' } });
        await db.teamMembership.createMany({ data: [creator, manager].map(account => ({ accountId: account.id,
            teamId: team.id, role: 'owner' as const })) });
        const source = await inTx(tx => createProjectSourceInTx(tx, creator.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Controller replacement', audience: [], owner: { kind: 'team', teamId: team.id } }));
        if (!source.ok) throw new Error(source.error);
        const [previous, next] = await Promise.all([0, 1].map(() => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: creator.id, ...publishedMachine, installationId: crypto.randomUUID(), active: false,
        } })));
        if (!previous || !next) throw new Error('Expected controller placement Machines');
        await db.machineGrant.createMany({ data: [
            { principalKind: 'team', machineId: previous.id, teamId: team.id, createdByAccountId: creator.id,
                accessLevel: scenario === 'view-only new controller' ? 'admin' : 'view' },
            { principalKind: 'team', machineId: next.id, teamId: team.id, createdByAccountId: creator.id,
                accessLevel: scenario === 'view-only new controller' ? 'view' : 'admin' },
        ] });
        const artifact = await createArtifact({ actorUserId: creator.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Controller replacement' })),
            body: environmentArtifactBody, dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        await db.artifactGrant.create({ data: { principalKind: 'team' as const, artifactId: artifact.artifact.id, teamId: team.id,
            accessLevel: 'admin', createdByAccountId: creator.id } });
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, creator.id, { serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'production', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: previous.id,
            ...(scenario === 'displaced controller retained as builder' ? { buildMachineId: previous.id } : {}),
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 }));
        if (!environment.ok) throw new Error(environment.error);
        const authentication = { authenticationAuthority: 'present_user' as const };
        const automation = await createAutomation({ accountId: creator.id, authentication,
            input: AutomationDefinitionCreateRequestSchema.parse({ automationId: crypto.randomUUID(), name: 'Controller replacement',
                enabled: true, triggers: [], assignments: [{ machineId: previous.id }],
                executionRecipe: { ...createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Deploy' }),
                    deploymentEnvironment: { serverId, projectSourceId: source.source.id, environmentId: environment.environmentId } } }) });
        const revoked = scenario === 'revoked displaced controller';
        if (revoked) {
            await inTx(tx => removeAutomationMachineAssignmentsTx({ tx, accountId: creator.id, machineId: previous.id,
                markMachineUnavailableTx: async client => { await client.machine.update({ where: { id: previous.id }, data: { revokedAt: new Date() } }); } }));
            expect(await getAutomation({ accountId: creator.id, automationId: automation.id })).toMatchObject({ enabled: false });
        }
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: creator.id } });
        const moved = await inTx(tx => setDeploymentEnvironmentControllerInTx(tx, manager.id, { serverId,
            environmentId: environment.environmentId, expectedRevision: environment.revision, controllerMachineId: next.id }, authentication));
        const denied = scenario === 'view-only new controller' || scenario === 'displaced controller retained as builder';
        expect(moved).toMatchObject(denied ? { ok: false, error: 'deployment_access_denied' }
            : { ok: true, revision: environment.revision + 1 });
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.environmentId } })).toMatchObject({
            controllerMachineId: denied ? previous.id : next.id, revision: environment.revision + (denied ? 0 : 1),
        });
        const retained = await getAutomation({ accountId: creator.id, automationId: automation.id });
        expect(retained).toMatchObject({ accountId: creator.id, enabled: !revoked });
        expect(retained?.assignments.map(assignment => assignment.machineId)).toEqual([denied ? previous.id : next.id]);
    });

    it('uses current Source manager authority without changing the Automation Account when its creator leaves', async () => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Environment jobs' } });
        await db.teamMembership.createMany({ data: [creator, manager].map(account => ({ accountId: account.id,
            teamId: team.id, role: 'owner' as const })) });
        const source = await inTx(tx => createProjectSourceInTx(tx, creator.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Team deployment jobs', audience: [], owner: { kind: 'team', teamId: team.id } }));
        if (!source.ok) throw new Error(source.error);
        const [first, next] = await Promise.all([creator, manager].map(account => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: account.id, ...publishedMachine, installationId: crypto.randomUUID(), active: false,
        } })));
        await db.machineGrant.createMany({ data: [first, next].map(machine => ({ principalKind: 'team', machineId: machine.id,
            teamId: team.id, accessLevel: 'view' as const, createdByAccountId: machine.accountId })) });
        const artifact = await createArtifact({ actorUserId: creator.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Team controller' })),
            body: environmentArtifactBody,
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        await db.artifactGrant.create({ data: { principalKind: 'team' as const, artifactId: artifact.artifact.id, teamId: team.id,
            accessLevel: 'admin', createdByAccountId: creator.id } });
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, creator.id, { serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'production', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: first.id, contentArtifactId: artifact.artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1 }));
        if (!environment.ok) throw new Error(environment.error);
        const input = AutomationDefinitionCreateRequestSchema.parse({ automationId: crypto.randomUUID(), name: 'Team deployment',
            enabled: true, triggers: [], assignments: [{ machineId: first.id }],
            executionRecipe: { ...createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Deploy' }),
                deploymentEnvironment: { serverId, projectSourceId: source.source.id, environmentId: environment.environmentId } } });
        const authentication = { authenticationAuthority: 'present_user' as const };
        const automation = await createAutomation({ accountId: creator.id, authentication, input });
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: creator.id } });
        await expect(createAutomation({ accountId: creator.id, authentication, input })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(updateAutomation({ accountId: creator.id, authentication, automationId: automation.id,
            input: { name: 'Creator cannot keep authoring' } })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(runAutomationNow({ accountId: creator.id, automationId: automation.id,
            recipeFeaturePolicy: { workflowsEnabled: true } })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(createAutomationTrigger({ accountId: creator.id, authentication, automationId: automation.id,
            triggerId: crypto.randomUUID(), trigger: { kind: 'schedule', enabled: true,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } } }))
            .rejects.toBeInstanceOf(AutomationValidationError);
        const moved = await inTx(tx => setDeploymentEnvironmentControllerInTx(tx, manager.id, { serverId,
            environmentId: environment.environmentId, expectedRevision: environment.revision, controllerMachineId: next.id }, authentication));
        expect(moved).toMatchObject({ ok: true, revision: environment.revision + 1 });
        const retained = await getAutomation({ accountId: creator.id, automationId: automation.id });
        expect(retained).toMatchObject({ accountId: creator.id, deploymentEnvironmentId: environment.environmentId });
        expect(retained?.assignments.map(assignment => assignment.machineId)).toEqual([next.id]);
        await inTx(tx => removeAutomationMachineAssignmentsTx({ tx, accountId: manager.id, machineId: next.id,
            markMachineUnavailableTx: async client => { await client.machine.update({ where: { id: next.id }, data: { revokedAt: new Date() } }); } }));
        const paused = await getAutomation({ accountId: creator.id, automationId: automation.id });
        expect(paused).toMatchObject({ accountId: creator.id, enabled: false });
        expect(paused?.assignments.map(assignment => assignment.machineId)).toEqual([next.id]);
        const replacement = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: manager.id,
            ...publishedMachine, installationId: crypto.randomUUID(), active: false } });
        await db.machineGrant.create({ data: { principalKind: 'team', machineId: replacement.id, teamId: team.id,
            accessLevel: 'view', createdByAccountId: manager.id } });
        expect(await inTx(tx => setDeploymentEnvironmentControllerInTx(tx, manager.id, { serverId,
            environmentId: environment.environmentId, expectedRevision: environment.revision + 1,
            controllerMachineId: replacement.id }, authentication))).toMatchObject({ ok: true, revision: environment.revision + 2 });
        const repaired = await getAutomation({ accountId: creator.id, automationId: automation.id });
        expect(repaired?.enabled, 'choosing a valid controller must not silently re-enable a paused job').toBe(false);
        expect(repaired?.assignments.map(assignment => assignment.machineId)).toEqual([replacement.id]);
        await expect(deleteAutomation({ accountId: creator.id, authentication, automationId: automation.id }))
            .resolves.toMatchObject({ removedRevision: expect.any(Number) });
        await expect(getAutomation({ accountId: creator.id, automationId: automation.id })).resolves.toBeNull();
    });
});
