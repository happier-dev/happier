import { readIndexedBundledDeclarationManifest } from '../../../../../apps/cli/src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs';
import { expect, it, vi } from 'vitest';
import { definePlugin, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageSourcesContributionProtocolV1, type TriageResolveResourceResultV1 } from '@happier-dev/triage-protocol/v1';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, TriageResolveResourceActionResultV1Schema } from './resolveResourceProtocol.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailResultV1Schema } from './entryDetailProtocol.js';
import { getActionDefinitionForCatalogSurface, listActionDefinitionsForCatalogSurface, searchActionDefinitionSummaries } from '@happier-dev/protocol/actions/actionCatalog';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';

const fixture = createTriageSourceV1Fixture();
const resource = { kind: 'pullRequest' as const, url: 'https://github.com/octo/repo/pull/17' };

async function withSource(mode: 'plain' | 'e2ee', run: (input: Readonly<{
    plugin: PluginTestkit;
    requests: readonly ReturnType<typeof protocol.operations.resolveResource.declaration.input.schema.parse>[];
    seed: (index: number, lifecycle?: 'active' | 'retired', admitted?: boolean) => void;
    answer: (resolve: (input: ReturnType<typeof protocol.operations.resolveResource.declaration.input.schema.parse>, signal: AbortSignal) => Promise<TriageResolveResourceResultV1>) => void;
}>) => Promise<void>) {
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: mode });
    const configured = fixture.configuredInstance;
    const source = configured.instance.source;
    const requests: ReturnType<typeof protocol.operations.resolveResource.declaration.input.schema.parse>[] = [];
    let resolve = async (_input: ReturnType<typeof protocol.operations.resolveResource.declaration.input.schema.parse>, _signal: AbortSignal): Promise<TriageResolveResourceResultV1> => ({
        kind: 'resolved', localRef: fixture.getInput.localRef,
        locator: fixture.getResult.kind === 'present' ? fixture.getResult.locator : {},
    });
    const definition = definePlugin({ id: source.pluginId, version: '0.0.0', actions: {
        discover: { title: 'Discover', surfaces: protocol.operations.listInstances.declaration.surfaces,
            inputSchema: protocol.operations.listInstances.declaration.input.schema, resultSchema: protocol.operations.listInstances.declaration.resultSchema,
            run: async () => fixture.listInstancesResult },
        scan: { title: 'Scan', surfaces: protocol.operations.scan.declaration.surfaces,
            inputSchema: protocol.operations.scan.declaration.input.schema, resultSchema: protocol.operations.scan.declaration.resultSchema,
            run: async () => { throw new Error('URL resolution must not scan'); } },
        get: { title: 'Get', surfaces: protocol.operations.get.declaration.surfaces,
            inputSchema: protocol.operations.get.declaration.input.schema, resultSchema: protocol.operations.get.declaration.resultSchema,
            run: async () => { throw new Error('URL resolution must not get an invented identity'); } },
        resolve: { title: 'Resolve resource', surfaces: protocol.operations.resolveResource.declaration.surfaces,
            inputSchema: protocol.operations.resolveResource.declaration.input.schema, resultSchema: protocol.operations.resolveResource.declaration.resultSchema,
            run: async (input, context) => {
                expect(context.surface).toBe('plugin');
                requests.push(input);
                return resolve(input, context.signal);
            } },
    }, ui: { renderers: [{ id: 'detail', kind: 'declarative', root: { kind: 'text', text: 'Source detail' } }] },
    contributesTo: { 'happier.triage': { sources: { [source.localId]: protocol.contribute({ descriptor: fixture.descriptor,
        operations: { listInstances: protocol.operations.listInstances.bind('discover'), scan: protocol.operations.scan.bind('scan'),
            get: protocol.operations.get.bind('get'), resolveResource: protocol.operations.resolveResource.bind('resolve') },
        surfaces: { detail: { renderer: 'detail' } },
    }) } } } });
    const contributor = await createPluginTestkit({ manifest: definition.manifest, module: definition });
    let plugin!: PluginTestkit;
    // The SDK fixture owns real admitted handles and dispatch. Supply only the
    // descriptor semantics its host snapshot omits, plus Account persistence.
    const targetedContributions = { observeForSelf: () => ({
        readCurrent: async () => {
            const snapshot = plugin.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
            return { ...snapshot, contributions: snapshot.contributions.map(entry => ({ ...entry, descriptor: fixture.descriptor })) };
        }, dispose: () => {},
    }) } as unknown as PluginServices['targetedContributions'];
    try {
        plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: {
            ...TRIAGE_PLUGIN,
            activateAccount(api) {
                TRIAGE_PLUGIN.activateAccount({ ...api, actions: { register(id, handler, registrationOptions) {
                    api.actions.register(id, (input, context) => handler(input, {
                        ...context, services: { ...context.services, targetedContributions },
                    }), registrationOptions);
                } } });
            },
        }, targetedContributionContributors: [contributor], services: {
                storage: { account: { collection: (definition: { id: string }) => {
                    if (definition.id === 'source-instances') return collections.sourceInstances;
                    if (definition.id === 'session-links') return collections.sessionLinks;
                    if (definition.id === 'user-marks') return collections.userMarks;
                    throw new Error(`Unexpected Collection ${definition.id}`);
                } } } as unknown as PluginServices['storage'],
            } });
        await run({ plugin, requests, answer: next => { resolve = next; }, seed: (index, lifecycle = CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, admitted = true) => {
            const instance = { ...configured.instance, sourceInstanceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
                source: admitted ? source : { pluginId: 'example.unadmitted', localId: 'source' } };
            control.sourceInstances.seed(toCorpusStoredValue({
                instanceTag: String(index).padStart(43, 'a'), sourceQualifiedId: `${instance.source.pluginId}/${instance.source.localId}`,
                lifecycle, configuredAtMs: index, configured: { ...configured, instance },
            }));
        } });
    } finally { await plugin?.dispose(); await contributor.dispose(); }
}

