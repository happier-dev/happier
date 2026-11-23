import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, createActionExecutor } from '@happier-dev/protocol';
import { createRegistryHostV1, DeploymentTemplateV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
    type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';
import { readBundledPluginAvailabilityHttpFixture } from '@/plugins/testkit/bundledPluginAvailabilityHttpFixture';

afterEach(() => vi.restoreAllMocks());

it.each(['happier-catalog', 'coolify-templates', 'dokploy-templates'] as const)('prepares or returns review for an exact %s app through the public Publish read Action', async format => {
    const identity = await readOrCreateInstallationIdentity();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const scopeKey = runWithServerHttpBaseUrl('https://home.test', () => resolveAccountSettingsScopeKey(credentials));
    const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://home.test',
        snapshot: { source: 'network', settings: accountSettingsParse({ deploymentDefaultsV1: {
            controllerMachineId: 'account-controller', retainPreviousDeployments: 7,
        } }), settingsVersion: 1, loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
    const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format, kinds: ['app'],
        url: format === 'coolify-templates' ? 'https://github.com/publish-preparation/catalog'
            : format === 'dokploy-templates' ? 'https://apps.test/meta.json' : 'https://apps.test/catalog.json',
        enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
    const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
        document: 'services:\n  web:\n    image: nginx:1\n', profiles: [], services: ['web'] },
        variables: [{ key: 'PASSWORD', label: 'Password', valueKind: 'string', required: true, secret: true, sites: [] }],
        generatedSecrets: [], domains: [], volumes: [], firstRunSetup: true });
    const commit = 'c'.repeat(40);
    const plausibleCompose = 'services:\n  plausible:\n    image: plausible/analytics:1\n    env_file: ./plausible.env\n';
    const catalog = format === 'coolify-templates' ? { app: { name: 'App', slogan: 'Status' } }
        : format === 'dokploy-templates' ? [{ id: 'plausible', name: 'Plausible' }, { id: 'other', name: 'Other' }]
        : { schemaVersion: 1, apps: [{ itemId: 'app', app }] };
    const bodyReads: string[] = [];
    const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
        getJson: async url => ({ ok: true, value: url.includes('/commits/') ? { sha: commit } : catalog, fetchedAt: 1 }),
        getText: async url => {
            bodyReads.push(new URL(url).pathname);
            return { ok: true, value: format === 'dokploy-templates'
                ? (url.endsWith('.toml') ? '' : plausibleCompose) : app.compose.document, fetchedAt: 1 };
        },
        getBytes: async () => { throw new Error('No selected binary fetch'); },
    } });
    const { origin: _origin, removable: _removable, ...sourceRow } = source;
    const rows = PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
        key, revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key,
            value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null,
    })) });
    let owner: { kind: 'account'; accountId: string } | { kind: 'team'; teamId: string } = { kind: 'account', accountId: 'owner' };
    const mutations: string[] = [];
    const requests: string[] = [];
    const upstream: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
        upstream.push(String(url));
        if (format === 'coolify-templates') {
            expect(String(url)).toContain(`/publish-preparation/catalog/${commit}/templates/`);
            if (String(url).endsWith('/app.yaml')) return new Response(app.compose.document);
        } else if (format === 'dokploy-templates' && String(url) !== source.url) {
            if (String(url) === 'https://apps.test/blueprints/plausible/docker-compose.yml') return new Response(plausibleCompose);
            if (String(url) === 'https://apps.test/blueprints/plausible/template.toml') return new Response('');
            throw new Error(`Unexpected Dokploy fetch: ${String(url)}`);
        } else expect(String(url)).toBe(source.url);
        return new Response(JSON.stringify(catalog), { status: 200 });
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        requests.push(String(url));
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (url.endsWith('/v1/account/entity-rows/prompt-library')) return { status: 200, data: rows };
        throw new Error('Unexpected Account transport');
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        requests.push(String(request.url));
        if (request.method !== 'GET') { mutations.push(String(request.url)); throw new Error('Preparation may not write'); }
        if (request.url?.includes('/v1/projects/sources/project')) return { status: 200, data: { ok: true, canManage: true,
            source: { id: 'project', revision: 2, name: 'Project', owner, audience: [], createdByAccountId: 'owner' } } };
        if (request.url?.includes('/v1/projects/project/deployment-defaults')) return { status: 200, data: {
            ok: true, projectSourceId: 'project', sourceRevision: 2, revision: 0, content: null } };
        throw new Error('Unexpected Project transport');
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const availability = readBundledPluginAvailabilityHttpFixture(new URL(String(url)).pathname, body);
        if (availability !== undefined) return { status: 200, data: availability };
        mutations.push(String(url));
        throw new Error('Preparation may not write');
    });
    const deps = createDaemonDeploymentActionDeps({
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
        credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
        machineId: 'target', savedSecretOperationContext: operation,
        runtime: { async acquire() { throw new Error('Preparation may not acquire native custody'); } } });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
        registryActionExecute: ({ actionId, input }) => registry.execute(actionId, input) });
    const context = { surface: 'cli' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const },
        serverId: 'home', runtimeAccountId: 'owner', actionRequestId: 'catalog-entry' };
    const read = { sourceId: 'apps', kind: 'app' as const, itemId: format === 'dokploy-templates' ? 'plausible' : 'app' };
    if (format === 'dokploy-templates') {
        expect(await executor.execute('deployments.suggestions.catalog', {}, context)).toMatchObject({
            ok: true, result: { apps: expect.arrayContaining([{ id: '["apps","plausible"]', sourceId: 'apps', itemId: 'plausible', title: 'Plausible' }]) },
        });
        expect(bodyReads).toEqual([]);
    }
    const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', read)).item;
    if (selected.payload.kind !== 'app' || !selected.summary.version) throw new Error('Expected pinned app producer output');
    const input = { serverId: 'home', machineId: 'target', installationId: identity.installationId,
        projectSourceId: 'project', sourceRevision: 2,
        templateRef: { sourceId: read.sourceId, itemId: read.itemId, version: selected.summary.version, ref: selected.payload.ref } };
    const prepared = await executor.execute('deployments.publish.prepare', input, context);
    if (format === 'dokploy-templates') {
        expect(bodyReads.sort()).toEqual(['/blueprints/plausible/docker-compose.yml', '/blueprints/plausible/template.toml']);
        expect(prepared).toMatchObject({ ok: false, errorCode: 'template_needs_review', details: {
            diagnostics: [{ field: 'services.plausible.env_file', reason: 'sidecar_file_requires_review' }],
            nextAction: { actionId: 'registries.items.read', input: { ...read, version: selected.summary.version } },
        } });
        expect(await executor.execute('deployments.publish.prepare', { ...input, templateRef: { ...input.templateRef,
            ref: { kind: 'content', digest: `sha256:${'b'.repeat(64)}` } } }, context))
            .toMatchObject({ ok: false, errorCode: 'template_changed' });
        expect(mutations).toEqual([]);
        return;
    }
    if (selected.payload.state !== 'ready') throw new Error('Expected ready app producer output');
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, result: {
        kind: 'prepared', template: selected.payload.app, creationDefaults: { values: { controllerMachineId: 'account-controller',
            buildMachineId: 'target', retainPreviousDeployments: 7 }, sources: { controllerMachineId: 'account', retainPreviousDeployments: 'account' } },
    } });
    owner = { kind: 'team', teamId: 'team' };
    expect(await executor.execute('deployments.publish.prepare', input, context)).toMatchObject({ ok: true, result: {
        kind: 'prepared', creationDefaults: { values: { controllerMachineId: 'target', retainPreviousDeployments: 1 },
            sources: { controllerMachineId: 'builtin', retainPreviousDeployments: 'builtin' } },
    } });
    expect(await executor.execute('deployments.publish.prepare', { ...input, explicit: { retainPreviousDeployments: 2 } }, context))
        .toMatchObject({ ok: true, result: { creationDefaults: {
            values: { retainPreviousDeployments: 2 }, sources: { retainPreviousDeployments: 'explicit' },
        } } });
    expect(await executor.execute('deployments.publish.prepare', { ...input, installationId: 'replaced-installation' }, context))
        .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
    expect(await executor.execute('deployments.publish.prepare', { ...input, sourceRevision: 3 }, context))
        .toMatchObject({ ok: false, errorCode: 'source_changed' });
    expect(await executor.execute('deployments.publish.prepare', { ...input, templateRef: { ...input.templateRef,
        ref: { kind: 'content', digest: `sha256:${'b'.repeat(64)}` } } }, context))
        .toMatchObject({ ok: false, errorCode: 'template_changed' });
    expect(mutations).toEqual([]);
    if (format === 'coolify-templates') expect(upstream).toEqual([
        `https://raw.githubusercontent.com/publish-preparation/catalog/${commit}/templates/service-templates.json`,
        `https://raw.githubusercontent.com/publish-preparation/catalog/${commit}/templates/compose/app.yaml`,
    ]);
    expect(requests.some(url => url.includes('/v1/artifacts/') || url.includes('/deployments/environments'))).toBe(false);
});
