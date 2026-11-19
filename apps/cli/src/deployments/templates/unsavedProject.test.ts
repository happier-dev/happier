import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPrepareDeploymentBindingsForHost } from '../secrets/prepareDeploymentBindingsForHost';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, DeploymentTemplateInstantiateInputV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema,
    DeploymentPublishPrepareInputV1Schema } from '@happier-dev/protocol';
import { createRegistryHostV1, DeploymentTemplateV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
    type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { readDeploymentCreationDefaultInputsForHost } from '../readCreationDefaultsForHost';
import { createDeploymentTemplateInstantiationForHost } from './instantiate';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentEnvironmentCreateInputV1Schema } from '@happier-dev/protocol';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

afterEach(() => vi.restoreAllMocks());

it.each([
    { kind: 'account', linked: true }, { kind: 'team', linked: true },
    { kind: 'account', linked: false }, { kind: 'team', linked: false },
] as const)('creates an unsaved $kind Project from catalog intent with linked=$linked without early writes', async ({ kind, linked }) => {
    const identity = await readOrCreateInstallationIdentity();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const scopeKey = runWithServerHttpBaseUrl('https://home.test', () => resolveAccountSettingsScopeKey(credentials));
    const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://home.test',
        snapshot: { source: 'network', settings: accountSettingsParse({ deploymentDefaultsV1: { retainPreviousDeployments: 7 } }),
            settingsVersion: 1, loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
    const descriptor = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
        document: 'services:\n  web:\n    image: nginx:1\n    environment:\n      APP_MODE: ${APP_MODE}\n', profiles: [], services: ['web'] },
        variables: [{ key: 'APP_MODE', label: 'Mode', required: true, valueKind: 'string', secret: false, default: 'production',
            sites: [{ service: 'web', path: ['environment', 'APP_MODE'] }] }], generatedSecrets: [], domains: [], volumes: [], firstRunSetup: true });
    const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
        url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
    const catalog = { schemaVersion: 1, apps: [{ itemId: 'app', app: descriptor }] };
    const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
        getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
        getText: async () => { throw new Error('No text fetch'); }, getBytes: async () => { throw new Error('No binary fetch'); },
    } });
    const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
        sourceId: source.id, kind: 'app', itemId: 'app' })).item;
    if (selected.payload.kind !== 'app') throw new Error('Expected App');
    const { origin: _origin, removable: _removable, ...sourceRow } = source;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(catalog));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (url.endsWith('/v1/account/entity-rows/prompt-library')) return { status: 200,
            data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
                key, revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key,
                    value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null,
            })) }) };
        throw new Error('No other Account read');
    });
    const sourceTransport = vi.spyOn(axios, 'request').mockImplementation(async () => { throw new Error('No unsaved Source exists'); });
    let contentWrites = 0;
    let installationReads = 0;
    const templates = createDeploymentTemplateInstantiationForHost({ credentials, serverId: 'home', machineId: 'target',
        readInstallation: async () => { installationReads++; return identity.installationId; },
        serverHttpBaseUrl: 'https://home.test', savedSecretOperationContext: operation, assertCurrent: async () => {},
        headers: async () => ({ Authorization: `Bearer ${token}` }),
        // These are the actual server storage/Artifact transport boundaries. Preview must issue neither.
        storage: async () => { throw new Error('Preview cannot write an Environment'); },
        createContent: async () => { contentWrites++; throw new Error('Preview cannot write content'); },
        readEnvironment: async () => { throw new Error('No Environment exists'); },
        readCreationDefaultInputs: request => readDeploymentCreationDefaultInputsForHost(request, {
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', accountId: 'owner', expectedScopeKey: scopeKey,
            assertCurrent: async () => {}, headers: async () => ({ Authorization: `Bearer ${token}` }),
            open: async () => { throw new Error('No Project defaults Artifact'); },
            readAccountSnapshot: kind === 'account' ? operation.readSnapshot : () => { throw new Error('Team cannot read personal defaults'); },
        }),
    });
    const newProject = { name: 'New app', requestKey: 'new-project', owner: kind === 'account'
        ? { kind: 'account' as const, accountId: 'owner' } : { kind: 'team' as const, teamId: 'team' } };
    const templateRef = { sourceId: source.id, itemId: 'app', version: selected.summary.version!, ref: selected.payload.ref };
    const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'preview', serverId: 'home', machineId: 'target', newProject, templateRef,
        environment: { kind: 'create', name: 'App', requestKey: 'new-environment', protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: 'target' }, target: { kind: 'new', installationId: identity.installationId },
        destination: { kind: 'stored' }, bindings: [] });
    expect(await templates.instantiate(input, { runtimeAccountId: 'owner' })).toMatchObject({ kind: 'preview', review: {
        firstRunSetup: true, creationDefaults: { values: { retainPreviousDeployments: kind === 'account' ? 7 : 1 } },
    } });
    const prepared = await templates.preparePublishEntry(DeploymentPublishPrepareInputV1Schema.parse({ serverId: 'home', machineId: 'target',
        installationId: identity.installationId, newProject, templateRef }), { runtimeAccountId: 'owner' });
    expect(prepared).toMatchObject({ kind: 'prepared', project: { newProject, owner: newProject.owner }, templateRef,
        creationDefaults: { values: { retainPreviousDeployments: kind === 'account' ? 7 : 1 } } });
    expect(prepared).not.toHaveProperty('creationDefaultsBasis');
    const create = await templates.prepareCreate(DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId: 'home', mode: 'preview',
        requestKey: 'ordinary-create', name: 'App', newProject, definition: { from: 'catalogApp', templateRef },
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
        firstTargetLink: { machines: [{ machineId: 'target', installationId: identity.installationId }] } }), { runtimeAccountId: 'owner' });
    expect(create).toMatchObject({ input: { newProject, mode: 'apply', controllerMachineId: 'target', buildMachineId: 'target',
        retainPreviousDeployments: kind === 'account' ? 7 : 1 }, preview: {
        creationDefaults: { values: { retainPreviousDeployments: kind === 'account' ? 7 : 1 },
            sources: { retainPreviousDeployments: kind === 'account' ? 'account' : 'builtin' } }, template: { templateRef, firstRunSetup: true },
    } });
    expect(sourceTransport).not.toHaveBeenCalled();
    expect(contentWrites).toBe(0);
    if (!linked) {
        const readsBefore = installationReads;
        const unlinkedIntent = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId: 'home', mode: 'preview',
            requestKey: 'unlinked', name: 'App', newProject, definition: { from: 'catalogApp', templateRef },
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'target' });
        expect(await templates.prepareCreate(unlinkedIntent, { runtimeAccountId: 'owner' })).toMatchObject({
            input: { controllerMachineId: 'target' }, preview: { creationDefaults: { values: { controllerMachineId: 'target' } } } });
        expect(installationReads).toBe(readsBefore);
        expect(await templates.prepareCreate({ ...unlinkedIntent, domainBindings: [{ templateDomainId: 'web', hostname: 'app.example.test' }] },
            { runtimeAccountId: 'owner' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters', effectAttempted: false,
                details: { issues: [{ path: ['firstTargetLink'] }] } });
        expect(contentWrites).toBe(0);
    }

    // Compose the real Action → daemon → same template/default/Artifact owners.
    // Only the Home HTTP boundary is substituted; real signed storage is covered by the Server twin.
    const documents = new Map<string, Record<string, unknown>>();
    const originalGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        const row = documents.get(new URL(url).pathname.split('/').at(-1)!);
        return row ? { status: 200, data: row } : originalGet(url, config);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, value) => {
        expect(url).toBe('https://home.test/v1/artifacts');
        const mutation = readCarrierMutation(value);
        const id = String(mutation.id);
        documents.set(id, { ...mutation, id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
            encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
    });
    const grants = new Map<string, unknown>();
    vi.spyOn(axios, 'put').mockImplementation(async (_url, value) => {
        const mutation = readCarrierMutation(value);
        const artifactId = String(mutation.artifactId);
        grants.set(artifactId, mutation.principal);
        return { status: 200, data: { artifactId, ownerAccountId: 'owner', access: 'owner', changed: true,
            grants: [{ principal: mutation.principal, accessLevel: 'admin', createdByAccountId: 'owner',
                createdAt: 1, display: { name: null } }] } };
    });
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.owner = newProject.owner;
    environment.environment.controllerMachineId = 'target';
    if (linked) environment.environment.buildMachineId = 'target';
    else delete environment.environment.buildMachineId;
    const link = environment.targetLinks[0]!.targetLink;
    link.machines = ['target'];
    link.members = [{ machineId: 'target', installationId: identity.installationId, state: 'active' }];
    environment.targetLinks = [];
    delete environment.environment.runtimeTargetLinkId;
    const effects: string[] = [];
    sourceTransport.mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        if (request.method === 'GET' && path === `/v1/deployments/environments/${environment.environment.id}`) return {
            status: 200, data: { ok: true, environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
        if (path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [],
            bindingPreparation: { runtimeInstallations: [{ machineId: 'target', installationId: identity.installationId,
                publicKey: identity.publicKey }], buildInstallation: { machineId: 'target', installationId: identity.installationId,
                publicKey: identity.publicKey } } } };
        const body = readCarrierMutation(request.data);
        if (path === '/v1/deployments/environments' && request.method === 'POST') {
            const stored = DeploymentEnvironmentCreateInputV1Schema.parse(body);
            expect(stored.newProject).toEqual(newProject);
            expect(stored.projectSourceId).toBeUndefined();
            expect(stored.buildMachineId).toBe(linked ? 'target' : undefined);
            expect(stored.firstTargetLink?.machines).toEqual(linked ? [{ machineId: 'target', installationId: identity.installationId }] : undefined);
            if (stored.firstTargetLink) {
                link.contentArtifactId = stored.firstTargetLink.contentArtifactId;
                environment.targetLinks = [{ targetLink: link }];
                environment.environment.runtimeTargetLinkId = link.id;
            }
            effects.push('project-and-environment');
        } else if (path.endsWith('/bindings') && request.method === 'POST') effects.push('bindings');
        else throw new Error(`Unexpected Home effect: ${request.method} ${path}`);
        if (kind === 'team') expect(grants.get(String(body.contentArtifactId))).toEqual(newProject.owner);
        environment.environment.contentArtifactId = String(body.contentArtifactId);
        environment.environment.contentHeaderVersion = Number(body.contentHeaderVersion);
        environment.environment.contentBodyVersion = Number(body.contentBodyVersion);
        environment.environment.revision++;
        return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision } };
    });
    const requesterIdentity = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'home',
        hostAccountAutomation: { accountId: 'owner', custodianAccountId: 'owner', machineId: 'target', installationId: identity.installationId } });
    const deps = createDaemonDeploymentActionDeps({
        resolveRequesterIdentity: async () => requesterIdentity,
        credentials, serverId: 'home', machineId: 'target',
        serverHttpBaseUrl: 'https://home.test', savedSecretOperationContext: operation,
        runtime: { async acquire() { throw new Error('Creation has no native deployment effect'); } } });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
    const authored = DeploymentEnvironmentCreateIntentInputV1Schema.parse({
        serverId: 'home', name: 'App', newProject, definition: { from: 'catalogApp', templateRef },
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
        requestKey: 'root-create', controllerMachineId: 'target',
        ...(linked ? { firstTargetLink: { machines: [{ machineId: 'target', installationId: identity.installationId }] } } : {}) });
    const preparedRoot = await executor.prepare('deployments.environments.create', authored, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner', actionsSettings: normalizeActionsSettingsV1(undefined) });
    expect(preparedRoot.kind, JSON.stringify(preparedRoot)).toBe('ready');
    expect(effects).toEqual([]);
    expect(documents.size).toBe(0);
    if (preparedRoot.kind !== 'ready') throw new Error('Expected prepared catalog creation');
    const applied = await preparedRoot.invocation.run();
    expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true, result: { environmentId: environment.environment.id } });
    expect(effects).toEqual(['project-and-environment', 'bindings']);
    const saved = await deps.readDeploymentEnvironment({ environmentId: environment.environment.id, context: { runtimeAccountId: 'owner' } });
    expect(saved.environment.runtimeTargetLinkId).toBe(linked ? link.id : undefined);
    expect(saved.targetLinks).toHaveLength(linked ? 1 : 0);
    expect(saved.content.bindings).toMatchObject([{ purpose: 'variable', phase: 'runtime', name: 'APP_MODE' }]);
    expect(saved.content).toMatchObject({ retainPreviousDeployments: kind === 'account' ? 7 : 1,
        template: { templateRef, firstRunSetup: true } });
});