const protocol = TriageSourcesContributionProtocolV1;

it.each([
    { query: 'pin issue', localId: TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1 },
    { query: 'non-secret configuration', localId: TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 },
])('discovers the existing entry handoff from "$query"', ({ query, localId }) => {
    // Search beside the published provider catalog so provider mutations cannot
    // crowd the exact-entry prerequisite out of the first discovery page.
    const github = PluginManifestV2Schema.parse(readIndexedBundledDeclarationManifest(new URL(
        '../../../../../apps/cli/assets/bundled-plugin-manifests/scm-github.json', import.meta.url,
    )));
    const envelope = getActionDefinitionForCatalogSurface({ id: 'action.spec.search', surface: 'agent' })!;
    const definitions = [PLUGIN_MANIFEST, github].flatMap(manifest => manifest.contributes.actions.filter(action => action.surfaces.includes('agent')).map(action => ({
        ...envelope,
        id: formatQualifiedPluginActionId({ pluginId: manifest.id, localId: action.id }),
        title: resolvePluginLocalizedStringV2Text(action.title),
        description: action.description === undefined ? null : resolvePluginLocalizedStringV2Text(action.description),
    })));
    const results = searchActionDefinitionSummaries([
        ...listActionDefinitionsForCatalogSurface({ surface: 'agent' }), ...definitions,
    ], { query, limit: 10 });
    expect(results.map(action => action.id)).toContain(formatQualifiedPluginActionId({
        pluginId: PLUGIN_MANIFEST.id, localId,
    }));
});

it.each(['plain', 'e2ee'] as const)('resolves a URL through agent admission in a %s Account, without a mounted page', async mode => {
    const action = PLUGIN_MANIFEST.contributes.actions.find(entry => entry.id === TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1);
    expect(action, 'the URL read must be declared for agent callers').toBeDefined();
    if (!action) throw new Error('Missing URL resolution Action');
    expect(action.execution.target).toBe('account');
    expect(action.surfaces).toEqual(expect.arrayContaining(['ui', 'agent', 'mcp', 'cli']));
    await withSource(mode, async ({ plugin, seed, requests }) => {
        seed(1);
        const sourceInstance = { ...fixture.configuredInstance.instance, sourceInstanceId: '00000000-0000-4000-8000-000000000001' };
        const resolved = TriageResolveResourceActionResultV1Schema.parse(await plugin.invokeAction(action.id, { v: 1, resource }, { surface: 'agent' }));
        expect(resolved).toEqual({
            kind: 'resolved', sourceInstance,
            entryRef: { source: sourceInstance.source, ...fixture.getInput.localRef },
            locator: fixture.getResult.kind === 'present' ? fixture.getResult.locator : {},
        });
        expect(requests).toEqual([{ v: 1, instance: { ...fixture.configuredInstance, instance: sourceInstance }, resource }]);
        if (resolved.kind !== 'resolved') throw new Error('Expected exact URL resolution');
        const detail = TriageReadEntryDetailResultV1Schema.parse(await plugin.invokeAction(TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, {
            v: 1, entryRef: resolved.entryRef,
            sourceInstanceId: resolved.sourceInstance.sourceInstanceId,
        }, { surface: 'agent' }));
        expect(detail).toMatchObject({ kind: 'read', instance: { ...fixture.configuredInstance, instance: sourceInstance } });
    });
});

