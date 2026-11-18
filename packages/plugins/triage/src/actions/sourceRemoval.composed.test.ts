import { definePlugin, type JsonValue, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import {
    TriageSourcesContributionProtocolV1,
    TriageSourceDescriptorV1Schema,
    TriageSourceAdministrationActionResultV1Schema,
    TriageReadConfiguredSourceInstancesResultV1Schema,
    TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { createTestkitCorpusCollections, selectTestkitExternalSourceInput } from '../corpus/testkit/corpusCollections.test-support.js';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_USER_MARKS_COLLECTION_ID } from '../corpus/collections/ids.js';
import { createTriageListWindowStore } from '../projection/listWindowStore.js';
import { readTriageSessionLinksPageV1 } from '../sessions/readEntrySessionLinks.js';
import { openLinkedSession } from '../sessions/entrySessionOpen.js';
import { projectTriagePinnedRow } from '../ui/marks/pinnedRows.js';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesResultV1Schema } from './listEntriesProtocol.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailResultV1Schema } from './entryDetailProtocol.js';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryResultV1Schema } from './reobserveEntryProtocol.js';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 } from './sessionLinksProtocol.js';
import { TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1, TriageListPinnedEntriesResultV1Schema } from './userMarksProtocol.js';

const fixture = createTriageSourceV1Fixture();
const protocol = TriageSourcesContributionProtocolV1;
const source = fixture.configuredInstance.instance.source;
const base = fixture.getResult;
if (base.kind !== 'present') throw new Error('The public source fixture must provide a present entry');
if (fixture.administrationInput.kind !== 'create') throw new Error('The public source fixture must provide source creation');
const draft = fixture.administrationInput.draft;
const observations = ['ordinary', 'pinned', 'linked'].map(entryId => ({
    ...base, localRef: { ...base.localRef, entryId }, snapshot: { ...base.snapshot, title: `Provider ${entryId}` },
}));
const refs = observations.map(observation => ({ source, ...observation.localRef }));

