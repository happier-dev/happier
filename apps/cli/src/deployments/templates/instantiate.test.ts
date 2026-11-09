import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { listActionSpecsForSurface } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';
import { createPrepareEnvironmentContentForHost } from '../prepareEnvironmentContentForHost';
import { createDeploymentTemplateInstantiationForHost } from './instantiate';
import { parseNativeComposeSource } from '@/workspaces/projectSetup/nativeComposeSource';
import { isNativeDefinitionRecord } from '@/workspaces/projectSetup/nativePackageScripts';
import { createRegistryHostV1, DeploymentTemplateV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { accountSettingsParse, ProjectDeploymentDefaultsOutputV1Schema, DeploymentTemplateInstantiateInputV1Schema,
    DeploymentTemplateInstantiateResultV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentEnvironmentCreateInputV1Schema, DeploymentTargetLinkResultV1Schema, MachineSetupApplyInputV1Schema, ApprovalRequestV2Schema,
    decideApprovalRequestTransition, getMachineSetupDesiredV1, type ApprovalRequestV2 } from '@happier-dev/protocol';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readDeploymentCreationDefaultInputsForHost } from '../readCreationDefaultsForHost';
import { MachineVitalsSampleV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { createCombinedMachineSetupActionDeps } from '@/machines/setup/composeMachineSetup';
import { createMachineSetupPlanAction } from '@/machines/setup/machineSetupAction';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { PluginAvailabilityIntentsListActionInputV1Schema, PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';

afterEach(() => vi.restoreAllMocks());

it('persists two additions of the bundled default database with independent generated credentials', async () => {
    const fixture = await createSavedSecretsCliHttpFixture();
    try {
        const credentials = await fixture.deps.readCredentialsFn?.();
        if (!credentials) throw new Error('Fixture credentials unavailable');
        const identity = await readOrCreateInstallationIdentity();
        const catalog: unknown = JSON.parse(await readFile(new URL('../../../../../packages/plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
        if (!catalog || typeof catalog !== 'object' || !('apps' in catalog) || !Array.isArray(catalog.apps)) throw new Error('Expected bundled catalog');
        const entry: unknown = catalog.apps.find((entry: { itemId: string }) => entry.itemId === 'postgresql');
        if (!entry || typeof entry !== 'object' || !('app' in entry)) throw new Error('Expected bundled PostgreSQL');
        const app = DeploymentTemplateV1Schema.parse(entry.app);
        const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
            url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
        const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
            getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
            getText: async () => { throw new Error('No text fetch'); }, getBytes: async () => { throw new Error('No binary fetch'); },
        } });
        const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
            sourceId: 'apps', kind: 'app', itemId: 'postgresql' })).item;
        if (selected.payload.kind !== 'app') throw new Error('Expected app producer');
        const { origin: _origin, removable: _removable, ...sourceRow } = source;
        const current = createDeploymentEnvironmentDetailV1();
        current.environment.projectSourceId = 'project';
        current.environment.controllerMachineId = 'target';
        current.content = DeploymentEnvironmentContentV1Schema.parse({ ...current.content, bindings: [],
            definition: await normalizeStoredComposeDefinitionInput({ from: 'compose', document: 'services:\n  app:\n    image: nginx:1\n',
                profiles: [], services: ['app'] }) });
        const link = current.targetLinks[0]!.targetLink;
        current.environment.runtimeTargetLinkId = link.id;
        link.machines = ['target'];
        link.members = [{ machineId: 'target', installationId: identity.installationId, state: 'active' }];
        // Artifact and Home persistence are genuine process boundaries; the complete template writer stays real.
        const artifacts = new Map<string, unknown>();
        const persist = (raw: unknown) => {
            const body = readCarrierMutation(raw);
            current.content = DeploymentEnvironmentContentV1Schema.parse(artifacts.get(String(body.contentArtifactId)));
            current.environment.revision++;
            return { ok: true as const, environmentId: current.environment.id, revision: current.environment.revision };
        };
        const originalGet = axios.get.bind(axios);
        const originalRequest = axios.request.bind(axios);
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(catalog));
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => url.endsWith('/v1/account/entity-rows/prompt-library')
            ? { status: 200, data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed',
                rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: key === 'registry-sources'
                    ? { t: 'plain', v: { key, value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null })) }) }
            : originalGet(url, config));
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = request.url ? new URL(request.url).pathname : '';
            if (request.method === 'GET' && path === '/v1/projects/sources/project') return { status: 200, data: { ok: true, canManage: true,
                source: { id: 'project', revision: 1, name: 'Project', createdByAccountId: 'account-cli-fixture', audience: [] } } };
            if (request.method === 'POST' && path.endsWith('/template')) return { status: 200, data: persist(request.data) };
            return originalRequest(request);
        });
        const scopeKey = fixture.inHome(() => resolveAccountSettingsScopeKey(credentials));
        const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: fixture.origin,
            snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
                scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
        const templates = createDeploymentTemplateInstantiationForHost({ credentials, serverId: 'home', machineId: 'target',
            readInstallation: async () => identity.installationId, serverHttpBaseUrl: fixture.origin,
            savedSecretOperationContext: operation, assertCurrent: async () => {}, headers: async () => ({}),
            readEnvironment: async () => current, readCreationDefaultInputs: async () => ({}),
            createContent: async content => { const id = `content-${artifacts.size}`; artifacts.set(id, content);
                return { contentArtifactId: id, contentHeaderVersion: 1, contentBodyVersion: 1 }; },
            storage: async (_action, input) => persist(input),
        });
        for (const ordinal of [1, 2]) {
            const definition = current.content.definition;
            if (definition.kind !== 'stored') throw new Error('Expected stored definition');
            const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', intent: 'add', serverId: 'home', machineId: 'target',
                projectSourceId: 'project', templateRef: { sourceId: 'apps', itemId: 'postgresql', version: selected.summary.version!, ref: selected.payload.ref },
                environment: { kind: 'existing', environmentId: current.environment.id, expectedRevision: current.environment.revision },
                target: { kind: 'existing', targetLinkId: link.id, expectedRevision: link.revision, installationId: identity.installationId },
                destination: { kind: 'stored', contentRevision: definition.contentRevision, composeDigest: definition.composeDigest },
                bindings: [{ purpose: 'variable', name: 'DB_PASSWORD', phase: 'runtime', source: { kind: 'generated', key: 'DB_PASSWORD' } }],
                generatedSecretAudience: { accountGrants: [], teamGrants: [], groupGrants: [] } });
            const preview = await fixture.inHome(() => templates.instantiate({ ...input, mode: 'preview' }, { runtimeAccountId: 'account-cli-fixture' }));
            expect(preview).toMatchObject({ kind: 'preview', review: { generatedSecrets: [{ name: ordinal === 1 ? 'DB_PASSWORD' : 'DB_PASSWORD_2' }] } });
            const result = await fixture.inHome(() => templates.instantiate(input, { runtimeAccountId: 'account-cli-fixture' }));
            expect(result).toMatchObject({ kind: 'applied', savedSecrets: [{ name: ordinal === 1 ? 'DB_PASSWORD' : 'DB_PASSWORD_2' }] });
        }
        const stored = DeploymentEnvironmentContentV1Schema.parse(current.content);
        expect(stored.template?.data?.map(data => ({ service: data.service, variables: data.variables, backup: data.logicalBackup })))
            .toEqual([1, 2].map(ordinal => ({ service: ordinal === 1 ? 'database' : 'database-2',
                variables: { username: ordinal === 1 ? 'DB_USER' : 'DB_USER_2', password: ordinal === 1 ? 'DB_PASSWORD' : 'DB_PASSWORD_2',
                    database: ordinal === 1 ? 'DB_NAME' : 'DB_NAME_2' },
                backup: { adapter: 'postgres-v1', database: ordinal === 1 ? 'DB_NAME' : 'DB_NAME_2', username: ordinal === 1 ? 'DB_USER' : 'DB_USER_2' } })));
        expect(stored.bindings.map(binding => binding.name)).toEqual(['DB_USER', 'DB_NAME', 'DB_PASSWORD', 'DB_USER_2', 'DB_NAME_2', 'DB_PASSWORD_2']);
        if (stored.definition.kind !== 'stored') throw new Error('Expected stored output');
        const composed = await parseNativeComposeSource(stored.definition.document);
        expect(composed.services).toHaveProperty('database-2');
        expect(composed.services).toMatchObject({ 'database-2': { environment: {
            POSTGRES_USER: '${DB_USER_2}', POSTGRES_PASSWORD: '${DB_PASSWORD_2}', POSTGRES_DB: '${DB_NAME_2}' },
            volumes: ['postgres-data-2:/var/lib/postgresql/data'],
            healthcheck: { test: ['CMD-SHELL', 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'] } } });
        expect(composed.volumes).toEqual({ 'postgres-data': {}, 'postgres-data-2': {} });
        expect(stored.template?.exports?.DATABASE_URL).toMatchObject({ service: 'database-2',
            env: { DATABASE_URL: 'postgres://${DB_USER_2}:${DB_PASSWORD_2}@database-2:5432/${DB_NAME_2}' } });
        expect(fixture.writes).toHaveLength(2);
        expect(fixture.opened(fixture.writes[0]!)?.value === fixture.opened(fixture.writes[1]!)?.value).toBe(false);
    } finally { await fixture.close(); }
});

it.each(['template', 'environment', 'admittedTemplate'] as const)('retains generated secret outcomes through the %s entry and refuses a fresh disabled-source request', async entry => {
    const fixture = await createSavedSecretsCliHttpFixture();
    try {
        const credentials = await fixture.deps.readCredentialsFn?.();
        if (!credentials) throw new Error('Fixture credentials unavailable');
        const identity = await readOrCreateInstallationIdentity();
        const secretKeys = ['APP_PASSWORD', 'DB_PASSWORD', 'ADMIN_PASSWORD'];
        const publicFiles = [{ path: 'files/config.json', content: '{"feature":true}\n' }];
        const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
            document: `services:\n  web:\n    image: nginx:1\n    environment:\n${secretKeys.map(key => `      ${key}: \${${key}}\n`).join('')}`,
            profiles: [], services: ['web'], publicFiles },
            variables: secretKeys.map(key => ({ key, label: key, required: true, valueKind: 'string', secret: true,
                sites: [{ service: 'web', path: ['environment', key] }] })),
            generatedSecrets: secretKeys.map(key => ({ key, purpose: 'password', label: key, profile: { kind: 'hex-32-bytes' } })),
            domains: [], volumes: [] });
        const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
            url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
        const catalog = { schemaVersion: 1, apps: [{ itemId: 'app', app }] };
        const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
            getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
            getText: async () => { throw new Error('No selected text fetch'); }, getBytes: async () => { throw new Error('No binary fetch'); },
        } });
        const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
            sourceId: source.id, kind: 'app', itemId: 'app' })).item;
        if (selected.payload.kind !== 'app') throw new Error('Expected app producer output');
        const { origin: _origin, removable: _removable, ...sourceRow } = source;
        let sourceReads = 0;
        const originalGet = axios.get.bind(axios);
        const originalRequest = axios.request.bind(axios);
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(catalog), { status: 200 }));
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            if (url.endsWith('/v1/account/entity-rows/prompt-library')) {
                sourceReads++;
                return { status: 200, data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed',
                    rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: key === 'registry-sources'
                        ? { t: 'plain', v: { key, value: { v: 2, sources: [{ ...sourceRow, enabled: fixture.writes.length === 0 }],
                            disabledSourceIds: [] } } } : null })) }) };
            }
            return originalGet(url, config);
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => request.method === 'GET'
            && request.url && new URL(request.url).pathname === '/v1/projects/sources/project' ? { status: 200, data: { ok: true, canManage: true,
                source: { id: 'project', revision: 1, name: 'Project', createdByAccountId: 'account-cli-fixture', audience: [] } } }
            : originalRequest(request));
        const scopeKey = fixture.inHome(() => resolveAccountSettingsScopeKey(credentials));
        const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: fixture.origin,
            snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
                scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
        const templates = createDeploymentTemplateInstantiationForHost({ credentials, serverId: 'home', machineId: 'target',
            readInstallation: async () => identity.installationId,
            serverHttpBaseUrl: fixture.origin, savedSecretOperationContext: operation, assertCurrent: async () => {},
            headers: async () => ({ Authorization: `Bearer ${credentials.token}` }),
            storage: async () => { throw new Error('Interrupted before Environment storage'); },
            readEnvironment: async () => { throw new Error('No existing Environment'); }, readCreationDefaultInputs: async () => ({}),
            createContent: async content => {
                expect(content).toMatchObject({ definition: { publicFiles } });
                throw Object.assign(new Error('content_boundary_interrupted'), { code: 'content_boundary_interrupted' });
            },
        });
        const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', serverId: 'home', machineId: 'target',
            projectSourceId: 'project', templateRef: { sourceId: 'apps', itemId: 'app', version: selected.summary.version!, ref: selected.payload.ref },
            environment: { kind: 'create', name: 'App', requestKey: 'generated-app', protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: 'target' }, target: { kind: 'new', installationId: identity.installationId },
            destination: { kind: 'stored' }, generatedSecretAudience: { teamGrants: ['team-reviewed'] },
            bindings: secretKeys.map(name => ({ purpose: 'variable', name, phase: 'runtime', source: { kind: 'generated', key: name } })) });
        expect(await fixture.inHome(() => templates.instantiate({ ...input, templateRef: { ...input.templateRef,
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } } }, { runtimeAccountId: 'account-cli-fixture' })))
            .toMatchObject({ ok: false, errorCode: 'template_changed', effectAttempted: false });
        expect(fixture.writes).toEqual([]);
        expect(await fixture.inHome(() => templates.instantiate({ ...input, mode: 'preview' }, { runtimeAccountId: 'account-cli-fixture' })))
            .toMatchObject({ kind: 'preview', review: { publicFiles, document: expect.stringContaining('services') } });
        if (entry === 'template') {
            const invalid = { ...input, mode: 'preview' as const,
                bindings: [{ purpose: 'variable' as const, name: 'APP_PASSWORD', phase: 'runtime' as const,
                    source: { kind: 'generated' as const, key: 'requested-password' } }] };
            const invalidCreate = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ name: 'App', requestKey: 'generated-app',
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'target',
                mode: 'preview', serverId: input.serverId, projectSourceId: input.projectSourceId,
                definition: { from: 'catalogApp', templateRef: input.templateRef },
                firstTargetLink: { machines: [{ machineId: 'target', installationId: identity.installationId }] },
                bindings: invalid.bindings, generatedSecretAudience: input.generatedSecretAudience });
            const context = { runtimeAccountId: 'account-cli-fixture' };
            for (const invoke of [() => templates.prepare(invalid, context), () => templates.prepareCreate(invalidCreate, context),
                () => templates.instantiate(invalid, context), () => templates.instantiateCreate(invalidCreate, context)]) {
                expect.soft(await fixture.inHome(async () => invoke())).toMatchObject({ ok: false, errorCode: 'template_generator_undeclared',
                    error: expect.stringContaining('requested-password'), details: { key: 'requested-password' } });
            }
            expect(fixture.writes).toEqual([]);
        }
        sourceReads = 0;
        const result = await fixture.inHome(async () => {
            const context = { runtimeAccountId: 'account-cli-fixture' };
            if (entry === 'admittedTemplate') {
                const prepared = await templates.prepare(input, context);
                if ('errorCode' in prepared) return prepared;
                const execute = prepared.hostReviewedChildren.executeAdmittedAction;
                if (!execute) throw new Error('Missing admitted template continuation');
                return execute({ actionId: 'deployments.templates.instantiate', input, context,
                    execute: async () => { throw new Error('Captured template plan owns this effect'); } });
            }
            return entry === 'template' ? templates.instantiate(input, context)
                : templates.instantiateCreate(DeploymentEnvironmentCreateIntentInputV1Schema.parse({
                mode: 'apply', serverId: input.serverId, projectSourceId: input.projectSourceId,
                name: 'App', requestKey: 'generated-app', protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: 'target',
                definition: { from: 'catalogApp', templateRef: input.templateRef },
                firstTargetLink: { machines: [{ machineId: 'target', installationId: identity.installationId }] },
                bindings: input.bindings, generatedSecretAudience: input.generatedSecretAudience,
            }), context);
        });
        const partial = 'details' in result ? result.details : result;
        if ('ok' in result) expect.soft(result).toMatchObject({ ok: false, effectAttempted: true,
            errorCode: 'content_boundary_interrupted', error: 'content_boundary_interrupted' });
        expect.soft(partial).toMatchObject({ kind: 'partial', phase: 'environment', errorCode: 'content_boundary_interrupted',
            savedSecrets: secretKeys.map(name => ({ name, source: { kind: 'secret', resourceRevision: 1 } })) });
        expect.soft(sourceReads).toBe(1);
        expect.soft(fixture.writes).toHaveLength(secretKeys.length);
        for (const write of fixture.writes) {
            expect(write.teamGrants).toEqual(['team-reviewed']);
            const value = fixture.opened(write)?.value;
            expect(value).toMatch(/^[a-f0-9]{64}$/u);
            expect(JSON.stringify(result)).not.toContain(value);
        }
        expect(await fixture.inHome(() => templates.instantiate(input, { runtimeAccountId: 'account-cli-fixture' })))
            .toMatchObject({ ok: false, errorCode: 'invalid_source', effectAttempted: false });
        expect(fixture.writes).toHaveLength(secretKeys.length);
    } finally { await fixture.close(); }
});

