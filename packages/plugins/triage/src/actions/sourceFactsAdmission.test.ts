import { describe, expect, it } from 'vitest';
import { definePlugin, type PluginInvocationContext, type PluginServices } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageListEntriesDeps } from './listEntries.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { createTriageReobserveEntryActionHandler } from './reobserveEntry.js';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1 } from '../composer/attachmentValue.js';
import { readTriageSessionLinksPageV1 } from '../sessions/readEntrySessionLinks.js';

const fixture = createTriageSourceV1Fixture();
const facts = [
    { id: 'acme/updated', importance: 'secondary' as const, value: { kind: 'timestamp' as const, atMs: 1760000030000, format: 'relative' as const } },
    { id: 'acme/checks', importance: 'primary' as const, value: { kind: 'status' as const, value: 'Passing', tone: 'success' as const } },
];

describe('source fact admission across the host result boundary', () => {
    it.each(['page', 'complete'] as const)('refuses a whole 32-row %s when one snapshot repeats a fact id', async kind => {
        const { collections } = createTestkitCorpusCollections();
        const observations = Array.from({ length: 32 }, (_, index) => ({
            ...fixture.getResult, localRef: { ...fixture.getResult.localRef, entryId: 'LGQ-' + index },
            snapshot: { ...fixture.getResult.snapshot, facts },
        }));
        const valid = kind === 'page'
            ? { kind, observations, evidence: { kind: 'walkFinished' as const }, continuation: { v: 1 as const, token: 'next' } }
            : { kind, observations, evidence: { kind: 'walkFinished' as const } };
        let result = valid;
        // Only the host transport is replaced. This is the actual scan adapter
        // consumed by list/search, after JSON-rehydrated host structural parsing.
        const context = { services: {
            storage: { account: { collection: () => collections.sourceInstances } },
            actions: { executeAdmittedTargetedOperation: async () => result },
        } } as unknown as PluginInvocationContext;
        const deps = createTriageListEntriesDeps(context);
        const operation = {} as Parameters<typeof deps.executeScan>[0];
        expect(await deps.executeScan(operation, fixture.scanInput)).toBe(valid);
        expect(valid.observations).toHaveLength(32);
        for (const duplicate of [facts[0]!, { ...facts[0]!, label: 'Different label' }]) {
            result = { ...valid, observations: observations.map((row, index) => index === 31
                ? { ...row, snapshot: { ...row.snapshot, facts: [...facts, duplicate] } } : row) };
            await expect(deps.executeScan(operation, fixture.scanInput)).rejects.toMatchObject({
                data: { code: 'plugin_targeted_operation_result_invalid' },
            });
        }
    });

    it('refuses duplicate ids on exact get while accepting unique ids', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const source = fixture.detailInput.observation.entryRef.source;
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
            sourceQualifiedId: source.pluginId + '/' + source.localId,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured: fixture.configuredInstance }));
        let duplicate = false;
        const context = { surface: 'cli', services: {
            storage: { account: { collection: () => collections.sourceInstances } },
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{
                contributor: { pluginId: source.pluginId, contributionId: source.localId },
                descriptor: fixture.descriptor, operations: { get: {} },
            }] }), dispose: () => {} }) },
            actions: { executeAdmittedTargetedOperation: async () => ({ ...fixture.getResult,
                snapshot: { ...fixture.getResult.snapshot, facts: duplicate ? [...facts, facts[0]] : facts } }) },
        } } as unknown as PluginInvocationContext;
        const input = { entryRef: fixture.detailInput.observation.entryRef, sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId };
        const handler = createTriageReobserveEntryActionHandler();
        expect(await handler(input, context)).toMatchObject({ kind: 'observed' });
        duplicate = true;
        await expect(handler(input, context)).rejects.toMatchObject({ data: { code: 'plugin_targeted_operation_result_invalid' } });
    });
});