async function createAccount(accountId: string) {
    const corpus = createTestkitCorpusCollections();
    const providerReads: string[] = [];
    const hostCalls: { action: string; input: unknown }[] = [];
    const rejectedHostCalls: string[] = [];
    const definition = definePlugin({ id: source.pluginId, version: '0.0.0', actions: {
        discover: { title: 'Discover', surfaces: protocol.operations.listInstances.declaration.surfaces,
            inputSchema: protocol.operations.listInstances.declaration.input.schema,
            resultSchema: protocol.operations.listInstances.declaration.resultSchema,
            run: async () => fixture.listInstancesResult },
        scan: { title: 'Scan', surfaces: protocol.operations.scan.declaration.surfaces,
            inputSchema: protocol.operations.scan.declaration.input.schema,
            resultSchema: protocol.operations.scan.declaration.resultSchema,
            run: async input => {
                expect(input.instance.binding).toEqual(draft.binding);
                providerReads.push('scan');
                return { kind: 'complete' as const, observations, evidence: { kind: 'walkFinished' as const } };
            } },
        get: { title: 'Get', surfaces: protocol.operations.get.declaration.surfaces,
            inputSchema: protocol.operations.get.declaration.input.schema,
            resultSchema: protocol.operations.get.declaration.resultSchema,
            run: async input => {
                expect(input.instance.binding).toEqual(draft.binding);
                providerReads.push(`get:${input.localRef.entryId}`);
                const observation = observations.find(row => row.localRef.entryId === input.localRef.entryId);
                if (!observation) throw new Error('Unexpected entry at exact source get');
                return observation;
            } },
    }, ui: { renderers: [{ id: 'detail', kind: 'declarative', root: { kind: 'text', text: 'Source detail' } }] },
    contributesTo: { 'happier.triage': { sources: { [source.localId]: protocol.contribute({
        descriptor: fixture.descriptor,
        operations: { listInstances: protocol.operations.listInstances.bind('discover'),
            scan: protocol.operations.scan.bind('scan'), get: protocol.operations.get.bind('get') },
        surfaces: { detail: { renderer: 'detail' } },
    }) } } } });
    const contributor = await createPluginTestkit({ manifest: definition.manifest, module: definition });
    let plugin!: PluginTestkit;
    // The host snapshot boundary adds descriptor semantics to the SDK's real
    // registered contributions and opaque admitted operation handles.
    const targetedContributions = { observeForSelf: () => ({
        readCurrent: async () => {
            const snapshot = plugin.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
            return { ...snapshot, contributions: snapshot.contributions.map(entry => {
                const manifest = entry.contributor.pluginId === source.pluginId ? definition.manifest : TRIAGE_PLUGIN.manifest;
                const declaration = manifest.contributes.targetedPluginContributions?.find(candidate => candidate.id === entry.contributor.contributionId);
                return { ...entry, descriptor: TriageSourceDescriptorV1Schema.parse(declaration?.descriptor), surfaces: {} };
            }) };
        }, dispose() {},
    }) } as unknown as PluginServices['targetedContributions'];
    // Portable Account execution has no SessionsService. Its real transcript
    // access port is host Actions (session.messages.recent.get, transcript.page,
    // transcript.readAfter); reject every host read/observe, including those.
    const actions = {
        async execute(action: string, input: JsonValue) {
            hostCalls.push({ action, input });
            if (action === 'session.open') return undefined;
            rejectedHostCalls.push(action);
            throw new Error(`Forbidden Message/host access: ${action}`);
        },
        async observe(action: string) {
            rejectedHostCalls.push(action);
            throw new Error(`Forbidden Message/host observation: ${action}`);
        },
    } as unknown as PluginServices['actions'];
    const storage = { account: { collection: (collection: { id: string }) => {
        if (collection.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID) return corpus.collections.sourceInstances;
        if (collection.id === CORPUS_SESSION_LINKS_COLLECTION_ID) return corpus.collections.sessionLinks;
        if (collection.id === CORPUS_USER_MARKS_COLLECTION_ID) return corpus.collections.userMarks;
        throw new Error(`Unexpected Collection ${collection.id}`);
    } } } as unknown as PluginServices['storage'];
    try {
        plugin = await createPluginTestkit({ manifest: TRIAGE_PLUGIN.manifest, module: {
            ...TRIAGE_PLUGIN,
            activateAccount(api) {
                TRIAGE_PLUGIN.activateAccount({ ...api, actions: { register(id, handler, registrationOptions) {
                    api.actions.register(id, (input, context) => handler(input, {
                        ...context, services: { ...context.services, targetedContributions },
                    }), registrationOptions);
                } } });
            },
        }, targetedContributionContributors: [contributor], services: { storage, actions } });
    } catch (error) { await contributor.dispose(); throw error; }
    const options = { surface: 'agent' as const, accountScope: { serverId: 'removal-home', accountId } };
    const invoke = (action: string, input: JsonValue) => plugin.invokeAction(action, input, options);
    const store = createTriageListWindowStore({ nowMs: () => 1_000, readEntries: async (input, cancellation) =>
        TriageListEntriesResultV1Schema.parse(await plugin.invokeAction(TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
            await selectTestkitExternalSourceInput(input, corpus.collections.sourceInstances), { ...options, ...cancellation })) });
    return { corpus, invoke, store, providerReads, hostCalls, rejectedHostCalls,
        open: (sessionId: string) => openLinkedSession({ sessionId, execute: (action, input) => actions.execute(action, input) }),
        async dispose() { store.dispose(); await plugin.dispose(); await contributor.dispose(); } };
}