it('keeps reloaded template pins usable and retains a refused first content write as an attempted effect', async () => {
    const identity = await readOrCreateInstallationIdentity();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const origin = 'https://home.test';
    const scopeKey = runWithServerHttpBaseUrl(origin, () => resolveAccountSettingsScopeKey(credentials));
    const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: origin,
        snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
            scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
    const pluginId = 'com.acme.template-reload';
    const authored = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Template reload', registrySources: {
        apps: { title: 'Apps', format: 'happier-catalog', kinds: ['app'], url: 'https://apps.test/reload.json' },
        packaged: { title: 'Packaged apps', format: 'happier-catalog', kinds: ['app'], packageContent: { path: 'resources/apps.json' } },
    } });
    const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
        document: 'services:\n  web:\n    image: nginx:1\n', profiles: [], services: ['web'] },
        variables: [], generatedSecrets: [], domains: [], volumes: [] });
    const catalog = { schemaVersion: 1, apps: [{ itemId: 'app', app }] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(catalog));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (url.endsWith('/v1/account/entity-rows/prompt-library')) return { status: 200,
            data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
                key, revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key,
                    value: { v: 2, sources: [], disabledSourceIds: [] } } } : null,
            })) }) };
        throw new Error('Unexpected Account transport');
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.method === 'GET' && request.url && new URL(request.url).pathname === '/v1/projects/sources/project') return { status: 200,
            data: { ok: true, canManage: true, source: { id: 'project', revision: 1, name: 'Project',
                createdByAccountId: 'owner', audience: [] } } };
        throw new Error('Preview cannot mutate storage');
    });
    const plugin = { manifest: authored.manifest, files: { 'resources/apps.json': JSON.stringify(catalog) } };
    let runtime = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        plugins: [plugin], coldStart: true });
    try {
        const registry = createCliRegistryHostV1({ credentials, operationContext: operation });
        const selections = await Promise.all(['apps', 'packaged'].map(async localId => {
            const sourceId = `${pluginId}/${localId}`;
            const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
                sourceId, kind: 'app', itemId: 'app' })).item;
            if (selected.payload.kind !== 'app') throw new Error('Expected admitted app producer output');
            return { sourceId, selected, ref: selected.payload.ref };
        }));
        const occurrenceId = runtime.registry.contributes.occurrenceIdsByPluginId?.[pluginId];
        if (!occurrenceId) throw new Error('Expected admitted plugin occurrence');
        await runtime.dispose();
        runtime = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            plugins: [plugin], coldStart: true });
        expect(runtime.registry.contributes.occurrenceIdsByPluginId?.[pluginId]).not.toBe(occurrenceId);
        let contentAttempts = 0;
        const templates = createDeploymentTemplateInstantiationForHost({ credentials, serverId: 'home', machineId: 'target',
            readInstallation: async () => identity.installationId,
            serverHttpBaseUrl: origin, savedSecretOperationContext: operation, assertCurrent: async () => {},
            headers: async () => ({ Authorization: `Bearer ${token}` }),
            storage: async () => { throw new Error('Preview cannot write'); },
            readEnvironment: async () => { throw new Error('No existing Environment'); }, readCreationDefaultInputs: async () => ({}),
            createContent: async () => {
                contentAttempts++;
                throw Object.assign(new Error('Content response lost'), { code: 'content_boundary_interrupted' });
            },
        });
        for (const { sourceId, selected, ref } of selections) {
            const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'preview', serverId: 'home', machineId: 'target',
                projectSourceId: 'project', templateRef: { sourceId, itemId: 'app',
                    version: selected.summary.version!, ref, expectedContributorOccurrenceId: occurrenceId },
                environment: { kind: 'create', name: 'App', requestKey: 'reloaded-app', protection: 'nonProduction', purpose: 'standard',
                    deployerMode: 'managers', controllerMachineId: 'target' }, target: { kind: 'new', installationId: identity.installationId },
                destination: { kind: 'stored' }, bindings: [] });
            expect.soft(await templates.instantiate(input, { runtimeAccountId: 'owner' })).toMatchObject({ kind: 'preview',
                review: { templateRef: input.templateRef, services: ['web'] } });
            const apply = { ...input, mode: 'apply' as const };
            const context = { runtimeAccountId: 'owner' };
            const prepared = await templates.prepare(apply, context);
            if ('errorCode' in prepared) throw new Error(prepared.errorCode);
            const execute = prepared.hostReviewedChildren.executeAdmittedAction;
            if (!execute) throw new Error('Missing admitted template continuation');
            expect.soft(await execute({ actionId: 'deployments.templates.instantiate', input: apply, context,
                execute: async () => { throw new Error('Captured template plan owns this effect'); } }))
                .toMatchObject({ ok: false, effectAttempted: true, errorCode: 'content_boundary_interrupted',
                    details: { kind: 'partial', phase: 'environment', savedSecrets: [] } });
        }
        expect(contentAttempts).toBe(selections.length);
    } finally { await runtime.dispose(); }
});

