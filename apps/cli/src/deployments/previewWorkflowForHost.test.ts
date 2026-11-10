import { describe, expect, it } from 'vitest';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import { DeploymentTargetLinkProviderContentV1Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentTargetLinkActionInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { AutomationStoredWorkflowDefinitionV2Schema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { WorkflowDefinitionV1Schema, type WorkflowActionFieldBindingV1, type WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows';
import { preparePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { PLUGIN_MANIFEST as neon } from '../../../../packages/plugins/deployment-neon/src/manifest';
import { PLUGIN_MANIFEST as supabase } from '../../../../packages/plugins/deployment-supabase/src/manifest';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { resolveWorkflowActionFieldBinding } from '@/daemon/workflows/input';
import { readDeploymentTargetV1 } from './targets/deploymentTargetCatalog';
import { resolvePreviewWorkflowForHost, type PreviewLifecycleEventForHost } from './previewWorkflowForHost';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
const event: PreviewLifecycleEventForHost = { id: '77', number: 12, action: 'opened', headSha: 'b'.repeat(40), headRef: 'feature/preview', baseRef: 'main',
    baseRepository: repository, headRepository: repository, author: { id: '19', login: 'alice', kind: 'human' } };

function fixture(manifest: typeof neon | typeof supabase) {
    const parsed = normalizePluginManifestV2(manifest);
    const loaded: LoadedPlugin = { pluginId: parsed.id, pluginRootPath: '/plugins/data', manifestPath: '/plugins/data/plugin.json',
        daemonEntryPath: '/plugins/data/daemon.js', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: parsed.id, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest: parsed };
    const projected = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'external' });
    const registry = createResolvedContributionRegistry({ ...projected, occurrenceIdsByPluginId: { [parsed.id]: createPluginRuntimeOccurrenceId(parsed.id) } });
    const environment = createDeploymentEnvironmentHeaderV1();
    const header = createDeploymentTargetLinkHeaderV1({ id: 'template-database', role: 'data',
        source: { kind: 'plugin', contribution: { pluginId: parsed.id, localId: 'database' } },
        targetKind: parsed.contributes.deploymentTargets![0]!.targetKind, machines: [], members: [] });
    const provider = DeploymentTargetLinkProviderContentV1Schema.parse({
        credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: parsed.id, localId: 'database' }, purpose: 'deploy-manage' },
            target: { kind: 'account', account: { service: { pluginId: parsed.id, localId: parsed.id === neon.id ? 'neon' : 'supabase' }, accountId: 'selected-account' } } },
        providerIdentity: { providerAccountId: 'org-1', providerResourceId: 'project-1', providerEnvironment: 'parent-1' },
        providerEnvironment: { kind: 'custom', id: 'parent-1' },
        repositoryAccess: { status: 'ready', repository }, preparedNative: { projectName: 'widgets' },
    });
    const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Staging', bindings: [], retainPreviousDeployments: 1,
        definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [], primaryService: 'app' } },
        previewTemplate: { v: 1, enabled: true, forkPreviews: 'off', repository, runtimeTargetLinkId: environment.runtimeTargetLinkId,
            domain: null, bindingBlueprints: [], data: [{ kind: 'managed', ownership: manifest.id === neon.id ? 'happierManaged' : 'providerNative', dataTargetLinkId: header.id,
                parentBranchRef: { providerProjectId: 'project-1', branchId: 'saved-parent-branch-uuid' } }] } });
    const saved = AutomationStoredWorkflowDefinitionV2Schema.parse({ workspace: { directory: '/workspace/widgets' }, executionTarget: { kind: 'session' },
        deploymentPreview: { serverId: environment.serverId, environmentId: environment.id } });
    const detail = { environment, content, targetLinks: [header] };
    let reads = 0;
    return { detail, provider, parsed, registry, input: { templateRef: saved.deploymentPreview!, event, occurrenceKey: 'delivery-1',
        readEnvironment: async () => { reads++; return detail; }, readTargetLink: async () => ({ header, provider }),
        readTargetDeclaration: async (source: Parameters<typeof readDeploymentTargetV1>[0]) => readDeploymentTargetV1(source, registry.deploymentTargets) },
        reads: () => reads };
}

async function bindings(input: Readonly<Record<string, WorkflowActionFieldBindingV1>>, results: Readonly<Record<string, unknown>> = {}) {
    const resolve = (reference: WorkflowActionFieldBindingV1) => resolveWorkflowActionFieldBinding(reference, {
        inputs: {}, resolveResult: async producer => StrictJsonValueSchema.parse(results[producer.blockId]),
        resolveWorkspace: async () => { throw new Error('Unexpected workspace'); },
    });
    return Object.fromEntries(await Promise.all(Object.entries(input).map(async ([name, value]) => [name, await resolve(value)])));
}