describe('registered configured-source Remove', () => {
    it('drops populated lanes without Message access, preserves pin/link controls and isolates Account authority', async () => {
        const a = await createAccount('account-a');
        let b: Awaited<ReturnType<typeof createAccount>> | undefined;
        try {
            b = await createAccount('account-b');
            const setup = async (account: typeof a, accountId: string) => {
                const created = TriageSourceAdministrationActionResultV1Schema.parse(await account.invoke(
                    TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId, { v: 1, source, kind: 'create', draft }));
                if (created.kind !== 'active') throw new Error(`Source creation failed: ${created.kind}`);
                const sourceInstanceId = created.sourceInstanceId;
                const displayAtMark = { title: `${accountId} frozen pin`, scopeLabel: `${accountId}/repository` };
                expect(await account.invoke(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
                    { v: 1, pinned: true, entryRef: refs[1], displayAtMark })).toEqual({ v: 1, status: 'pinned' });
                expect(await account.invoke(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, {
                    v: 1, entryRef: refs[2], sourceInstanceId, sessionId: `${accountId}-session`,
                    display: { locator: { v: 1, displayPath: `${accountId} frozen link` }, scopeLabel: `${accountId}/repository` },
                })).toEqual({ v: 1, status: 'linked' });
                await account.store.refresh('view');
                expect(account.store.getSnapshot().window?.rows.map(row => row.entryRef.entryId).sort()).toEqual(['linked', 'ordinary', 'pinned']);
                expect(TriageReobserveEntryResultV1Schema.parse(await account.invoke(TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
                    { v: 1, entryRef: refs[0], sourceInstanceId })).kind).toBe('observed');
                return { sourceInstanceId, displayAtMark,
                    pins: TriageListPinnedEntriesResultV1Schema.parse(await account.invoke(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, { v: 1, limit: 10 })),
                    links: await readTriageSessionLinksPageV1(account.corpus.collections.sessionLinks, { relation: { entryRef: refs[2] } }) };
            };
            const aa = await setup(a, 'account-a');
            const bb = await setup(b, 'account-b');
            expect(aa.sourceInstanceId).not.toBe(bb.sourceInstanceId);
            expect(a.hostCalls).toEqual([]);
            expect(b.hostCalls).toEqual([]);
            const bWindow = b.store.getSnapshot().window;
            const aReads = [...a.providerReads];
            const bReads = [...b.providerReads];

            expect(await a.invoke(TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId,
                { v: 1, kind: 'remove', sourceInstanceId: aa.sourceInstanceId })).toEqual({ kind: 'removed', sourceInstanceId: aa.sourceInstanceId });
            await a.store.refresh('manual');
            expect(a.store.getSnapshot().window?.rows).toEqual([]);
            const configured = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await a.invoke(
                TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId, { v: 1, source }));
            expect(configured).toMatchObject({ kind: 'read', instances: [{ lifecycle: 'retired', configured: { instance: { sourceInstanceId: aa.sourceInstanceId } } }] });
            expect(configured.kind === 'read' ? configured.instances.length : -1).toBe(1);
            expect(TriageReobserveEntryResultV1Schema.parse(await a.invoke(TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef: refs[0], sourceInstanceId: aa.sourceInstanceId })).kind).toBe('unavailable');
            expect(TriageReadEntryDetailResultV1Schema.parse(await a.invoke(TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef: refs[2], sourceInstanceId: aa.sourceInstanceId }))).toEqual({ kind: 'unavailable' });
            expect(a.providerReads).toEqual(aReads);

            expect(await a.invoke(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, { v: 1, limit: 10 })).toEqual(aa.pins);
            expect(projectTriagePinnedRow(aa.pins.pins[0]!, null)).toMatchObject({
                title: aa.displayAtMark.title, scopeLabel: aa.displayAtMark.scopeLabel, pinned: true, materialized: false,
            });
            expect(await readTriageSessionLinksPageV1(a.corpus.collections.sessionLinks, { relation: { entryRef: refs[2] } })).toEqual(aa.links);
            expect(aa.links.links[0]).toMatchObject({ sessionId: 'account-a-session', displayPathAtLink: 'account-a frozen link' });
            // Message access must be zero even if an erroneous caller catches
            // the throwing boundary; missing transcripts are no eviction oracle.
            expect(a.hostCalls).toEqual([]);
            expect(a.rejectedHostCalls).toEqual([]);
            expect(b.rejectedHostCalls).toEqual([]);

            expect(TriageReobserveEntryResultV1Schema.parse(await a.invoke(TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef: refs[0], sourceInstanceId: bb.sourceInstanceId })).kind).toBe('unavailable');
            expect(TriageReobserveEntryResultV1Schema.parse(await b.invoke(TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef: refs[0], sourceInstanceId: aa.sourceInstanceId })).kind).toBe('unavailable');
            expect(await b.invoke(TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId,
                { v: 1, kind: 'remove', sourceInstanceId: aa.sourceInstanceId })).toMatchObject({
                kind: 'invalidCaller', failure: { class: 'permission', code: 'sourceAdministrationCallerNotAdmitted' },
            });
            expect(b.store.getSnapshot().window).toBe(bWindow);
            expect(b.providerReads).toEqual(bReads);
            expect(await b.invoke(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, { v: 1, limit: 10 })).toEqual(bb.pins);
            expect(await readTriageSessionLinksPageV1(b.corpus.collections.sessionLinks, { relation: { entryRef: refs[2] } })).toEqual(bb.links);
            expect(TriageReobserveEntryResultV1Schema.parse(await b.invoke(TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef: refs[0], sourceInstanceId: bb.sourceInstanceId })).kind).toBe('observed');

            expect(await a.open(aa.links.links[0]!.sessionId)).toEqual({ status: 'opened' });
            expect(a.hostCalls).toEqual([{ action: 'session.open', input: { sessionId: 'account-a-session' } }]);
            expect(await a.invoke(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
                { v: 1, pinned: false, entryRef: refs[1] })).toEqual({ v: 1, status: 'unpinned' });
            expect(TriageListPinnedEntriesResultV1Schema.parse(await a.invoke(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, { v: 1, limit: 10 })).pins).toEqual([]);
            expect(await b.invoke(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, { v: 1, limit: 10 })).toEqual(bb.pins);
        } finally { await b?.dispose(); await a.dispose(); }
    });
});
