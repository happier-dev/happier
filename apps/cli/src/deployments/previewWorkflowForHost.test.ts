import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DeploymentTargetLinkProviderContentV1Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentTargetLinkActionInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { AutomationStoredWorkflowDefinitionV2Schema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { WorkflowDefinitionV1Schema, type WorkflowActionFieldBindingV1, type WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows';
import { preparePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
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
import { preparePreviewDomainForHost } from './previewDomainForHost';
import { DeploymentDomainContentV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { DeploymentBackupRestoreInputV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { createRegistryHostV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { preparePreviewNativeDataPlacementsForHost } from './templates/previewCreate';
import { prepareDeploymentTemplateInstantiationV1 } from '@happier-dev/deployments';
import { buildCatalogAppTemplateBindings } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { parseNativeComposeSource } from '@/workspaces/projectSetup/nativeComposeSource';

afterEach(() => vi.restoreAllMocks());

async function nativeCatalogFixture() {
    const home = await createSavedSecretsCliHttpFixture();
    const credentials = await home.deps.readCredentialsFn?.();
    if (!credentials) throw new Error('Missing credentials');
    const catalog: unknown = JSON.parse(await readFile(new URL('../../../../packages/plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
    const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
        url: 'https://preview-apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
    const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
        getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
        getText: async () => { throw new Error('Unexpected catalog text'); }, getBytes: async () => { throw new Error('Unexpected catalog bytes'); },
    } });
    const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
        sourceId: source.id, kind: 'app', itemId: 'postgresql' })).item;
    if (selected.payload.kind !== 'app') throw new Error('Expected PostgreSQL catalog item');
    const templateRef = { sourceId: source.id, itemId: 'postgresql', version: selected.summary.version!, ref: selected.payload.ref };
    const { origin: _origin, removable: _removable, ...sourceRow } = source;
    const originalGet = axios.get.bind(axios);
    // Home metadata and catalog HTTP are boundaries; pinned-template admission remains real.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(catalog));
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account-cli-fixture' } };
        if (url.endsWith('/v1/account/entity-rows/prompt-library')) return { status: 200,
            data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
                key, revision: 1, content: key === 'registry-sources'
                    ? { t: 'plain', v: { key, value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null,
            })) }) };
        return originalGet(url, config);
    });
    const destinationBackup = { prefix: 'previews', configuration: { configRevision: 1,
        destinationRef: { pluginId: 'example.storage', localId: 'local' }, occurrenceId: 'selected', config: { path: '/backups' },
        credentialBindings: [], sources: [{ kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' }],
        retention: { kind: 'keepEverything' } }, bindings: [] };
    return { home, templateRef, app: selected.payload.app, destinationBackup, placements: (selections: Parameters<typeof preparePreviewNativeDataPlacementsForHost>[0]['selections'],
        existingTemplate: Parameters<typeof preparePreviewNativeDataPlacementsForHost>[0]['existingTemplate']) => home.inHome(() =>
        preparePreviewNativeDataPlacementsForHost({ selections, existingTemplate, context: {} }, { credentials, serverHttpBaseUrl: home.origin })) };
}

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
        providerEnvironment: { kind: 'native', selection: { branchId: 'parent-1' } },
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
    it('refuses a provider Domain awaiting an assigned hostname as a preview route', () => {
        const domain = DeploymentDomainContentV1Schema.parse({ hostname: null, target: { kind: 'provider' } });

        expect(() => preparePreviewDomainForHost({ domain, pullRequestNumber: 12,
            selection: { domainId: 'template-domain', templateSlug: 'app', hostnamePattern: 'pr-{number}-{template-slug}' },
        })).toThrow(expect.objectContaining({ errorCode: 'target_mismatch' }));
    });
    it.each([undefined, 7])('activates the planned preview Domain after Deploy using the selected fresh runtime Link (retained revision: %s)', async domainRevision => {
        const current = fixture(neon);
        current.detail.content = DeploymentEnvironmentContentV1Schema.parse({ ...current.detail.content,
            previewTemplate: { ...current.detail.content.previewTemplate!, data: [],
                domain: { domainId: 'template-domain', templateSlug: 'app', hostnamePattern: 'pr-{number}-{template-slug}' } } });
        const planned = { content: { hostname: 'pr-12-app.preview.test', target: { service: 'app', containerPort: 8080 } },
            url: 'https://pr-12-app.preview.test/' };
        // Template Domain transport is the boundary; Workflow composition and bindings remain real.
        const domainBoundary = { readPreviewDomain: async () => planned };
        const workflow = await resolvePreviewWorkflowForHost({ ...current.input, ...domainBoundary,
            ...(domainRevision === undefined ? {} : { readExistingPreview: async () => ({
                environment: createDeploymentEnvironmentHeaderV1({ id: 'child', runtimeTargetLinkId: 'runtime' }), domainRevision,
            }) }),
        });
        expect(workflow.kind).toBe('available');
        if (workflow.kind !== 'available') throw new Error(workflow.reason);
        const domain = workflow.definition.blocks.find(block => block.id === 'preview-domain-links');
        expect(domain?.kind).toBe('loop');
        if (domain?.kind !== 'loop') throw new Error('Missing selected Domain continuation');
        expect(workflow.definition.blocks.findIndex(block => block.id === 'preview-deploy'))
            .toBeLessThan(workflow.definition.blocks.findIndex(block => block.id === 'preview-domain-current'));
        const add = domain.body.find(block => block.kind === 'action' && block.actionId === 'deployments.domains.add');
        if (add?.kind !== 'action') throw new Error('Missing ordinary Domain add');
        const resolved = Object.fromEntries(await Promise.all(Object.entries(add.input).map(async ([key, binding]) => [key,
            await resolveWorkflowActionFieldBinding(binding, { inputs: {},
                item: { value: { id: 'runtime', revision: 19 }, index: 1, position: 2, count: 2 },
                resolveResult: async () => ({ environment: { id: 'child', revision: 23, runtimeTargetLinkId: 'runtime' } }),
                resolveWorkspace: async () => { throw new Error('Unexpected workspace'); } })])));
        expect(resolved).toMatchObject({ environmentId: 'child', targetLinkId: 'runtime', expectedRevision: 23,
            expectedTargetLinkRevision: 19, content: planned.content,
            ...(domainRevision === undefined ? {} : { expectedDomainRevision: domainRevision }) });
    });
    it('copies into a catalog companion when the repository does not declare PostgreSQL', async () => {
        const catalog = await nativeCatalogFixture();
        try {
            const current = fixture(neon);
            const runtime = createDeploymentTargetLinkHeaderV1({ id: current.detail.environment.runtimeTargetLinkId,
                environmentId: current.detail.environment.id, role: 'runtime', targetKind: 'ownServer',
                source: { kind: 'host', id: 'own-server' }, machines: ['machine-a'],
                members: [{ machineId: 'machine-a', installationId: 'installation-a', state: 'active' }] });
            current.detail.targetLinks.push(runtime);
            current.detail.content = DeploymentEnvironmentContentV1Schema.parse({ ...current.detail.content,
                previewTemplate: { ...current.detail.content.previewTemplate!, data: [{ kind: 'template',
                    templateRef: catalog.templateRef, dataExportNames: ['DATABASE_URL'], connectTo: { service: 'app' },
                    destinationBackup: catalog.destinationBackup,
                    copyFrom: { environmentId: 'source', targetLinkId: 'source-runtime', deploymentId: 'source-release', snapshotId: 'c'.repeat(64) } }] } });
            const workflow = await resolvePreviewWorkflowForHost({ ...current.input,
                readNativeDataPlacements: ({ selections, existingTemplate }) => catalog.placements(selections, existingTemplate) });
            expect(workflow.kind).toBe('available');
            if (workflow.kind !== 'available') throw new Error(workflow.reason);
            const actions = workflow.definition.blocks.filter((block): block is WorkflowActionLeafV1 => block.kind === 'action');
            const action = (id: string) => {
                const found = actions.find(block => block.id === id);
                expect(found, `Expected ${id}`).toBeDefined();
                if (!found) throw new Error(`Missing ${id}`);
                return found;
            };
            const results = { 'preview-create': { environmentId: 'main-child', runtimeTargetLinkId: 'app-runtime', revision: 2 },
                'preview-data-create': { environmentId: 'companion', runtimeTargetLinkId: 'data-runtime', revision: 2,
                    previewNativeData: [{ service: 'database', database: 'app' }], previewNativeBindings: [] },
                'preview-data-current': { environment: { revision: 3 } }, 'preview-data-connect-current': { environment: { revision: 2 } } };
            const companion = DeploymentEnvironmentCreateIntentInputV1Schema.parse(await bindings(action('preview-data-create').input, results));
            expect(companion).toMatchObject({ purpose: 'standard', protection: 'nonProduction', previewCompanionOfEnvironmentId: 'main-child',
                preview: { templateEnvironmentId: current.detail.environment.id, pullRequestId: event.id, headSha: event.headSha } });
            expect(await bindings(action('preview-data-companion-provision').input, results))
                .toMatchObject({ environmentId: 'companion', targetLinkId: 'data-runtime', services: ['database'] });
            expect(await bindings(action('preview-data-companion-provision').input, results)).not.toHaveProperty('sha');
            expect(DeploymentBackupRestoreInputV1Schema.parse(await bindings(action('preview-copy-0-prepare').input, results)))
                .toMatchObject({ environmentId: 'companion', targetLinkId: 'data-runtime', destination: { service: 'database', database: 'app' } });
            expect(await bindings(action('preview-data-connect').input, results))
                .toMatchObject({ environmentId: 'main-child', expectedRevision: 2, set: [], remove: [] });
            expect(await bindings(action('preview-deploy').input, results))
                .toMatchObject({ environmentId: 'main-child', targetLinkId: 'app-runtime', sha: event.headSha });
        } finally { await catalog.home.close(); }
    });
    it.each([false, true])('copies the child database before deploying the app (managed selection: %s)', async managed => {
        const catalog = await nativeCatalogFixture();
        try {
            const current = fixture(neon);
            const runtime = createDeploymentTargetLinkHeaderV1({ id: current.detail.environment.runtimeTargetLinkId,
                environmentId: current.detail.environment.id, role: 'runtime', targetKind: 'ownServer',
                source: { kind: 'host', id: 'own-server' }, machines: ['machine-a'],
                members: [{ machineId: 'machine-a', installationId: 'installation-a', state: 'active' }] });
            current.detail.targetLinks.push(runtime);
            const copyFrom = { environmentId: 'source-database', targetLinkId: 'source-runtime', deploymentId: 'source-release',
                backupOperationId: 'source-backup', snapshotId: 'c'.repeat(64) };
            const selection = { kind: 'template', templateRef: catalog.templateRef, dataExportNames: ['DATABASE_URL'], copyFrom,
                destinationBackup: catalog.destinationBackup };
            const prepared = prepareDeploymentTemplateInstantiationV1({ template: catalog.app, templateRef: catalog.templateRef,
                source: await parseNativeComposeSource(catalog.app.compose.document), bindings: buildCatalogAppTemplateBindings(catalog.app).bindings });
            current.detail.content = DeploymentEnvironmentContentV1Schema.parse({ ...current.detail.content,
                template: { ...prepared.template, definition: current.detail.content.definition },
                previewTemplate: { ...current.detail.content.previewTemplate!, data: [selection,
                    ...(managed ? current.detail.content.previewTemplate!.data : [])] } });
            const source = { ...current.detail, environment: { ...current.detail.environment, id: copyFrom.environmentId },
                targetLinks: [{ ...runtime, id: copyFrom.targetLinkId, environmentId: copyFrom.environmentId }] };
            const workflow = await resolvePreviewWorkflowForHost({ ...current.input,
                readNativeDataPlacements: ({ selections, existingTemplate }) => catalog.placements(selections, existingTemplate),
                readEnvironment: async reference => reference.environmentId === copyFrom.environmentId ? source : current.detail });
            expect(workflow.kind).toBe('available');
            if (workflow.kind !== 'available') throw new Error(workflow.reason);
            const actions = workflow.definition.blocks.filter((block): block is WorkflowActionLeafV1 => block.kind === 'action');
            if (!managed) expect(actions.map(action => action.actionId)).toEqual(['deployments.environments.create', 'deployments.deploy',
                'deployments.environments.get', 'deployments.backups.restore', 'deployments.backups.restore', 'deployments.deploy']);
            const results = { 'preview-create': { environmentId: 'child', runtimeTargetLinkId: 'child-runtime', revision: 5,
                previewNativeData: [{ service: 'database', database: 'app' }],
                previewDataTargets: [{ targetLinkId: 'child-managed-data', targetLinkRevision: 1 }] },
                'preview-data-current': { environment: { revision: 6 } }, 'preview-copy-0-prepare': { operationId: 'prepared-copy' } };
            const action = (id: string) => actions.find(block => block.id === id)!;
            if (managed) expect(await bindings(action('preview-data-1').input, results))
                .toMatchObject({ environmentId: 'child', targetLinkId: 'child-managed-data', expectedTargetLinkRevision: 1 });
            expect(await bindings(action('preview-data-provision').input, results))
                .toMatchObject({ environmentId: 'child', services: ['database'], sha: event.headSha });
            const prepare = DeploymentBackupRestoreInputV1Schema.parse(await bindings(action('preview-copy-0-prepare').input, results));
            expect(prepare).toMatchObject({ mode: 'prepare', environmentId: 'child', targetLinkId: 'child-runtime', expectedRevision: 6,
                machineId: 'machine-a', installationId: 'installation-a', deploymentId: copyFrom.deploymentId,
                source: { kind: 'repository', backupOperationId: copyFrom.backupOperationId, snapshotId: copyFrom.snapshotId,
                    origin: { environmentId: copyFrom.environmentId, targetLinkId: copyFrom.targetLinkId } },
                destination: { kind: 'database', service: 'database', database: 'app' } });
            expect(DeploymentBackupRestoreInputV1Schema.parse(await bindings(action('preview-copy-0-confirm').input, results)))
                .toEqual({ ...prepare, mode: 'confirm', prepareOperationId: 'prepared-copy' });
            expect(await bindings(action('preview-deploy').input, results)).not.toHaveProperty('services');
        } finally { await catalog.home.close(); }
    });
    it.each(['opened', 'synchronize'] as const)('deploys the current child on %s without re-creating its data', async action => {
        const current = fixture(neon);
        const child = createDeploymentEnvironmentHeaderV1({ id: 'existing-child', runtimeTargetLinkId: 'existing-runtime', purpose: 'preview',
            previewTemplateEnvironmentId: current.detail.environment.id, previewRepositoryId: 'repository-1',
            previewPullRequestId: event.id, previewTargetLinkId: current.detail.content.previewTemplate!.runtimeTargetLinkId });
        current.input.readTargetLink = async () => { throw new Error('Existing PR data must be reused'); };
        const result = await resolvePreviewWorkflowForHost({ ...current.input, event: { ...event, action }, readExistingPreview: async () => ({ environment: child }) });
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
        const managed = current.detail.content.previewTemplate!.data.find(selection => selection.kind === 'managed');
        if (!managed || managed.kind !== 'managed') throw new Error('Expected saved managed parent');
        Object.assign(managed.parentBranchRef, { displayName: 'Production database' });
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
            providerEnvironment: { kind: 'native', selection: { branchId: 'branch-new' } } };
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

    it.each([false, true])('routes an opted-in fork exact head through Create before any data effects (existing: %s)', async existing => {
        const current = fixture(neon);
        current.detail.content.previewTemplate!.forkPreviews = 'approveEachCommit';
        current.input.readTargetLink = async () => { throw new Error('Forks never acquire template data'); };
        const fork = { ...event, headRepository: { ...repository, repository: 'contributor/widgets' } };
        const workflow = await resolvePreviewWorkflowForHost({ ...current.input, event: fork,
            ...(existing ? { readExistingPreview: async () => ({ environment: createDeploymentEnvironmentHeaderV1({
                id: 'existing-preview', purpose: 'preview', runtimeTargetLinkId: 'existing-runtime',
            }) }) } : {}) });
        expect(workflow.kind).toBe('available');
        if (workflow.kind !== 'available') throw new Error(workflow.reason);
        expect(workflow.definition.blocks).toHaveLength(1);
        const root = workflow.definition.blocks[0];
        if (root?.kind !== 'action') throw new Error('Expected the fork Create approval root');
        expect(root.actionId).toBe('deployments.environments.create');
        expect(await bindings(root.input)).toMatchObject({ protection: 'nonProduction', purpose: 'preview',
            preview: { headSha: fork.headSha, provenance: { headRepository: fork.headRepository } } });
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