describe('saved deployment preview Workflow composition', () => {
    it.each(['opened', 'synchronize'] as const)('deploys the current child on %s without re-creating its data', async action => {
        const current = fixture(neon);
        const child = createDeploymentEnvironmentHeaderV1({ id: 'existing-child', runtimeTargetLinkId: 'existing-runtime', purpose: 'preview',
            previewTemplateEnvironmentId: current.detail.environment.id, previewRepositoryId: 'repository-1',
            previewPullRequestId: event.id, previewTargetLinkId: current.detail.content.previewTemplate!.runtimeTargetLinkId });
        current.input.readTargetLink = async () => { throw new Error('Existing PR data must be reused'); };
        const result = await resolvePreviewWorkflowForHost({ ...current.input, event: { ...event, action }, readExistingPreview: async () => child });
        expect(result.kind).toBe('available');
        if (result.kind !== 'available') throw new Error(result.reason);
        expect(result.definition.blocks).toHaveLength(1);
        const deploy = result.definition.blocks[0];
        if (deploy?.kind !== 'action') throw new Error('Expected the ordinary Deploy Action');
        expect(deploy.actionId).toBe('deployments.deploy');
        expect(await bindings(deploy.input)).toMatchObject({ environmentId: 'existing-child', targetLinkId: 'existing-runtime', sha: event.headSha });
    });

    it('creates a fresh request identity when a deleted PR child reopens at the same head', async () => {
        const current = fixture(neon);
        current.detail.content.previewTemplate!.data = [];
        const opened = await resolvePreviewWorkflowForHost(current.input);
        const reopened = await resolvePreviewWorkflowForHost({ ...current.input, occurrenceKey: 'delivery-reopened', event: { ...event, action: 'reopened' } });
        if (opened.kind !== 'available' || reopened.kind !== 'available') throw new Error('Expected preview creation');
        const first = opened.definition.blocks[0];
        const next = reopened.definition.blocks[0];
        if (first?.kind !== 'action' || next?.kind !== 'action') throw new Error('Expected create Actions');
        expect((await bindings(first.input)).requestKey).not.toBe((await bindings(next.input)).requestKey);
    });
    it.each([neon, supabase])('composes real $id branch declarations from saved template.data and exact occurrence', async manifest => {
        const current = fixture(manifest);
        const result = await resolvePreviewWorkflowForHost(current.input);
        expect(result.kind).toBe('available');
        if (result.kind !== 'available') throw new Error(result.reason);
        const definition = WorkflowDefinitionV1Schema.parse(result.definition);
        const actions = definition.blocks.filter((block): block is WorkflowActionLeafV1 => block.kind === 'action');
        expect(current.reads()).toBe(1);
        const create = DeploymentEnvironmentCreateIntentInputV1Schema.parse(await bindings(actions[0]!.input));
        expect(create).toMatchObject({ purpose: 'preview', protection: 'nonProduction', preview: { headSha: event.headSha,
            pullRequestId: event.id, provenance: { pullRequestNumber: 12, author: { id: '19', login: 'alice' } } } });
        expect(create).not.toHaveProperty('definition');
        const child = { environmentId: 'child', revision: 2, runtimeTargetLinkId: 'child-runtime', previewDataTargets: [
            { templateDataTargetLinkId: 'template-database', targetLinkId: 'child-database', targetLinkRevision: 1 }] };
        const branch = await bindings(actions[1]!.input, { 'preview-create': child });
        const declaration = current.parsed.contributes.actions!.find(action => actions[1]!.actionId.endsWith(`/actions/${action.id}`));
        expect(declaration).toBeDefined();
        expect(preparePluginJsonSchema(declaration!.inputSchema!).validate(branch)).toBe(true);
        expect(branch).toMatchObject({ environmentId: 'child', targetLinkId: 'child-database', expectedRevision: 2, expectedTargetLinkRevision: 1, name: 'pr-12' });
        expect(branch).toHaveProperty('parentBranchRef', { providerProjectId: 'project-1', branchId: 'saved-parent-branch-uuid' });
        expect(branch).toMatchObject(manifest.id === neon.id ? { initialization: 'parent-schema', correlation: { repository, pullRequestId: '77' } }
            : { gitBranch: 'feature/preview', withData: false });
        const createdProvider = { ...current.provider, providerIdentity: { ...current.provider.providerIdentity, providerEnvironment: 'branch-new' },
            providerEnvironment: { kind: 'custom', id: 'branch-new' } };
        const link = DeploymentTargetLinkActionInputV1Schema.parse(await bindings(actions[2]!.input, { 'preview-create': child,
            'preview-data-0': { providerIdentity: createdProvider.providerIdentity, providerEnvironment: createdProvider.providerEnvironment } }));
        expect(link).toMatchObject({ environmentId: 'child', replacesLinkId: 'child-database', provider: createdProvider });
        current.detail.content.previewTemplate!.data = [];
        const noData = await resolvePreviewWorkflowForHost(current.input);
        expect(noData.kind === 'available' && noData.definition.blocks.some(block => block.kind === 'action' && block.actionId === actions[1]!.actionId)).toBe(false);
    });

    it('refuses fork occurrences through canonical preview admission before data reads', async () => {
        const current = fixture(neon);
        current.input.readTargetLink = async () => { throw new Error('Data must not be read'); };
        const result = await resolvePreviewWorkflowForHost({ ...current.input, event: { ...event,
            headRepository: { ...repository, repository: 'someone/widgets' } } });
        expect(result).toEqual({ kind: 'refused', reason: 'deployment_access_denied' });
    });

    it.each(['closed', 'merged'] as const)('uses the authenticated cleanup reader for %s even after disabling template enrollment', async action => {
        const current = fixture(neon);
        current.detail.content.previewTemplate!.enabled = false;
        const cleanup = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ id: 'cleanup', kind: 'action', actionId: 'deployments.environments.delete', input: {} }] });
        const result = await resolvePreviewWorkflowForHost({ ...current.input, event: { ...event, action }, readCloseDefinition: async () => cleanup });
        expect(result).toEqual({ kind: 'available', definition: cleanup });
        expect(current.reads()).toBe(0);
    });
});