it('JSON-rehydrated exact source facts reject duplicate identities before attachment publication', async () => {
    const protocol = TriageSourcesContributionProtocolV1;
    const source = fixture.configuredInstance.instance.source;
    const entryRef = fixture.detailInput.observation.entryRef;
    const corpus = createTestkitCorpusCollections();
    corpus.control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
        sourceQualifiedId: `${source.pluginId}/${source.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured: fixture.configuredInstance }));
    let duplicate = true;
    const definition = definePlugin({ id: source.pluginId, version: '0.0.0', actions: {
        discover: { title: 'Discover', surfaces: protocol.operations.listInstances.declaration.surfaces,
            inputSchema: protocol.operations.listInstances.declaration.input.schema,
            resultSchema: protocol.operations.listInstances.declaration.resultSchema, run: async () => fixture.listInstancesResult },
        scan: { title: 'Scan', surfaces: protocol.operations.scan.declaration.surfaces,
            inputSchema: protocol.operations.scan.declaration.input.schema,
            resultSchema: protocol.operations.scan.declaration.resultSchema, run: async () => fixture.scanResult },
        get: { title: 'Get', surfaces: protocol.operations.get.declaration.surfaces,
            inputSchema: protocol.operations.get.declaration.input.schema,
            resultSchema: protocol.operations.get.declaration.resultSchema, run: async () => fixture.getResult },
    }, ui: { renderers: [{ id: 'detail', kind: 'declarative', root: { kind: 'text', text: 'Source detail' } }] },
    contributesTo: { 'happier.triage': { sources: { [source.localId]: protocol.contribute({ descriptor: fixture.descriptor,
        operations: { listInstances: protocol.operations.listInstances.bind('discover'),
            scan: protocol.operations.scan.bind('scan'), get: protocol.operations.get.bind('get') },
        surfaces: { detail: { renderer: 'detail' } },
    }) } } } });
    // A loaded source's JSON declaration cannot carry executable keyed-array
    // refinements. Keep its malformed external output raw until host decoding.
    const contributor = await createPluginTestkit({ manifest: JSON.parse(JSON.stringify(definition.manifest)), module: {
        activate(api) {
            api.actions.register('discover', async () => fixture.listInstancesResult);
            api.actions.register('scan', async () => { throw new Error('An exact attachment must not scan'); });
            api.actions.register('get', async input => {
                expect(input).toEqual(fixture.getInput);
                return { ...fixture.getResult, snapshot: { ...fixture.getResult.snapshot,
                    facts: duplicate ? [...facts, { ...facts[0]!, label: 'Different label' }] : facts } };
            });
        },
    } });
    let plugin: PluginTestkit | undefined;
    let run: ((context: PluginAccountActionContext) => Promise<void>) | undefined;
    // As in the existing composed source harness, the host supplies descriptor
    // semantics; SDK admission issues the original handles and parses results.
    const targetedContributions = { observeForSelf: () => ({ readCurrent: async () => {
        const snapshot = plugin!.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
        return { ...snapshot, contributions: snapshot.contributions.map(entry => ({ ...entry, descriptor: fixture.descriptor })) };
    }, dispose() {} }) } as unknown as PluginServices['targetedContributions'];
    try {
        plugin = await createPluginTestkit({ manifest: JSON.parse(JSON.stringify(PLUGIN_MANIFEST)),
            targetedContributionContributors: [contributor], module: { ...TRIAGE_PLUGIN,
                activateAccount(api) {
                    TRIAGE_PLUGIN.activateAccount({ ...api, actions: { register(id, handler, options) {
                        api.actions.register(id, async (input, context) => {
                            const invoke = run; run = undefined;
                            const current = { ...context, services: { ...context.services, targetedContributions } };
                            if (invoke) await invoke(current);
                            return handler(input, current);
                        }, options);
                    } } });
                },
            }, services: { storage: { account: { collection: (collection: { id: string }) => {
                if (collection.id === 'source-instances') return corpus.collections.sourceInstances;
                if (collection.id === 'session-links') return corpus.collections.sessionLinks;
                if (collection.id === 'user-marks') return corpus.collections.userMarks;
                throw new Error(`Unexpected Collection ${collection.id}`);
            } } } as unknown as PluginServices['storage'] } });
        const runtime = plugin.registration('composerAttachments', TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1);
        if (!runtime?.resolveForDispatch) throw new Error('The declared attachment resolver is not registered');
        const request = { sessionId: 'duplicate-facts-session', localId: 'pending-input', attachments: [{
            instanceId: 'selected-entry', key: 'selected-entry', value: { v: 1, entryRef,
                sourceInstance: fixture.configuredInstance.instance,
                ...(fixture.getInput.lastKnownLocator === undefined ? {} : { lastKnownLocator: fixture.getInput.lastKnownLocator }) },
        }] };
        run = async context => {
            const operation = plugin!.issueAdmittedTargetedOperation({ point: TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
                contributor: { testkit: contributor, contributionId: source.localId }, role: 'get' });
            // This positive malformed carrier proves JSON structural decoding
            // alone does not enforce fact identities; the consumer must admit.
            expect(await context.services.actions.executeAdmittedTargetedOperation(operation, fixture.getInput))
                .toMatchObject({ kind: 'present', snapshot: { facts: [...facts, { ...facts[0]!, label: 'Different label' }] } });
            await runtime.resolveForDispatch!(request, context);
        };
        await expect(plugin.invokeAction('sources/read-configured-v1', { v: 1 }, { surface: 'agent' }))
            .rejects.toMatchObject({ data: { code: 'plugin_targeted_operation_result_invalid' } });
        expect((await readTriageSessionLinksPageV1(corpus.collections.sessionLinks)).links).toEqual([]);
        duplicate = false;
        run = async context => {
            const resolved = await runtime.resolveForDispatch!(request, context);
            expect(resolved.attachments).toEqual([expect.objectContaining({ instanceId: 'selected-entry', status: 'ready' })]);
            expect(resolved.attachments[0]).toHaveProperty('context', expect.stringContaining('acme/checks: Passing'));
        };
        await plugin.invokeAction('sources/read-configured-v1', { v: 1 }, { surface: 'agent' });
        expect((await readTriageSessionLinksPageV1(corpus.collections.sessionLinks)).links)
            .toEqual([]);
    } finally { await plugin?.dispose(); await contributor.dispose(); }
});
