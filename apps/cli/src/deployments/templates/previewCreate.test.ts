import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createRegistryHostV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { accountSettingsParse, DeploymentEnvironmentCreateIntentInputV1Schema } from '@happier-dev/protocol';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DeploymentEnvironmentContentV1Schema, createOwnServerEnvironmentConfigurationV1 } from '@happier-dev/deployments/contracts/v1';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveEnvironmentCreatePreviewForHost } from '../prepareEnvironmentCreateForHost';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { prepareDeploymentTemplateInstantiationV1 } from '@happier-dev/deployments';
import { buildCatalogAppTemplateBindings } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { parseNativeComposeSource } from '@/workspaces/projectSetup/nativeComposeSource';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

afterEach(() => vi.restoreAllMocks());

it.each([
    { custody: 'host', storage: 'persistent' }, { custody: 'requester', storage: 'persistent' },
    { custody: 'host', storage: 'missing' }, { custody: 'host', storage: 'ephemeral' }, { custody: 'host', storage: 'otherService' },
    { custody: 'host', storage: 'undeclared' },
    { custody: 'host', storage: 'repeated' },
    { custody: 'host', storage: 'companion' }, { custody: 'host', storage: 'companionRepeated' },
    { custody: 'host', storage: 'priorEndpoints' },
    { custody: 'host', storage: 'companionRepeatedBackup' },
    { custody: 'host', storage: 'mixed' },
    { custody: 'host', storage: 'blueprintRepository' }, { custody: 'host', storage: 'blueprintCompanionMain' },
] as const)('prepares fresh credentials for repository-owned PostgreSQL with $custody custody and $storage storage', async ({ custody, storage }) => {
    const fixture = await createSavedSecretsCliHttpFixture();
    const channel = custody === 'requester' ? await createRequesterCurrentnessSocketHarness() : undefined;
    let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> | undefined;
    try {
        const credentials = await fixture.deps.readCredentialsFn?.();
        if (!credentials) throw new Error('Missing credentials');
        let catalog: unknown = JSON.parse(await readFile(new URL('../../../../../packages/plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
        const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
            url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
        const readTemplate = async () => {
            const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
                getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
                getText: async () => { throw new Error('Unexpected text'); }, getBytes: async () => { throw new Error('Unexpected bytes'); },
            } });
            const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
                sourceId: 'apps', kind: 'app', itemId: 'postgresql' })).item;
            if (item.payload.kind !== 'app' || item.payload.state !== 'ready') throw new Error('Expected a ready PostgreSQL app');
            return { ...item, payload: item.payload };
        };
        let selected = await readTemplate();
        if ((storage === 'missing' || storage === 'ephemeral' || storage === 'otherService') && selected.payload.kind === 'app') {
            const volumes = storage === 'missing' ? [] : selected.payload.app.volumes.map(volume => ({ ...volume,
                ...(storage === 'ephemeral' ? { persistent: false } : { service: 'another-database' }) }));
            catalog = { schemaVersion: 1, apps: [{ itemId: 'postgresql', app: { ...selected.payload.app, volumes } }] };
            selected = await readTemplate();
        }
        if (selected.payload.kind !== 'app') throw new Error('Missing app');
        const templateRef = { sourceId: 'apps', itemId: 'postgresql', version: selected.summary.version!, ref: selected.payload.ref };
        const { origin: _origin, removable: _removable, ...sourceRow } = source;
        const originalGet = axios.get.bind(axios);
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(catalog));
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account-cli-fixture' } };
            if (url.endsWith('/v1/account/entity-rows/prompt-library')) {
                expect(config?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
                return { status: 200, data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed',
                    rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: key === 'registry-sources'
                        ? { t: 'plain', v: { key, value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null })) }) };
            }
            return originalGet(url, config);
        });
        const scopeKey = fixture.inHome(() => resolveAccountSettingsScopeKey(credentials));
        const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: fixture.origin,
            snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
                scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
        let context: ActionExecutorContext = {};
        if (custody === 'requester') {
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-preview', binding: {
                accountId: 'account-cli-fixture', custodianAccountId: 'daemon-custodian', authentication: { kind: 'account', tokenEpoch: 7 },
                serverIdentityId: 'home', machineId: 'controller', installationId: 'installed-controller',
                actionId: 'deployments.environments.create', requestId: 'preview-create', requestEnvelopeDigest: 'A'.repeat(43),
                target: { kind: 'machine', machineId: 'controller' }, accountEncryptionMode: 'plain',
            } });
            requester = await admitRequesterAccountActionContext({ authorization, credentials, serverId: 'home',
                serverIdentityId: 'home', serverHttpBaseUrl: fixture.origin, isCurrent: async () => true });
            if (!requester) throw new Error('Expected admitted requester Account custody');
            context = { externalActionExecutionAuthorization: requester.authorization };
        }
        const hostCredentials = custody === 'host' ? credentials : { token: `header.${Buffer.from(JSON.stringify({ sub: 'daemon-custodian' })).toString('base64url')}.signature`, encryption: null };
        const hostOperation = custody === 'host' ? savedSecretOperationContext : createInvocationSavedSecretOperationContextV1({
            credentials: hostCredentials, serverHttpBaseUrl: fixture.origin, snapshot: { source: 'network', settings: accountSettingsParse({}),
                settingsVersion: 1, loadedAtMs: 1, scopeKey: fixture.inHome(() => resolveAccountSettingsScopeKey(hostCredentials)), settingsSecretsReadKeys: [] },
            isCurrent: async () => true });
        const originalRequest = axios.request.bind(axios);
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.url?.endsWith('/v1/account/saved-secrets/resources') && request.method?.toUpperCase() === 'POST')
                expect(request.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
            return originalRequest(request);
        });
        const parent = createDeploymentEnvironmentDetailV1();
        parent.content.definition = { kind: 'repository', ref: 'main', compose: { path: 'deploy/compose.yaml', profiles: ['application'], services: ['app', 'worker'], primaryService: 'app' } };
        const declared = prepareDeploymentTemplateInstantiationV1({ template: { ...selected.payload.app,
            volumes: selected.payload.app.volumes.filter(volume => volume.service === selected.payload.app.data?.service) }, templateRef,
            source: await parseNativeComposeSource(selected.payload.app.compose.document),
            bindings: buildCatalogAppTemplateBindings(selected.payload.app).bindings });
        parent.content.template = { ...declared.template, definition: parent.content.definition };
        if (storage === 'priorEndpoints') {
            parent.content.template = structuredClone(parent.content.template);
            for (const data of parent.content.template.data ?? [])
                if (data.variables) { delete data.variables.host; delete data.variables.port; }
        }
        if (storage === 'undeclared' || storage === 'companion' || storage === 'companionRepeated'
            || storage === 'companionRepeatedBackup' || storage === 'blueprintCompanionMain') parent.content.template.data = [];
        const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/app' };
        const runtime = parent.targetLinks[0]!.targetLink;
        parent.environment.controllerMachineId = runtime.members[0]!.machineId;
        parent.environment.runtimeTargetLinkId = runtime.id;
        parent.content.previewTemplate = { v: 1, enabled: true, forkPreviews: 'off', repository,
            runtimeTargetLinkId: runtime.id, domain: null, bindingBlueprints: [], data: [{ kind: 'template', templateRef,
                dataExportNames: ['DATABASE_URL', 'DIRECT_URL'], connectTo: { service: 'app' } }] };
        if (storage === 'blueprintRepository' || storage === 'blueprintCompanionMain') parent.content.previewTemplate.bindingBlueprints = [
            { purpose: 'variable', phase: 'runtime', name: 'DB_PASSWORD',
                source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('resource-id'), resourceRevision: 37 } },
            { purpose: 'variable', phase: 'runtime', name: 'DB_HOST', source: {
                kind: 'reference', environmentId: parent.environment.id, export: 'database', via: 'auto', component: 'host' } },
            { purpose: 'variable', phase: 'runtime', name: 'PREVIEW_LABEL', source: { kind: 'value', value: 'review' } },
        ];
        const provenance = { v: 1, templateEnvironmentId: parent.environment.id, runtimeTargetLinkId: runtime.id,
            repository, headRepository: repository, pullRequestId: 'pull-44', pullRequestNumber: 44, author: { id: 'author', login: 'author' } };
        const companion = storage === 'companion' || storage === 'companionRepeated' || storage === 'companionRepeatedBackup';
        if (storage === 'companionRepeatedBackup') parent.content.previewTemplate.data[0] = {
            ...parent.content.previewTemplate.data[0]!, destinationBackup: { prefix: 'previews', bindings: [],
                configuration: { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 'local' },
                    occurrenceId: 'installed', config: { path: '/backups' }, credentialBindings: [],
                    sources: [{ kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' },
                        { kind: 'volume', sourceId: 'pg-files', service: 'database', volume: 'postgres-data', consistency: 'stopDuringCopy' }],
                    retention: { kind: 'keepEverything' } } } };
        if (storage === 'companionRepeated' || storage === 'companionRepeatedBackup' || storage === 'mixed')
            parent.content.previewTemplate.data.push(parent.content.previewTemplate.data[0]!);
        const host = { credentials: hostCredentials, serverHttpBaseUrl: fixture.origin, savedSecretOperationContext: hostOperation,
            assertCurrent: async () => {}, resolveRequestHeaders: async () => ({}),
            readPreviewTemplate: async () => ({ ...parent, targetLinks: parent.targetLinks.map(row => row.targetLink) }) };
        if (storage === 'mixed') {
            const { preparePreviewTemplateCreationForHost, preparePreviewCompanionTemplateCreationForHost,
                materializePreviewTemplateBindingsForHost, readPreviewCompanionBindingsForHost } = await import('./previewCreate');
            const selections = parent.content.previewTemplate.data.filter(selection => selection.kind === 'template');
            const definition = parent.content.definition;
            if (definition.kind !== 'repository') throw new Error('Expected repository source');
            const main = await fixture.inHome(() => preparePreviewTemplateCreationForHost({ name: 'pr-44',
                definition, existingTemplate: parent.content.template, selections, context }, host));
            const mainBindings = await fixture.inHome(() => materializePreviewTemplateBindingsForHost(main, context, host));
            const companionPlan = await fixture.inHome(() => preparePreviewCompanionTemplateCreationForHost({ name: 'pr-44-data',
                existingTemplate: parent.content.template, selections, context,
                ...{ reservedVariableNames: mainBindings.filter(binding => binding.purpose === 'variable').map(binding => binding.name) },
            }, host));
            const companionBindings = await fixture.inHome(() => materializePreviewTemplateBindingsForHost(companionPlan, context, host));
            const connected = readPreviewCompanionBindingsForHost(companionPlan, companionBindings, 'companion');
            expect(connected.map(binding => binding.name)).not.toContain('DB_PASSWORD');
            expect(connected.map(binding => binding.name)).toContain('DB_PASSWORD_2');
            expect(companionPlan.data).toEqual([{ service: 'database-2', database: 'app' }]);
            expect(companionPlan.template?.volumes).toMatchObject([{ id: 'postgres-data-2', service: 'database-2' }]);
            expect(companionPlan.serviceExports).toMatchObject([{ key: 'database-2', service: 'database-2' }]);
            expect(connected.find(binding => binding.name === 'DB_HOST_2')?.source).toMatchObject({
                kind: 'reference', environmentId: 'companion', export: 'database-2', component: 'host' });
            expect(connected.find(binding => binding.name === 'DB_PASSWORD_2')?.source)
                .not.toEqual(mainBindings.find(binding => binding.purpose === 'variable' && binding.name === 'DB_PASSWORD')?.source);
            return;
        }
        if (storage === 'companionRepeatedBackup') {
            const { preparePreviewCompanionTemplateCreationForHost } = await import('./previewCreate');
            const plan = await fixture.inHome(() => preparePreviewCompanionTemplateCreationForHost({ name: 'pr-44-data',
                existingTemplate: parent.content.template, selections: parent.content.previewTemplate!.data.filter(selection => selection.kind === 'template'),
                context }, host));
            expect(plan).toMatchObject({ data: [{ service: 'database', database: 'app' }, { service: 'database-2', database: 'app' }],
                backup: { configuration: { sources: [
                    { kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' },
                    { kind: 'volume', sourceId: 'pg-files', service: 'database', volume: 'postgres-data', consistency: 'stopDuringCopy' },
                    { kind: 'dump', sourceId: '["dump","database-2"]', service: 'database-2', consistency: 'logical' },
                    { kind: 'volume', sourceId: '["volume","database-2","postgres-data-2"]', service: 'database-2', volume: 'postgres-data-2', consistency: 'stopDuringCopy' },
                ] } } });
            expect(fixture.writes).toEqual([]);
            return;
        }
        const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId: 'home', projectSourceId: parent.environment.projectSourceId,
            requestKey: 'pr-44', purpose: companion ? 'standard' : 'preview', protection: 'nonProduction', deployerMode: 'managers',
            ...(companion ? { previewCompanionOfEnvironmentId: 'main-preview' } : {}), preview: {
                templateEnvironmentId: parent.environment.id, expectedTemplateRevision: parent.environment.revision,
                runtimeTargetLinkId: runtime.id, pullRequestId: 'pull-44', headSha: 'a'.repeat(40), provenance } });
        if (storage === 'repeated') {
            const { preparePreviewNativeDataPlacementsForHost } = await import('./previewCreate');
            const selection = parent.content.previewTemplate.data[0]!;
            const placements = await fixture.inHome(() => preparePreviewNativeDataPlacementsForHost({
                selections: [selection, selection], existingTemplate: parent.content.template, context }, host));
            expect(placements).toEqual([
                { selectionIndex: 0, placement: 'repository', service: 'database', database: 'app' },
                { selectionIndex: 1, placement: 'companion', service: 'database', database: 'app' },
            ]);
            expect(fixture.writes).toEqual([]);
            return;
        }
        const admitted = await fixture.inHome(() => resolveEnvironmentCreatePreviewForHost({ input, context }, host));
        if (storage === 'missing' || storage === 'ephemeral' || storage === 'otherService') {
            expect(admitted).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
            expect(fixture.writes).toEqual([]);
            return;
        }
        expect(admitted).not.toHaveProperty('errorCode');
        if ('errorCode' in admitted) throw new Error(admitted.errorCode);
        const plan = admitted.nativeTemplate!;
        expect(fixture.writes).toEqual([]);
        if (storage === 'blueprintRepository' || storage === 'blueprintCompanionMain') {
            const { materializePreviewTemplateBindingsForHost } = await import('./previewCreate');
            const bindings = await fixture.inHome(() => materializePreviewTemplateBindingsForHost(plan, context, host));
            expect(bindings).toContainEqual(expect.objectContaining({ purpose: 'variable', phase: 'runtime', name: 'PREVIEW_LABEL',
                grantRef: expect.any(String), source: { kind: 'value', value: 'review' } }));
            expect(bindings).not.toContainEqual(parent.content.previewTemplate.bindingBlueprints[0]);
            expect(bindings).not.toContainEqual(parent.content.previewTemplate.bindingBlueprints[1]);
            if (storage === 'blueprintRepository') {
                expect(bindings.find(binding => binding.purpose === 'variable' && binding.name === 'DB_PASSWORD')?.source)
                    .toMatchObject({ kind: 'secret', resourceRevision: 1 });
            } else {
                expect(plan).toMatchObject({ companionRequired: true, data: [], preparations: [] });
                expect(bindings.filter(binding => binding.purpose === 'variable').map(binding => binding.name)).toEqual(['PREVIEW_LABEL']);
            }
            return;
        }
        if (companion) {
            expect(admitted.input.previewCompanionOfEnvironmentId).toBe('main-preview');
            expect(admitted.input.name).toBe('pr-44-data');
            expect(plan.definition.kind).toBe('stored');
            expect(plan.data).toEqual(storage === 'companion' ? [{ service: 'database', database: 'app' }]
                : [{ service: 'database', database: 'app' }, { service: 'database-2', database: 'app' }]);
            expect(plan.template?.volumes?.map(volume => volume.service)).toEqual(plan.data.map(data => data.service));
            const { materializePreviewTemplateBindingsForHost } = await import('./previewCreate');
            const bindings = await fixture.inHome(() => materializePreviewTemplateBindingsForHost(plan, context, host));
            expect(DeploymentEnvironmentContentV1Schema.safeParse({ name: plan.name, retainPreviousDeployments: 1,
                definition: plan.definition, template: plan.template, bindings,
                ownServer: createOwnServerEnvironmentConfigurationV1({ serviceExports: plan.serviceExports }) }).success).toBe(true);
            const passwords = bindings.filter(binding => binding.purpose === 'variable' && binding.name.startsWith('DB_PASSWORD'));
            expect(passwords).toHaveLength(plan.data.length);
            expect(new Set(passwords.map(binding => JSON.stringify(binding.source))).size).toBe(plan.data.length);
            return;
        }
        if (storage === 'undeclared') {
            expect(plan).toMatchObject({ companionRequired: true, data: [], preparations: [], selections: [] });
            expect(plan.template).toBeUndefined();
            expect(plan.definition).toEqual({ ...parent.content.definition, ref: 'a'.repeat(40) });
            return;
        }
        runtime.members.push({ ...runtime.members[0]!, machineId: 'another-machine' });
        expect(await fixture.inHome(() => resolveEnvironmentCreatePreviewForHost({ input, context }, host)))
            .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        runtime.members.pop();
        expect(plan.data).toEqual([{ service: 'database', database: 'app' }]);
        expect(plan.definition.kind).toBe('repository');
        if (plan.definition.kind !== 'repository') throw new Error('Expected repository source');
        expect(plan.definition.compose?.path).toBe('deploy/compose.yaml');
        expect(plan.definition.compose).toEqual(parent.content.definition.compose);
        expect(plan.definition.compose?.profiles).toEqual(['application']);
        expect(plan.template!.data).toEqual([selected.payload.app.data]);
        expect(plan.template!.volumes).toEqual(parent.content.template.volumes);
        const { materializePreviewTemplateBindingsForHost } = await import('./previewCreate');
        const first = await fixture.inHome(() => materializePreviewTemplateBindingsForHost(plan, context, host));
        const second = await fixture.inHome(() => materializePreviewTemplateBindingsForHost(plan, context, host));
        const passwords = [first, second].map(bindings => bindings.find(binding => binding.purpose === 'variable' && binding.name === 'DB_PASSWORD')?.source);
        expect(passwords[0]).toMatchObject({ kind: 'secret', resourceRevision: 1 });
        expect(passwords[1]).not.toEqual(passwords[0]);
        expect(fixture.writes).toHaveLength(2);
        for (const write of fixture.writes) {
            const password = fixture.openedValue(write);
            expect(typeof password).toBe('string');
            expect(JSON.stringify({ plan, first, second })).not.toContain(password);
        }
    } finally { await requester?.dispose(); await channel?.close(); await fixture.close(); }
});