it.each([0, 1, 4])('walks %s active configured connections once, skipping retired and unadmitted sources', async count => {
    await withSource('plain', async ({ plugin, seed, answer, requests }) => {
        for (let index = 1; index <= count; index++) seed(index);
        seed(90, 'retired');
        seed(91, 'active', false);
        answer(async () => ({ kind: 'unavailable', failure: { class: 'unknown', code: 'provider_unreachable' } }));
        expect(await plugin.invokeAction(TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, { v: 1, resource }, { surface: 'cli' }))
            .toMatchObject({ kind: 'unavailable', code: 'sourceUnavailable', remedy: expect.stringContaining('PRs & Issues') });
        expect(requests).toHaveLength(count);
        expect(new Set(requests.map(value => value.instance.instance.sourceInstanceId)).size).toBe(count);
    });
});

it('returns the same disconnected-source code and remedy to both URL callers', async () => {
    await withSource('plain', async ({ plugin, seed, answer, requests }) => {
        seed(1);
        answer(async () => ({ kind: 'unavailable', failure: { class: 'unknown', code: 'provider_unreachable' } }));
        const unavailable = await plugin.invokeAction(TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, { v: 1, resource }, { surface: 'agent' });
        expect(unavailable).toMatchObject({ kind: 'unavailable', code: 'sourceUnavailable', remedy: expect.stringContaining('PRs & Issues') });
        if (!unavailable || typeof unavailable !== 'object' || !('code' in unavailable) || !('remedy' in unavailable)) {
            throw new Error('Expected a typed resolution refusal');
        }
        await expect(plugin.invokeAction(TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, {
            v: 1, kind: 'pullRequestForSession', reference: resource.url, sessionId: 'session-a',
        }, { surface: 'agent' })).rejects.toMatchObject({ code: unavailable.code, message: unavailable.remedy });
        expect(requests.map(request => request.resource)).toEqual([resource, resource]);
    });
});

it('continues after a failed connection and stops at the first exact resolution', async () => {
    await withSource('plain', async ({ plugin, seed, answer, requests }) => {
        for (let index = 1; index <= 4; index++) seed(index);
        answer(async () => {
            if (requests.length === 1) throw new Error('Connection unavailable');
            return { kind: 'resolved', localRef: fixture.getInput.localRef,
                locator: fixture.getResult.kind === 'present' ? fixture.getResult.locator : {} };
        });
        expect(await plugin.invokeAction(TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, { v: 1, resource }, { surface: 'mcp' }))
            .toMatchObject({ kind: 'resolved', sourceInstance: { sourceInstanceId: '00000000-0000-4000-8000-000000000002' } });
        expect(requests).toHaveLength(2);
    });
});

it('rejects a late provider resolution after cancellation without trying another connection', async () => {
    await withSource('plain', async ({ plugin, seed, answer, requests }) => {
        seed(1); seed(2);
        const controller = new AbortController();
        let providerSignal: AbortSignal | undefined;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        answer(async (_input, signal) => {
            providerSignal = signal;
            await held;
            return { kind: 'resolved', localRef: fixture.getInput.localRef,
                locator: fixture.getResult.kind === 'present' ? fixture.getResult.locator : {} };
        });
        const pending = plugin.invokeAction(TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, { v: 1, resource }, { surface: 'agent', signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'plugin_action_aborted' });
        await vi.waitFor(() => expect(providerSignal).toBeDefined());
        controller.abort();
        expect(providerSignal?.aborted).toBe(true);
        release();
        await rejected;
        expect(requests).toHaveLength(1);
    });
});