it.each(['runtime', 'build'] as const)('prepares unlinked %s Saved Secret references without acquiring credentials', async phase => {
    const detail = createDeploymentEnvironmentDetailV1();
    detail.targetLinks = [];
    delete detail.environment.runtimeTargetLinkId;
    delete detail.environment.buildMachineId;
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const binding = createDeploymentSecretVariableBindingV1({ phase, name: 'PASSWORD',
        resourceId: 'credential', resourceRevision: 1 });
    const candidate = { ...detail.content, bindings: [binding] };
    const artifact = (id: string, content: unknown) => ({ id, ownerAccountId: 'owner', access: 'owner',
        publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'App' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (url.endsWith(`/v1/artifacts/${detail.environment.contentArtifactId}`)) return { status: 200, data: artifact(detail.environment.contentArtifactId, detail.content) };
        if (url.endsWith('/v1/artifacts/candidate')) return { status: 200, data: artifact('candidate', candidate) };
        throw Object.assign(new Error('Unlinked references cannot acquire secret material'), { code: `unexpected_get_${new URL(url).pathname}` });
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.method?.toUpperCase() === 'GET' && new URL(request.url!).pathname === `/v1/deployments/environments/${detail.environment.id}`) return {
            status: 200, data: { ok: true, environment: detail.environment, targetLinks: [] } };
        throw Object.assign(new Error('No destination exists for secret admission'), { code: `unexpected_request_${new URL(request.url!).pathname}` });
    });
    const prepare = createPrepareDeploymentBindingsForHost({ credentials: { token, encryption: null }, serverId: 'home',
        serverHttpBaseUrl: 'https://home.test', machineId: 'controller', resolveRequestHeaders: async () => ({ Authorization: `Bearer ${token}` }) });
    const result = await prepare({ input: { serverId: 'home', environmentId: detail.environment.id,
        expectedRevision: detail.environment.revision, contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
        referencedSavedSecretRevisions: [{ resourceId: 'credential', revision: 1 }] }, context: {} });
    expect(result).toMatchObject(phase === 'runtime'
        ? { contentArtifactId: 'candidate', grants: [], referencedSavedSecretRevisions: [{ resourceId: 'credential', revision: 1 }] }
        : { ok: false, errorCode: 'secret_missing' });
});
