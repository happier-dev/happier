import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { readPreviewCopyReadinessForHost } from './previewCopyReadinessForHost';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

it.each(['restored', 'rolledBack', 'review-only', 'foreign-child', 'wrong-database'] as const)(
    'requires the original native copy result before a preview app may start again: %s', async outcome => {
        const child = createDeploymentEnvironmentDetailV1();
        child.content.previewCreationRunId = 'creation-run';
        child.content.template = { templateRef: { sourceId: 'data', itemId: 'postgres', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
            definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` }, services: ['database'],
            data: [{ engine: 'postgres', service: 'database', variables: { database: 'DB_NAME' },
                logicalBackup: { adapter: 'postgres-v1', database: 'DB_NAME' } }] };
        child.content.bindings = [{ purpose: 'variable', phase: 'runtime', name: 'DB_NAME', source: { kind: 'value', value: 'app' } }];
        const index = { id: 'confirm', runId: 'creation-run', sequence: '0', parentRecordId: null, memberOrdinal: '0',
            attempt: '0', contentRevision: '0', lifecycle: 'completed', createdAt: '2026-11-10T00:00:00.000Z',
            updatedAt: '2026-11-10T00:00:01.000Z' };
        const successful = { kind: 'restored', verified: true, nextAction: 'deploy', evidence: {} };
        const page = WorkflowInvocationListResultV1Schema.parse({ invocations: [index], parentRevision: 1,
            invocationDetails: [{ index, parentRevision: 1, progress: { kind: 'happier.workflow-progress.v1', blockKind: 'action',
                invocationPath: { blockId: 'confirm', scope: [] }, logicalInvocationRecordId: index.id, attempt: '0', result: successful,
                execution: { kind: 'action', actionId: 'deployments.backups.restore', actionRequestId: 'request', localInputId: 'local',
                    input: { mode: 'confirm', serverId: child.environment.serverId,
                        environmentId: outcome === 'foreign-child' ? 'foreign' : child.environment.id,
                        targetLinkId: child.environment.runtimeTargetLinkId, expectedRevision: 1, machineId: 'machine-a',
                        installationId: 'installation-a', deploymentId: 'source-release',
                        prepareOperationId: 'prepared', source: { kind: 'repository', snapshotId: 'a'.repeat(64),
                            origin: { environmentId: 'source', targetLinkId: 'source-runtime' } },
                        destination: { kind: 'database', service: 'database', database: outcome === 'wrong-database' ? 'other' : 'app' } },
                    ...(outcome === 'review-only' ? {} : { output: outcome === 'rolledBack'
                        ? { kind: 'rolledBack', verified: false, nextAction: 'review', evidence: {} } : successful }) } } }] });
        expect(await readPreviewCopyReadinessForHost(child, async () => page)).toBe(outcome === 'restored');
    });

it.each(['missing', 'not-created', 'review-only', 'main-incomplete', 'legacy-managed', 'restored', 'foreign-parent', 'wrong-runtime', 'wrong-database',
    'empty', 'empty-app-failed', 'empty-app-active', 'empty-wrong-target', 'empty-unconnected', 'connection-missing', 'connection-failed',
    'connection-review-only', 'connection-foreign-child', 'connection-wrong-set'] as const)(
    'keeps a required companion copy incomplete until its immutable creation and restore settle: %s', async outcome => {
        const main = createDeploymentEnvironmentDetailV1();
        main.content.previewCreationRunId = 'creation-run';
        main.environment.purpose = 'preview';
        Object.assign(main.environment, { previewTemplateEnvironmentId: 'template', previewRepositoryId: main.environment.projectSourceId,
            previewPullRequestId: '17', previewTargetLinkId: 'template-runtime' });
        const original = createDeploymentEnvironmentDetailV1();
        const companion = { ...original, environment: { ...original.environment, id: 'companion', runtimeTargetLinkId: 'companion-runtime',
            purpose: 'standard' as const, previewCompanionOfEnvironmentId: main.environment.id } };
        const preview = { templateEnvironmentId: 'template', expectedTemplateRevision: 1, pullRequestId: '17', runtimeTargetLinkId: 'template-runtime' };
        const createInput = (companionOf?: string) => ({ serverId: main.environment.serverId, requestKey: companionOf ? 'companion' : 'main',
            contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
            projectSourceId: main.environment.projectSourceId, protection: 'nonProduction', purpose: companionOf ? 'standard' : 'preview',
            deployerMode: 'managers', controllerMachineId: 'machine-a', preview,
            ...(companionOf ? { previewCompanionOfEnvironmentId: companionOf } : {}) });
        const previewNativeBindings = [{ purpose: 'variable', phase: 'runtime', name: 'DB_HOST',
            source: { kind: 'reference', environmentId: companion.environment.id, export: 'database', via: 'auto', component: 'host' } },
            { purpose: 'variable', phase: 'runtime', name: 'DB_PORT', source: { kind: 'reference',
                environmentId: companion.environment.id, export: 'database', via: 'auto', component: 'port' } }];
        const createResult = { ok: true, environmentId: companion.environment.id, revision: 1,
            runtimeTargetLinkId: companion.environment.runtimeTargetLinkId, previewNativeData: [{ service: 'database', database: 'app' }],
            previewNativeBindings };
        const invocation = (id: string, actionId: string, input: unknown, output?: unknown, reviewed?: unknown) => {
            const index = { id, runId: 'creation-run', sequence: id === 'main-create' ? '0' : '1', parentRecordId: null,
                memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'completed',
                createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:01.000Z' };
            return { index, parentRevision: 1, progress: { kind: 'happier.workflow-progress.v1', blockKind: 'action',
                invocationPath: { blockId: id, scope: [] }, logicalInvocationRecordId: id, attempt: '0',
                ...(reviewed ? { result: normalizeStrictJsonValue(reviewed) } : {}),
                execution: { kind: 'action', actionId, actionRequestId: id, localInputId: id, input: normalizeStrictJsonValue(input),
                    ...(output ? { output: normalizeStrictJsonValue(output) } : {}) } } };
        };
        const mainCreate = invocation('main-create', 'deployments.environments.create', createInput(),
            outcome === 'main-incomplete' || outcome === 'legacy-managed' ? undefined
                : { ok: true, environmentId: main.environment.id, revision: 1, previewCompanionRequired: true });
        if (outcome === 'main-incomplete') mainCreate.index.lifecycle = 'failed';
        const companionCreate = invocation('companion-create', 'deployments.environments.create',
            createInput(outcome === 'foreign-parent' ? 'other-main' : main.environment.id),
            outcome === 'not-created' || outcome === 'review-only' ? undefined : createResult,
            outcome === 'review-only' ? createResult : undefined);
        const restored = { kind: 'restored', verified: true, nextAction: 'deploy', evidence: {} };
        const restore = invocation('restore', 'deployments.backups.restore', { mode: 'confirm', serverId: main.environment.serverId,
            environmentId: companion.environment.id,
            targetLinkId: outcome === 'wrong-runtime' ? 'other-runtime' : companion.environment.runtimeTargetLinkId,
            expectedRevision: 1, machineId: 'machine-a', installationId: 'installation-a', deploymentId: 'source-release',
            prepareOperationId: 'prepared', source: { kind: 'repository', snapshotId: 'a'.repeat(64),
                origin: { environmentId: 'source', targetLinkId: 'source-runtime' } },
            destination: { kind: 'database', service: 'database', database: outcome === 'wrong-database' ? 'other' : 'app' } }, restored);
        const connected = { ok: true, environmentId: main.environment.id, revision: 4 };
        const connect = invocation('ordinary-bindings-write', 'deployments.bindings.set', {
            serverId: main.environment.serverId, environmentId: outcome === 'connection-foreign-child' ? 'other-main' : main.environment.id,
            expectedRevision: 3, set: outcome === 'connection-wrong-set' ? previewNativeBindings.slice(0, 1) : [...previewNativeBindings].reverse(), remove: [],
        }, outcome === 'connection-review-only' ? undefined : connected,
        outcome === 'connection-review-only' ? connected : undefined);
        if (outcome === 'connection-failed') connect.index.lifecycle = 'failed';
        const appDeploy = invocation('preview-deploy', 'deployments.deploy', { serverId: main.environment.serverId,
            environmentId: main.environment.id, targetLinkId: outcome === 'empty-wrong-target' ? 'other-target' : main.environment.runtimeTargetLinkId,
            requestKey: 'preview-request-deploy', sha: 'c'.repeat(40) }, outcome === 'empty-app-failed' ? undefined : { ok: true, state: 'succeeded',
            environmentId: main.environment.id, revision: 5, deploymentId: 'app-deployment', deploymentRevision: 1 });
        if (outcome === 'empty-app-failed') appDeploy.index.lifecycle = 'failed';
        if (outcome === 'empty-app-active') appDeploy.index.lifecycle = 'running';
        const empty = outcome.startsWith('empty');
        const companionRows = outcome === 'legacy-managed' ? [] : [companionCreate, empty ? appDeploy : restore,
            ...(outcome === 'connection-missing' || outcome === 'empty-unconnected' ? [] : [connect])];
        const pages = [WorkflowInvocationListResultV1Schema.parse({ invocations: [mainCreate.index], invocationDetails: [mainCreate],
            parentRevision: 1, nextCursor: 'companion-page' }), WorkflowInvocationListResultV1Schema.parse({
            invocations: companionRows.map(row => row.index), invocationDetails: companionRows, parentRevision: 1 })];
        const readInvocations = async ({ cursor }: { cursor?: string }) => pages[cursor ? 1 : 0]!;
        expect(await readPreviewCopyReadinessForHost(main, readInvocations,
            outcome === 'missing' || outcome === 'legacy-managed' ? null : companion))
            .toBe(outcome === 'restored' || outcome === 'legacy-managed' || outcome === 'empty' || outcome === 'empty-app-failed');
    });