it('prepares a catalog upgrade from the recorded pin and keeps local edits and bound secrets before storage', async () => {
    const identity = await readOrCreateInstallationIdentity();
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
    const scopeKey = runWithServerHttpBaseUrl('https://home.test', () => resolveAccountSettingsScopeKey(credentials));
    const custody = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://home.test',
        snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
            scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
    const source: RegistrySourceDescriptorV1 = { id: 'upgrade-apps', title: 'Apps', format: 'coolify-templates', kinds: ['app'],
        url: 'https://github.com/example/upgrade-apps', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
    const oldCommit = 'a'.repeat(40), newCommit = 'b'.repeat(40);
    let baselineAvailable = true;
    const read = (url: string): { status: number; body: unknown } => {
        const commit = url.split('/').find(part => part === oldCommit || part === newCommit);
        if (commit === oldCommit && !baselineAvailable) return { status: 404, body: null };
        if (commit && url.includes('/commits/')) return { status: 200, body: { sha: commit } };
        if (commit && url.endsWith('/templates/service-templates.json')) return { status: 200, body: { app: { name: 'App' } } };
        if (commit && url.endsWith('/templates/compose/app.yaml')) return { status: 200, body:
            `services:\n  web:\n    image: nginx:${commit === oldCommit ? '1' : '2'}\n    environment:\n      SERVICE_PASSWORD_APP:\n      PASSWORD: \${SERVICE_PASSWORD_APP}\n` };
        throw new Error('Unexpected catalog boundary route');
    };
    const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
        getJson: async url => { const result = read(url); return result.status === 200
            ? { ok: true, value: result.body, fetchedAt: 1 } : { ok: false, status: { state: 'invalid_source' } }; },
        getText: async url => { const result = read(url); return result.status === 200 && typeof result.body === 'string'
            ? { ok: true, value: result.body, fetchedAt: 1 } : { ok: false, status: { state: 'invalid_source' } }; },
        getBytes: async () => { throw new Error('No binary catalog read'); },
    } });
    const selection = async (version: string) => {
        const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
            sourceId: source.id, kind: 'app', itemId: 'app', version })).item;
        if (item.payload.kind !== 'app' || item.payload.state !== 'ready') throw new Error('Expected canonical ready app');
        return { app: item.payload.app, ref: { sourceId: source.id, itemId: 'app', version, ref: item.payload.ref } };
    };
    const old = await selection(oldCommit), next = await selection(newCommit);
    const { origin: _origin, removable: _removable, ...sourceRow } = source;
    const rows = PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
        key, revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key,
            value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null,
    })) });
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
        requests.push(String(url)); const response = read(String(url));
        return new Response(typeof response.body === 'string' ? response.body : JSON.stringify(response.body), { status: response.status });
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (url.endsWith('/v1/account/entity-rows/prompt-library')) return { status: 200, data: rows };
        throw new Error('Unexpected Account read');
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.method === 'GET' && request.url?.includes('/v1/projects/sources/project')) return { status: 200, data: { ok: true,
            canManage: true, source: { id: 'project', revision: 1, name: 'Project', createdByAccountId: 'owner', audience: [] } } };
        throw new Error('Unexpected Project boundary request');
    });
    const current = createDeploymentEnvironmentDetailV1();
    current.environment.projectSourceId = 'project';
    current.environment.controllerMachineId = 'target';
    const local = await parseNativeComposeSource(old.app.compose.document);
    if (!isNativeDefinitionRecord(local.services) || !isNativeDefinitionRecord(local.services.web)) throw new Error('Missing normalized web service');
    local.services.web.labels = { team: 'operations' };
    local.services.cache = { image: 'redis:7' };
    const definition = { kind: 'stored' as const, contentRevision: 2, composeDigest: `sha256:${'c'.repeat(64)}`,
        document: JSON.stringify(local), profiles: [], services: ['web', 'cache'], primaryService: 'web' };
    const binding = createDeploymentSecretVariableBindingV1({ name: 'SERVICE_PASSWORD_APP', phase: 'runtime', resourceId: 'password', resourceRevision: 1 });
    current.content = DeploymentEnvironmentContentV1Schema.parse({ ...current.content, definition, bindings: [binding],
        template: { templateRef: old.ref, services: ['web'], definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'d'.repeat(64)}` } } });
    const link = current.targetLinks[0]!.targetLink;
    link.machines = ['target']; link.members = [{ machineId: 'target', installationId: identity.installationId, state: 'active' }];
    const proposed: unknown[] = [];
    const templates = createDeploymentTemplateInstantiationForHost({ credentials, serverId: 'home', machineId: 'target',
        readInstallation: async () => identity.installationId,
        serverHttpBaseUrl: 'https://home.test', savedSecretOperationContext: custody, assertCurrent: async () => {}, headers: async () => ({}),
        storage: async () => { throw new Error('Interrupted before storage'); }, readEnvironment: async () => current,
        readCreationDefaultInputs: async () => { throw new Error('Existing app does not use creation defaults'); },
        createContent: async value => { proposed.push(value); throw new Error('Artifact boundary interrupted'); },
    });
    const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', serverId: 'home', machineId: 'target',
        projectSourceId: 'project', templateRef: next.ref,
        environment: { kind: 'existing', environmentId: current.environment.id, expectedRevision: current.environment.revision },
        target: { kind: 'existing', targetLinkId: link.id, expectedRevision: link.revision, installationId: identity.installationId },
        destination: { kind: 'stored', contentRevision: definition.contentRevision, composeDigest: definition.composeDigest }, bindings: [] });
    const upgradeResult = await templates.instantiate(input, { runtimeAccountId: 'owner' });
    expect(proposed, JSON.stringify(upgradeResult)).toHaveLength(1);
    const prepared = DeploymentEnvironmentContentV1Schema.parse(proposed[0]);
    if (prepared.definition.kind !== 'stored') throw new Error('Expected stored candidate');
    expect(JSON.parse(prepared.definition.document).services).toEqual({ ...local.services,
        web: { ...local.services.web, image: 'nginx:2' } });
    expect(prepared.bindings).toEqual([binding]);
    expect(requests.some(url => url.includes(`/${oldCommit}/templates/compose/app.yaml`))).toBe(true);
    expect(requests.some(url => url.includes(`/${newCommit}/templates/compose/app.yaml`))).toBe(true);
    baselineAvailable = false;
    expect(await templates.instantiate(input, { runtimeAccountId: 'owner' })).toMatchObject({ ok: false, errorCode: 'template_source_unavailable' });
    expect(proposed).toHaveLength(1);
});

it('applies admitted Project defaults and preserves Team content audience through template create and apply', async ({ onTestFailed }) => {
    let phase = 'installation_identity';
    onTestFailed(() => { console.error(`template_owner_test_phase:${phase}`); });
    const identity = await readOrCreateInstallationIdentity();
    const requesterIdentity = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'home',
        hostAccountAutomation: { accountId: 'owner', custodianAccountId: 'owner', machineId: 'target',
            installationId: identity.installationId } });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const scopeKey = runWithServerHttpBaseUrl('https://home.test', () => resolveAccountSettingsScopeKey(credentials));
    const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://home.test',
        snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
            scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
    const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
        url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
    const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
        document: 'services:\n  web:\n    image: nginx:1\n', profiles: [], services: ['web'] },
        variables: [], generatedSecrets: [], domains: [], volumes: [], firstRunSetup: true,
        minimumResources: { memoryBytes: 2048, freeDiskBytes: 4096 } });
    const catalog = { schemaVersion: 1, apps: [{ itemId: 'app', app }] };
    const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
        getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
        getText: async () => { throw new Error('No selected text fetch'); }, getBytes: async () => { throw new Error('No selected binary fetch'); },
    } });
    phase = 'registry_selection';
    const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
        sourceId: 'apps', kind: 'app', itemId: 'app' })).item;
    if (selected.payload.kind !== 'app') throw new Error('Expected app producer output');
    const { origin: _origin, removable: _removable, ...sourceRow } = source;
    const rows = PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
        key, revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key,
            value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null,
    })) });
    let defaultsRevision = 1;
    let projectOwner: ProjectSourceOwnerV1 = { kind: 'account', accountId: 'owner' };
    let sourceRevision = 2;
    let canManageSource = true;
    let registrySourceReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
        expect(String(url)).toBe(source.url);
        return new Response(JSON.stringify(catalog), { status: 200 });
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (url.endsWith('/v1/account/entity-rows/prompt-library')) {
            registrySourceReads++;
            return { status: 200, data: rows };
        }
        if (url.endsWith('/v1/artifacts/defaults')) return { status: 200, data: { id: 'defaults', ownerAccountId: 'owner', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: 'project-deployment-defaults.v1', title: 'Defaults' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ projectSourceId: 'project', deploymentDefaults: { retainPreviousDeployments: 0 } }) }),
            headerVersion: 1, bodyVersion: defaultsRevision, seq: 1, createdAt: 1, updatedAt: 1 } };
        throw new Error('Unexpected Account transport');
    });
    let mutationRequests = 0;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (url.endsWith('/v1/plugins/availability/intents/list')) {
            const { knownPluginIds: pluginIds = [] } = PluginAvailabilityIntentsListActionInputV1Schema.parse(body);
            return { status: 200, data: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
                pluginIds, failedPluginIds: [], intentReads: pluginIds.map(pluginId => ({ pluginId, response: {
                    availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [],
                } })) }) };
        }
        mutationRequests += 1;
        throw new Error('No HTTP mutation during setup review');
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.method !== 'GET') { mutationRequests += 1; throw new Error('No HTTP mutation during setup review'); }
        if (request.url?.includes('/v1/projects/sources/project')) return { status: 200, data: { ok: true, canManage: canManageSource,
            source: { id: 'project', revision: sourceRevision, name: 'Project', owner: projectOwner, audience: [], createdByAccountId: 'owner' } } };
        if (request.url?.includes('/v1/projects/project/deployment-defaults')) return { status: 200, data: ProjectDeploymentDefaultsOutputV1Schema.parse({
            ok: true, projectSourceId: 'project', sourceRevision: 2, revision: defaultsRevision,
            content: { contentArtifactId: 'defaults', contentHeaderVersion: 1, contentBodyVersion: defaultsRevision } }) };
        throw new Error('Unexpected Project transport');
    });
    const proposed: unknown[] = [];
    let current: ReturnType<typeof createDeploymentEnvironmentDetailV1> | undefined;
    const artifacts = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => 'plain' });
    const templates = createDeploymentTemplateInstantiationForHost({ credentials, serverId: 'home', machineId: 'target',
        readInstallation: async () => identity.installationId,
        serverHttpBaseUrl: 'https://home.test', savedSecretOperationContext: operation, assertCurrent: async () => {},
        readMachineVitals: () => sample,
        headers: async () => ({ Authorization: `Bearer ${token}` }),
        storage: async () => { throw new Error('No storage effect after interrupted Artifact write'); },
        readEnvironment: async () => { if (current) return current; throw new Error('No existing Environment'); },
        readCreationDefaultInputs: request => readDeploymentCreationDefaultInputsForHost(request, { serverId: 'home',
            serverHttpBaseUrl: 'https://home.test', accountId: 'owner', expectedScopeKey: scopeKey,
            assertCurrent: async () => {}, headers: async () => ({ Authorization: `Bearer ${token}` }),
            open: (id, context) => artifacts.read(id, { signal: context.signal, prepareRecipients: false, includeSharedAudience: false }),
            readAccountSnapshot: operation.readSnapshot }),
        createContent: async content => { proposed.push(content); throw new Error('Interrupted at Artifact persistence'); },
    });
    const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', serverId: 'home', machineId: 'target',
        projectSourceId: 'project', templateRef: { sourceId: 'apps', itemId: 'app', version: selected.summary.version!, ref: selected.payload.ref },
        environment: { kind: 'create', name: 'App', requestKey: 'create-app', protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: 'target' }, target: { kind: 'new', installationId: identity.installationId },
        destination: { kind: 'stored' }, bindings: [] });
    let sampleReads = 0;
    let sample = MachineVitalsSampleV1Schema.parse({ v: 1, sampledAt: 100, intervalMs: 1000,
        cpu: { reported: false, reason: 'unavailable' }, disk: { reported: false, reason: 'unavailable' },
        network: { reported: false, reason: 'unavailable' }, memory: { reported: true, totalBytes: 1024,
            availableBytes: 512, usedBytes: 512, pressure: { level: 'calm', source: 'none' } } });
    const deps = createDaemonDeploymentActionDeps({
        resolveRequesterIdentity: async () => requesterIdentity,
        credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
        machineId: 'target', savedSecretOperationContext: operation, readMachineVitals: () => { sampleReads += 1; return sample; },
        runtime: { async acquire() { throw new Error('Preview cannot acquire native custody'); } } });
    phase = 'template_preview';
    const credentialed = createCliActionExecutorFromCredentials({ credentials, ...deps,
        serverId: 'home', serverIdentityId: 'home', serverApiUrl: 'https://home.test',
        pluginActionExecutionOwner: 'current_process', savedSecretOperationContext: operation,
        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
    const executedPreview = await credentialed.execute('deployments.templates.instantiate', { ...input, mode: 'preview' },
        { surface: 'cli', runtimeAccountId: 'owner', actionCaller: { kind: 'host' } });
    expect(executedPreview).toMatchObject({ ok: true, result: { kind: 'preview' } });
    if (!executedPreview.ok) throw new Error(executedPreview.errorCode);
    const preview = executedPreview.result;
    expect.soft(DeploymentTemplateInstantiateResultV1Schema.parse(preview)).toMatchObject({ kind: 'preview', review: { firstRunSetup: true, capacity: [
        { resource: 'memoryBytes', observedBytes: 1024, observedAt: 100, state: 'shortfall' },
        { resource: 'freeDiskBytes', observedBytes: null, observedAt: null, state: 'unknown' },
    ] } });
    expect(sampleReads).toBe(1);
    expect(await credentialed.prepare('deployments.templates.instantiate', { ...input,
        environment: { ...input.environment, controllerMachineId: 'another-machine' } },
        { surface: 'cli', runtimeAccountId: 'owner', actionCaller: { kind: 'host' } }))
        .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'target_mismatch' } });
    // Registry execution owns source admission. Preview does not reread the
    // Account catalog to re-admit the already selected immutable payload.
    expect.soft(registrySourceReads).toBe(1);
    let workflowRequests = 0;
    const setup = createCombinedMachineSetupActionDeps({
        // A routing host has no target P45 preparer; only its target Plan does.
        readDeps: createUnavailableActionTransportDeps,
        // App-root review rechecks the target Plan against persisted Machine state.
        targetPlan: createMachineSetupPlanAction({ homeId: 'home', machineId: 'target', apiMachine: {
            getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
                read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
                compareAndSwap: async () => { mutationRequests += 1; throw new Error('Review cannot write Machine metadata'); },
            }),
        }, appPreparation: {
            prepareDeploymentTemplateInstantiation: deps.prepareDeploymentTemplateInstantiation,
            deploymentAction: deps.deploymentAction,
            readArtifact: deps.readSetupAppArtifact,
        } }),
        readHostFacts: async () => ({ machines: [{ machineId: 'routing-host', online: true }, { machineId: 'target', online: true }] }),
        orchestrationDirectory: '/setup-review',
        startCombined: async () => { workflowRequests += 1; throw new Error('Review cannot start a Workflow'); },
        waitForRun: async () => { workflowRequests += 1; throw new Error('Review cannot wait for a Workflow'); },
        readInvocations: async () => { workflowRequests += 1; throw new Error('Review cannot read child results'); },
    });
    const setupInput = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'routing-host', targets: [{
        homeId: 'home', machineId: 'target', desiredRevision: 0, recipePlans: [], exclusions: [],
        sources: [{ kind: 'direct', setup: {} },
            { kind: 'accountPreset', presetId: 'app-preset', presetRevision: 4, setup: { items: [{ kind: 'app', definition: {
            name: 'App', project: { kind: 'existing', projectSourceId: 'project' },
            definition: { from: 'catalogApp', templateRef: input.templateRef }, bindings: [],
        } }] } }], appChildren: [{ sourceIndex: 1, itemIndex: 0, actionId: 'deployments.templates.instantiate',
            input: DeploymentTemplateInstantiateInputV1Schema.parse({ ...input, deploy: { requestKey: 'setup-app-deploy' } }) }],
    }] });
    phase = 'setup_review';
    expect(await setup.prepareMachineSetupApply!({ input: setupInput, context: { runtimeAccountId: 'owner' } }))
        .toMatchObject({ preview: { appReviews: [{ targetIndex: 0, homeId: 'home', machineId: 'target', sourceIndex: 1,
            itemIndex: 0, actionId: 'deployments.templates.instantiate', review: {
                firstRunSetup: true,
                creationDefaults: { values: { retainPreviousDeployments: 0 }, sources: { retainPreviousDeployments: 'project' } },
                capacity: [{ resource: 'memoryBytes', observedBytes: 1024, state: 'shortfall' },
                    { resource: 'freeDiskBytes', observedBytes: null, state: 'unknown' }],
            } }] } });
    expect(sampleReads).toBe(2);
    expect(workflowRequests).toBe(0);
    expect(mutationRequests).toBe(0);
    expect(proposed).toHaveLength(0);
    // The confirming person approves these exact observed facts, including the
    // Project defaults owner's revision even when its effective value is equal.
    for (const path of ['prepared', 'durableAsk'] as const) for (const changed of ['capacity', 'defaultsRevision', 'observationTime'] as const) {
        defaultsRevision = 1;
        sample = { ...sample, sampledAt: 100, memory: { reported: true, totalBytes: 1024, availableBytes: 512,
            usedBytes: 512, pressure: { level: 'calm', source: 'none' } } };
        const mutationsBefore = mutationRequests;
        let stored: ApprovalRequestV2 | undefined;
        // Approval persistence is the external boundary; the installed registry,
        // defaults, preparation and replay owners remain real on both paths.
        const approvalStorage = {
            approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(structuredClone(request)); return { artifactId: 'review' }; },
            approvalsGet: async () => stored ?? null,
            approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true as const }; },
            isApprovalExecutionOriginCurrent: async () => true,
        } satisfies Pick<ActionExecutorDeps, 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate' | 'isApprovalExecutionOriginCurrent'>;
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps, ...approvalStorage });
        phase = `approval_prepare:${path}:${changed}`;
        const prepared = await executor.prepare('deployments.templates.instantiate', input, {
            surface: path === 'prepared' ? 'ui' : 'cli', authority: path === 'prepared' ? 'present_user' : 'account_automation',
            actionCaller: { kind: 'host' }, serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'owner',
            actionRequestId: `review-${path}-${changed}`, executionRunTargetMachineId: 'target',
        });
        if (path === 'prepared') {
            expect(prepared.kind).toBe('ready');
            if (prepared.kind !== 'ready') throw new Error('Expected reviewed template invocation');
        } else {
            const open = ApprovalRequestV2Schema.parse(stored);
            expect(open.preview).toMatchObject({ deploymentReview: { firstRunSetup: true,
                capacity: [{ resource: 'memoryBytes', observedBytes: 1024 },
                    { resource: 'freeDiskBytes', observedBytes: null }],
                creationDefaultsBasis: { projectDefaultsRevision: 1 } } });
            const approved = ApprovalRequestV2Schema.parse({ ...open, status: 'approved', updatedAtMs: open.updatedAtMs + 1,
                decision: { kind: 'approve', authority: 'present_user', decidedAtMs: open.updatedAtMs + 1 } });
            expect(decideApprovalRequestTransition(open, approved)).toMatchObject({ ok: true });
            stored = approved;
        }
        if (changed === 'capacity') sample = { ...sample, memory: { reported: false, reason: 'unavailable' } };
        else if (changed === 'defaultsRevision') defaultsRevision = 2;
        else sample = { ...sample, sampledAt: 200 };
        phase = `approval_apply:${path}:${changed}`;
        const result = path === 'prepared' && prepared.kind === 'ready' ? await prepared.invocation.run()
            : await executor.replayApprovedApprovalRequest({ artifactId: 'review', callerAuthority: 'present_user',
                currentAccount: { accountId: 'owner', serverId: 'home', serverIdentityId: 'srv_home' } });
        if (path === 'prepared' || changed === 'observationTime') {
            // A finite prepared invocation consumes its admitted facts. Durable
            // replay admits again; unchanged capacity still reaches the write.
            expect.soft(mutationRequests).toBe(mutationsBefore + 1);
        } else {
            expect.soft(path === 'prepared' ? result : stored?.execution).toMatchObject({ ok: false, errorCode: 'approval_stale' });
            expect.soft(mutationRequests).toBe(mutationsBefore);
        }
    }
    defaultsRevision = 1;
    const mutationsAfterApplyControls = mutationRequests;
    // Changing the external catalog cannot reuse the previously admitted app facts.
    const catalogFetch = vi.mocked(globalThis.fetch);
    catalogFetch.mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 1, apps: [] }), { status: 200 }));
    phase = 'setup_changed_catalog';
    expect(await setup.prepareMachineSetupApply!({ input: setupInput, context: { runtimeAccountId: 'owner' } }))
        .toMatchObject({ ok: false });
    expect(workflowRequests).toBe(0);
    expect(mutationRequests).toBe(mutationsAfterApplyControls);
    expect(proposed).toHaveLength(0);
    expect(DeploymentTemplateInstantiateResultV1Schema.parse(preview)).toMatchObject({ kind: 'preview', review: {
        creationDefaults: { values: { retainPreviousDeployments: 0 }, sources: { retainPreviousDeployments: 'project', controllerMachineId: 'explicit' } },
    } });
    expect(proposed).toHaveLength(0);
    if (!('kind' in preview) || preview.kind !== 'preview') throw new Error('Expected template review');
    sample = { ...sample, memory: { reported: false, reason: 'unavailable' } };
    // The semantic host rechecks after the generic owner's final preparation,
    // before entropy or Artifact writes. Ordinary unreviewed direct execution
    // below still uses its own freshly admitted facts.
    phase = 'semantic_review_currentness';
    expect(await templates.instantiate(input, { runtimeAccountId: 'owner' }, preview.review))
        .toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
    expect(proposed).toHaveLength(0);
    phase = 'account_content_write';
    await runWithServerHttpBaseUrl('https://home.test', () => templates.instantiate(input, { runtimeAccountId: 'owner' }));
    expect(proposed).toHaveLength(1);
    expect(DeploymentEnvironmentContentV1Schema.parse(proposed[0]).retainPreviousDeployments).toBe(0);
    expect(DeploymentEnvironmentContentV1Schema.parse(proposed[0]).ownServer).toEqual({
        rollout: 'recreate', autoRestorePreviousRelease: true, backupBeforeMigration: true, migrationFailurePolicy: 'ask', serviceExports: [],
    });
    // A template may add only metadata to an existing valid Compose definition.
    // The definition sub-revision must describe the output, not the invocation.
    current = createDeploymentEnvironmentDetailV1();
    current.environment.projectSourceId = 'project';
    current.environment.controllerMachineId = 'target';
    current.content = DeploymentEnvironmentContentV1Schema.parse(proposed[0]);
    const runtimeTargetLinkId = current.environment.runtimeTargetLinkId;
    const link = current.targetLinks.find(item => item.targetLink.id === runtimeTargetLinkId)!.targetLink;
    link.machines = ['target'];
    link.members = [{ machineId: 'target', installationId: identity.installationId, state: 'active' }];
    const incumbent = current.content.definition;
    if (incumbent.kind !== 'stored') throw new Error('Expected prepared stored definition');
    for (const changed of [false, true]) {
        phase = `existing_definition:${changed}`;
        catalog.apps[0].app = DeploymentTemplateV1Schema.parse({ ...app, compose: {
            document: changed ? 'services:\n  worker:\n    image: busybox:1\n' : 'services: {}\n', profiles: [], services: [] } });
        const selectedAgain = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
            sourceId: 'apps', kind: 'app', itemId: 'app' })).item;
        if (selectedAgain.payload.kind !== 'app') throw new Error('Expected app producer output');
        await templates.instantiate(DeploymentTemplateInstantiateInputV1Schema.parse({ ...input,
            templateRef: { ...input.templateRef, version: selectedAgain.summary.version!, ref: selectedAgain.payload.ref },
            environment: { kind: 'existing', environmentId: current.environment.id, expectedRevision: current.environment.revision },
            target: { kind: 'existing', targetLinkId: link.id, expectedRevision: link.revision, installationId: identity.installationId },
            destination: { kind: 'stored', contentRevision: incumbent.contentRevision, composeDigest: incumbent.composeDigest },
        }), { runtimeAccountId: 'owner' });
        expect(proposed).toHaveLength(changed ? 3 : 2);
        expect(DeploymentEnvironmentContentV1Schema.parse(proposed.at(-1)).definition)
            .toMatchObject({ kind: 'stored', contentRevision: incumbent.contentRevision + (changed ? 1 : 0) });
    }
    // Continue through the installed factory and HTTP boundary for a Team Source.
    // All regenerated content, including target and binding/template rewrites,
    // must retain the Source principal rather than the individual author.
    projectOwner = { kind: 'team', teamId: 'template-team' };
    catalog.apps[0].app = app;
    const originalGet = vi.mocked(axios.get).getMockImplementation()!;
    const originalRequest = vi.mocked(axios.request).getMockImplementation()!;
    const documents = new Map<string, Record<string, unknown>>();
    const grants = new Map<string, unknown>();
    const createdIds = new Set<string>();
    let afterContentCreate: (() => void) | undefined;
    let storageMutations = 0;
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        const row = documents.get(decodeURIComponent(new URL(url).pathname.split('/').at(-1)!));
        return row ? { status: 200, data: row } : originalGet(url, config);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, value) => {
        expect(url).toBe('https://home.test/v1/artifacts');
        const mutation = readCarrierMutation(value);
        const id = String(mutation.id);
        createdIds.add(id);
        documents.set(id, { ...mutation, id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
            encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        afterContentCreate?.();
        return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
    });
    vi.spyOn(axios, 'put').mockImplementation(async (url, value) => {
        const mutation = readCarrierMutation(value);
        const artifactId = String(mutation.artifactId);
        expect(url).toBe(`https://home.test/v1/artifacts/${artifactId}/access/grants`);
        grants.set(artifactId, { principal: mutation.principal, accessLevel: mutation.accessLevel });
        return { status: 200, data: { artifactId, ownerAccountId: 'owner', access: 'owner', changed: true,
            grants: [{ principal: mutation.principal, accessLevel: mutation.accessLevel, createdByAccountId: 'owner',
                createdAt: 1, display: { name: null } }] } };
    });
    for (const kind of ['create', 'existing'] as const) {
        const sourceReadsBefore = registrySourceReads;
        // An unrelated Project edit after the first admitted content write
        // cannot retire the finite install or its reviewed Team audience.
        afterContentCreate = () => { afterContentCreate = undefined; sourceRevision++; };
        const deployerPrincipals = [{ principalKind: 'account' as const, principalId: 'teammate' },
            { principalKind: 'teamGroup' as const, principalId: 'deployers' }];
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.projectSourceId = 'project';
        environment.environment.owner = projectOwner;
        environment.environment.controllerMachineId = 'target';
        environment.environment.buildMachineId = 'target';
        const { template: _previousTemplate, ...baseContent } = DeploymentEnvironmentContentV1Schema.parse(proposed[0]);
        // Applying another template must retain the database already running in the definition.
        environment.content = kind === 'create' ? DeploymentEnvironmentContentV1Schema.parse(proposed[0])
            : DeploymentEnvironmentContentV1Schema.parse({ ...baseContent,
                template: { templateRef: { ...input.templateRef, itemId: 'postgres' }, services: ['postgres'],
                    definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` },
                    data: { engine: 'postgres', service: 'postgres', port: 5432 } },
                definition: await normalizeStoredComposeDefinitionInput({
                    from: 'compose', document: 'services:\n  postgres:\n    image: postgres:17\n', profiles: [], services: ['postgres'],
                }) });
        const link = environment.targetLinks[0]!;
        link.targetLink.machines = ['target'];
        link.targetLink.members = [{ machineId: 'target', installationId: identity.installationId, state: 'active' }];
        documents.set(environment.environment.contentArtifactId, { id: environment.environment.contentArtifactId, ownerAccountId: 'owner', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Template' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(environment.content) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        environment.targetLinks = [];
        delete environment.environment.runtimeTargetLinkId;
        let bindingWrites = 0;
        let templateWrites = 0;
        let receivedCreatePolicy: ReturnType<typeof DeploymentEnvironmentCreateInputV1Schema.parse> | undefined;
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            if (path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [],
                bindingPreparation: { runtimeInstallations: [{ machineId: 'target', installationId: identity.installationId,
                    publicKey: identity.publicKey }], buildInstallation: { machineId: 'target', installationId: identity.installationId,
                    publicKey: identity.publicKey } } } };
            if (request.method === 'GET' && path.includes('/v1/deployments/environments/')) return { status: 200,
                data: { ok: true, environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
            if (request.method === 'GET') return originalRequest(request);
            storageMutations++;
            const body = readCarrierMutation(request.data);
            if (path === '/v1/deployments/environments') {
                receivedCreatePolicy = DeploymentEnvironmentCreateInputV1Schema.parse(body);
            }
            if (path.endsWith('/targets')) {
                link.targetLink.contentArtifactId = String(body.contentArtifactId);
                environment.targetLinks = [link];
                environment.environment.runtimeTargetLinkId = link.targetLink.id;
                environment.environment.revision++;
                return { status: 200, data: DeploymentTargetLinkResultV1Schema.parse({ ok: true, environmentId: environment.environment.id,
                    targetLinkId: link.targetLink.id, targetLinkRevision: link.targetLink.revision,
                    revision: environment.environment.revision }) };
            }
            if (!grants.has(String(body.contentArtifactId))) return { status: 400,
                data: { ok: false, error: 'deployment_content_unavailable' } };
            environment.environment.contentArtifactId = String(body.contentArtifactId);
            environment.environment.contentHeaderVersion = Number(body.contentHeaderVersion);
            environment.environment.contentBodyVersion = Number(body.contentBodyVersion);
            environment.environment.revision++;
            if (path === '/v1/deployments/environments') {
                const policy = DeploymentEnvironmentCreateInputV1Schema.parse(body);
                environment.environment.deployerMode = policy.deployerMode;
                environment.environment.deployerPrincipals = policy.deployerPrincipals;
            }
            if (body.firstTargetLink) {
                const first = readCarrierMutation(body.firstTargetLink);
                if (!grants.has(String(first.contentArtifactId))) return { status: 400,
                    data: { ok: false, error: 'deployment_content_unavailable' } };
                link.targetLink.contentArtifactId = String(first.contentArtifactId);
                environment.targetLinks = [link];
                environment.environment.runtimeTargetLinkId = link.targetLink.id;
            }
            if (path.endsWith('/bindings')) bindingWrites++;
            if (path.endsWith('/template')) templateWrites++;
            return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision } };
        });
        const definition = environment.content.definition;
        if (definition.kind !== 'stored') throw new Error('Expected stored template fixture');
        phase = `team_content_apply:${kind}`;
        if (input.environment.kind !== 'create') throw new Error('Expected the authored creation fixture');
        const result = await deps.deploymentTemplateInstantiate({ ...input,
            environment: kind === 'create' ? { ...input.environment, deployerMode: 'chosen', deployerPrincipals }
                : { kind: 'existing', environmentId: environment.environment.id,
                expectedRevision: environment.environment.revision },
            destination: kind === 'create' ? input.destination : { kind: 'stored', contentRevision: definition.contentRevision,
                composeDigest: definition.composeDigest } }, { runtimeAccountId: 'owner', actionRequestId: `template-${kind}` });
        const failurePhase = 'kind' in result && result.kind === 'partial'
            ? `template ${kind}: ${result.phase}/${result.errorCode}` : undefined;
        // The real HTTP create must retain the reviewed authority operands,
        // even when an independent Artifact-admission check refuses apply.
        if (kind === 'create') expect(receivedCreatePolicy).toMatchObject({ deployerMode: 'chosen', deployerPrincipals });
        expect(result, failurePhase).toMatchObject({ kind: 'applied', environmentId: environment.environment.id });
        if (kind === 'create') expect(environment.environment).toMatchObject({ deployerMode: 'chosen', deployerPrincipals });
        expect(bindingWrites).toBe(1);
        expect(templateWrites).toBe(kind === 'existing' ? 1 : 0);
        if (kind === 'existing') {
            const opened = await runWithServerHttpBaseUrl('https://home.test', () => createAccountArtifactStore({ credentials,
                // This HTTP fixture authors plain Account artifacts above.
                getAccountEncryptionMode: async () => 'plain' })
                .read(environment.environment.contentArtifactId));
            const stored = DeploymentEnvironmentContentV1Schema.parse(JSON.parse(opened!.body!));
            expect(stored.template?.data).toEqual([{ engine: 'postgres', service: 'postgres', port: 5432 }]);
            expect(stored.definition.kind === 'stored' && stored.definition.services).toEqual(['postgres', 'web']);
        }
        expect.soft(registrySourceReads - sourceReadsBefore).toBe(1);
    }
    expect(createdIds.size).toBe(7);
    for (const id of createdIds) expect(grants.get(id)).toEqual({ principal: projectOwner, accessLevel: 'admin' });
    // A finite install retains the Project audience and Manage authority from
    // admission, even if either changes after its first content write.
    for (const change of ['owner', 'manage'] as const) {
        projectOwner = { kind: 'team', teamId: 'template-team' };
        sourceRevision = 2;
        canManageSource = true;
        const grantsBefore = grants.size;
        const mutationsBefore = storageMutations;
        const sourceReadsBefore = registrySourceReads;
        const admittedOwner = projectOwner;
        afterContentCreate = () => {
            afterContentCreate = undefined;
            if (change === 'owner') projectOwner = { kind: 'team', teamId: 'other-team' };
            else canManageSource = false;
        };
        phase = `writer_currentness:${change}`;
        const result = await deps.deploymentTemplateInstantiate(input, {
            runtimeAccountId: 'owner', actionRequestId: `template-stale-${change}`,
        });
        expect(result).toMatchObject({ kind: 'applied' });
        expect(registrySourceReads - sourceReadsBefore).toBe(1);
        expect(grants.size).toBe(grantsBefore + 3);
        for (const grant of [...grants.values()].slice(grantsBefore)) expect(grant).toEqual({ principal: admittedOwner, accessLevel: 'admin' });
        expect(storageMutations).toBe(mutationsBefore + 2);
    }
});

it('exposes a read-only template preview and one reviewed apply through the installed Action composition', async () => {
    const spec = listActionSpecsForSurface('agent').find(row => String(row.id) === 'deployments.templates.instantiate');
    expect(spec, 'Template instantiation must enter the canonical Action executor').toBeDefined();
    if (!spec) return;
    expect(spec.executionPlacement).toBe('machine');
    expect(spec.serverTransport).toBeUndefined();
    const input = { mode: 'preview', serverId: 'home', machineId: 'target', projectSourceId: 'source',
        templateRef: { sourceId: 'builtin:apps', itemId: 'app', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
        environment: { kind: 'create', name: 'App', requestKey: 'create-app', protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'target' },
        target: { kind: 'new', installationId: 'installed' }, destination: { kind: 'stored' }, bindings: [] };
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input, context: { surface: 'agent' } }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input: { ...input, mode: 'apply' },
        context: { surface: 'agent' } }).required).toBe(true);
    const requesterIdentity = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'home',
        hostAccountAutomation: { accountId: 'owner', custodianAccountId: 'owner', machineId: 'target', installationId: 'installed' } });
    const deps = createDaemonDeploymentActionDeps({
        resolveRequesterIdentity: async () => requesterIdentity,
        credentials: { token: 'fixture', encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'target',
        runtime: { async acquire() { throw new Error('Preview cannot acquire native mutation custody'); } } });
    expect(typeof Reflect.get(deps, 'deploymentTemplateInstantiate')).toBe('function');
    // This installed deployment composition does not mount unrelated Action domains.
    const result = await createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps }).execute(spec.id, {
        ...input, environment: { ...input.environment, controllerMachineId: 'foreign' } }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_mismatch' });
});

it('keeps reserved template provenance behind its sole writer at the opened-content boundary', async () => {
    const current = createDeploymentEnvironmentDetailV1();
    const candidate = DeploymentEnvironmentContentV1Schema.parse({ ...current.content, template: {
        templateRef: { sourceId: 'builtin:apps', itemId: 'app', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
        definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, services: ['app'],
    } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        const candidateRead = url.endsWith('/candidate');
        return { status: 200, data: { id: candidateRead ? 'candidate' : current.environment.contentArtifactId,
            ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'App' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(candidateRead ? candidate : current.content) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true,
        environment: current.environment, targetLinks: current.targetLinks.map(item => item.targetLink) } });
    const prepare = createPrepareEnvironmentContentForHost({ credentials: { token: 'fixture', encryption: null },
        serverHttpBaseUrl: 'https://home.test', resolveRequestHeaders: async () => ({ Authorization: 'Bearer fixture' }) });
    expect(await prepare({ actionId: 'deployments.environments.update', input: { serverId: 'home',
        environmentId: current.environment.id, expectedRevision: current.environment.revision,
        contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 }, context: {} }))
        .toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
});
