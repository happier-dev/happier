import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import fastify from 'fastify';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { WorkflowTriggerAddRequestV1Schema, WorkflowTriggerUpdateRequestV1Schema,
    WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { PLUGIN_MANIFEST } from '../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { createPreviewEnrollmentForHost } from './previewEnrollment';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DeploymentEnvironmentUpdateStorageInputV1Schema } from '@happier-dev/deployment-protocol';

afterEach(() => { vi.restoreAllMocks(); });

async function fixture(setupRefused = false) {
    const manifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
    const loaded: LoadedPlugin = { pluginId: manifest.id, manifest,
        pluginRootPath: '/plugins/github', manifestPath: '/plugins/github/plugin.json',
        daemonEntryPath: '/plugins/github/daemon.js', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: manifest.id, trustPolicy: 'local_trusted', installPolicy: 'copy' } };
    const projected = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'external' });
    const contributes = createResolvedContributionRegistry({ ...projected,
        occurrenceIdsByPluginId: { [manifest.id]: createPluginRuntimeOccurrenceId(manifest.id) } });
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.controllerMachineId = 'controller';
    environment.content.previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
        repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
        runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] };
    const app = fastify();
    const saved: ReturnType<typeof WorkflowTriggerSetV1Schema.parse>[] = [];
    const calls: { actionId: string; input: unknown }[] = [];
    const responses: string[] = [];
    // Remote Action HTTP is the boundary; real declarations, input schemas and reviewed-child admission remain active.
    app.post<{ Body: { actionId: string; input: unknown } }>('/child', request => {
        const { actionId, input } = request.body;
        calls.push({ actionId, input });
        if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: saved } };
        if (actionId === 'action.invoke') return setupRefused
            ? { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' }
            : { ok: true, result: { v: 1, sourceInstanceId: 'github:repository:42', sourceContractVersion: 1,
                sourceConfig: { v: 1, credentialRef: { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'account' },
                    repository: { v: 1, repositoryId: '42', owner: 'owner', name: 'app', nameWithOwner: 'owner/app' } }, displayLabel: 'owner/app' } };
        if (actionId === 'workflow.trigger.add') {
            const authored = WorkflowTriggerAddRequestV1Schema.parse(input);
            if (!('project' in authored) || !authored.project || authored.trigger.kind !== 'pluginEvent') throw new Error('Expected executable Event');
            saved.push(WorkflowTriggerSetV1Schema.parse({ automationId: '11111111-1111-4111-8111-111111111111',
                revision: 1, enabled: true, health: 'available', project: authored.project, target: authored.target,
                context: { workspace: { directory: authored.project.directory }, executionTarget: authored.executionTarget,
                    deploymentPreview: authored.deploymentPreview }, triggers: [{ kind: 'pluginEvent', id: 'preview', revision: 0,
                    enabled: true, createdAt: 1, updatedAt: 1, eventRef: authored.trigger.eventRef,
                    sourceSelectorId: '22222222-2222-4222-8222-222222222222', sourceContractVersion: 1,
                    observation: { kind: 'checkpointedPull', watcher: { pluginId: manifest.id, machineId: 'controller', materializationId: 'installed',
                        machineInstallationId: 'installation' } }, sourceStatus: null, sourceCatalogStatus: null,
                    triggerDefinitionEnvelope: '{}' }] }));
            return { ok: true, result: { set: saved[0], triggerId: 'preview' } };
        }
        const update = WorkflowTriggerUpdateRequestV1Schema.parse(input);
        const current = saved.find(set => set.automationId === update.automationId);
        if (!current || current.revision !== update.expectedRevision) throw new Error('Expected exact current trigger');
        current.revision++;
        if (update.patch.enabled !== undefined) current.enabled = update.patch.enabled;
        return { ok: true, result: { set: current, triggerId: 'preview' } };
    });
    const enrollment = createPreviewEnrollmentForHost({ serverId: 'home', machineId: 'controller',
        readEnvironment: async () => environment,
        acquirePluginRuntimeRegistryLease: async () => ({ registry: { contributes },
            resolveCurrentPluginMaterializationRef: () => ({ pluginId: manifest.id, machineId: 'controller', materializationId: 'installed' }),
            release: async () => {} }) });
    async function save(enabled: boolean | null) {
        const input = { environmentId: environment.environment.id,
            patch: { previewTemplate: enabled === null ? null : { ...environment.content.previewTemplate!, enabled } } };
        const plan = await enrollment.prepare(input, {});
        if (!plan || 'ok' in plan) throw new Error('Expected reviewed child declarations');
        if (enabled === null) delete environment.content.previewTemplate;
        else environment.content.previewTemplate = input.patch.previewTemplate ?? undefined;
        const preparedContext = await plan.prepareExecutionContext({});
        const context = { ...preparedContext, hostReviewedChild: createHostReviewedChildPortV1({ actionId: 'deployments.environments.update',
            input, context: {}, plan, async execute(input, _context, actionId) {
                const response = await app.inject({ method: 'POST', url: '/child', payload: { actionId, input } });
                responses.push(response.body);
                return ActionExecuteResultSchema.parse(response.json());
            } }) };
        // Storage receives only its public patch after private Artifact preparation.
        return DeploymentActionOutputSchemasV1['deployments.environments.update'].parse(await enrollment.completeUpdate(
            { ok: true, environmentId: environment.environment.id, revision: 2 }, { ...input, patch: {} }, context));
    }
    return { app, calls, responses, saved, environment, enrollment, save };
}

