import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentTemplateInstantiationForHost } from './instantiate';
import { createRegistryHostV1, DeploymentTemplateV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { accountSettingsParse, DeploymentTemplateInstantiateInputV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema } from '@happier-dev/protocol';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
afterEach(() => vi.restoreAllMocks());

it.each(['template', 'environment'] as const)('retains generated secret outcomes through the %s entry and refuses a fresh disabled-source request', async entry => {
    const fixture = await createSavedSecretsCliHttpFixture();
    try {
        const credentials = await fixture.deps.readCredentialsFn?.();
        if (!credentials) throw new Error('Fixture credentials unavailable');
        const identity = await readOrCreateInstallationIdentity();
        const secretKeys = ['APP_PASSWORD', 'DB_PASSWORD', 'ADMIN_PASSWORD'];
        const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
            document: `services:\n  web:\n    image: nginx:1\n    environment:\n${secretKeys.map(key => `      ${key}: \${${key}}\n`).join('')}`,
            profiles: [], services: ['web'] },
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
            serverHttpBaseUrl: fixture.origin, savedSecretOperationContext: operation, assertCurrent: async () => {},
            headers: async () => ({ Authorization: `Bearer ${credentials.token}` }),
            storage: async () => { throw new Error('Interrupted before Environment storage'); },
            readEnvironment: async () => { throw new Error('No existing Environment'); }, readCreationDefaultInputs: async () => ({}),
            createContent: async () => { throw Object.assign(new Error('content_boundary_interrupted'), { code: 'content_boundary_interrupted' }); },
        });
        const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', serverId: 'home', machineId: 'target',
            projectSourceId: 'project', templateRef: { sourceId: 'apps', itemId: 'app', version: selected.summary.version!, ref: selected.payload.ref },
            environment: { kind: 'create', name: 'App', requestKey: 'generated-app', protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: 'target' }, target: { kind: 'new', installationId: identity.installationId },
            destination: { kind: 'stored' }, generatedSecretAudience: { teamGrants: ['team-reviewed'] },
            bindings: secretKeys.map(name => ({ purpose: 'variable', name, phase: 'runtime', source: { kind: 'generated', key: name } })) });
        expect(await fixture.inHome(() => templates.instantiate({ ...input, templateRef: { ...input.templateRef,
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } } }, { runtimeAccountId: 'account-cli-fixture' })))
            .toMatchObject({ ok: false, errorCode: 'template_changed' });
        expect(fixture.writes).toEqual([]);
        sourceReads = 0;
        const result = await fixture.inHome(() => entry === 'template'
            ? templates.instantiate(input, { runtimeAccountId: 'account-cli-fixture' })
            : templates.instantiateCreate(DeploymentEnvironmentCreateIntentInputV1Schema.parse({
                mode: 'apply', serverId: input.serverId, projectSourceId: input.projectSourceId,
                name: 'App', requestKey: 'generated-app', protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: 'target',
                definition: { from: 'catalogApp', templateRef: input.templateRef },
                firstTargetLink: { machines: [{ machineId: 'target', installationId: identity.installationId }] },
                bindings: input.bindings, generatedSecretAudience: input.generatedSecretAudience,
            }), { runtimeAccountId: 'account-cli-fixture' }));
        const partial = entry === 'template' ? result : 'details' in result ? result.details : undefined;
        if (entry === 'environment') expect.soft(result).toMatchObject({ ok: false,
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
            .toMatchObject({ ok: false, errorCode: 'invalid_source' });
        expect(fixture.writes).toHaveLength(secretKeys.length);
    } finally { await fixture.close(); }
});