it('enrolls from the saved template, reuses its exact trigger, and retains PR-close cleanup when disabled', async () => {
    const f = await fixture();
    try {
        const first = await f.save(true);
        expect(first, JSON.stringify({ first, responses: f.responses })).toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        expect(await f.save(true)).toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        expect(f.calls.filter(call => call.actionId === 'workflow.trigger.add')).toHaveLength(1);
        expect(f.saved).toHaveLength(1);
        expect(f.saved[0]?.context).toMatchObject({ deploymentPreview: { serverId: 'home', environmentId: f.environment.environment.id } });
        const setup = f.calls.find(call => call.actionId === 'action.invoke');
        expect(setup?.input).toMatchObject({ input: { repository: 'owner/app' } });
        expect(JSON.stringify(setup?.input)).not.toContain('credentialRef');
        f.saved.push(WorkflowTriggerSetV1Schema.parse({ ...f.saved[0], automationId: '33333333-3333-4333-8333-333333333333',
            context: { ...f.saved[0]?.context, deploymentPreview: { serverId: 'home', environmentId: 'other-environment' } } }));
        expect(await f.save(false)).toMatchObject({ ok: true, previewEnrollment: { status: 'disabled' } });
        expect(f.saved[0]?.enabled).toBe(true);
        expect(f.saved[1]?.enabled).toBe(true);
    } finally { await f.app.close(); }
});

it('reaches enrollment from the public Environment update after private patch preparation', async () => {
    const { credentials, rows, writes } = createPlainAccountArtifactHttpBoundary();
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.controllerMachineId = 'controller';
    const content = environment.content;
    rows.set(environment.environment.contentArtifactId, { id: environment.environment.contentArtifactId, ownerAccountId: 'owner',
        access: 'owner', publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: content.name }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1 });
    const artifactGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
            data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
        return artifactGet(url);
    });
    const stored: ReturnType<typeof DeploymentEnvironmentUpdateStorageInputV1Schema.parse>[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.method?.toUpperCase() === 'GET') return { status: 200, data: { ok: true,
            environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
        stored.push(DeploymentEnvironmentUpdateStorageInputV1Schema.parse(request.data));
        return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: 2 } };
    });
    const identity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
        resolveHostIdentity: async () => ({ machineId: 'controller', installationId: 'installation', custodianAccountId: 'owner' }) });
    const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://preview.test',
        machineId: 'controller', resolveRequesterIdentity: async context => {
            const requester = await identity.resolveActionRequester!(context);
            try { return requester.identity; } finally { await requester.dispose(); }
        }, runtime: { async acquire() { throw new Error('An Environment edit does not acquire a deployment'); } } });
    const actionId = 'deployments.environments.update';
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
    const result = await executor.execute(actionId, { serverId: 'home', environmentId: environment.environment.id,
        expectedRevision: environment.environment.revision, contentArtifactId: environment.environment.contentArtifactId,
        contentHeaderVersion: 1, contentBodyVersion: 1, patch: { previewTemplate: { v: 1, enabled: true, forkPreviews: 'off',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
            runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] } } }, {
        authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' }, interactivePresentation: 'unavailable',
        signal: new AbortController().signal, verifyMachineAdmissionCurrent: async () => true,
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'controller', installationId: 'installation',
            role: 'manage', encryptionMode: 'plain' },
        actionsSettings: setActionApprovalOverride({ settings: normalizeActionsSettingsV1(undefined), actionId,
            surface: 'ui', approvalRequired: false }),
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, previewEnrollment: { status: 'unavailable' } } });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.patch).toEqual({});
});

it('keeps the persisted save successful and visibly reports setup credential refusal', async () => {
    const f = await fixture(true);
    try {
        expect(await f.save(true)).toMatchObject({ ok: true, previewEnrollment: { status: 'unavailable', errorCode: 'credential_scope_denied' } });
        expect(f.saved).toHaveLength(0);
    } finally { await f.app.close(); }
});
