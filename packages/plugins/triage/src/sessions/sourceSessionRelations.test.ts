import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue, PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';

import { activate } from '../accountRuntime.js';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
import { TriageReadSourceSessionLinksResultV1Schema, TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1 } from '../actions/sessionLinksProtocol.js';
import { createTriageSourceSessionRelations } from './sourceSessionRelations.js';
import { linkEntryToSession } from './entrySessionLinks.js';
import { testkitConfiguredInstance, testkitReadOnlySourceSnapshot, TESTKIT_LINK_DISPLAY } from './testkit/entrySessionTestkit.test-support.js';

describe('native PR Session relations', () => {
    it('retains the indexed corpus read refusal in each existing relation lane', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const configured = testkitConfiguredInstance();
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            sourceQualifiedId: entryRef.source.pluginId + '/' + entryRef.source.localId, configured }));
        // The Account Collection transport is the storage boundary.
        vi.spyOn(collections.sessionLinks, 'query').mockRejectedValue(new PluginError({
            code: 'account_storage_unavailable', retryable: true, details: { requestId: 'links-corpus-17' },
        }));
        const snapshot = testkitReadOnlySourceSnapshot();
        const relations = createTriageSourceSessionRelations({ signal: new AbortController().signal,
            services: { actions: {}, targetedContributions: { observeForSelf: () => ({
                readCurrent: async () => snapshot, dispose() {},
            }) } },
        } as unknown as Parameters<typeof createTriageSourceSessionRelations>[0], collections);
        const [read] = await relations.readEntries([{ entryRef, sourceInstanceId: configured.instance.sourceInstanceId }]);
        expect(TriageReadSourceSessionLinksResultV1Schema.parse(read?.result)).toMatchObject({
            kind: 'failed', links: [], lanes: [{ health: { kind: 'failed', invocationError: {
                code: 'account_storage_unavailable', requestId: 'links-corpus-17', retryable: true,
            } } }],
        });
    });
    it('retains a source-result Request ID when authoritative detail preparation throws its refusal', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const configured = testkitConfiguredInstance();
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            sourceQualifiedId: entryRef.source.pluginId + '/' + entryRef.source.localId, configured }));
        const source = testkitReadOnlySourceSnapshot().contributions[0]!;
        const relations = createTriageSourceSessionRelations({ signal: new AbortController().signal,
            services: { targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{
                ...source, descriptor: { ...source.descriptor, sessionRelations: { kindIds: [entryRef.kindId] } },
                operations: { readSessionLinks: { role: 'read' }, linkSession: { role: 'write' } },
            }] }), dispose() {} }) }, actions: { executeAdmittedTargetedOperation: async () => ({
                kind: 'failed', failure: { class: 'transient', code: 'source_links_unavailable', requestId: 'links-source-17' },
            }) } },
        } as unknown as Parameters<typeof createTriageSourceSessionRelations>[0], collections); // Host admission and dispatch boundaries.
        await expect(relations.read({ entryRef, sourceInstanceId: configured.instance.sourceInstanceId, readFailure: 'throw' }))
            .rejects.toMatchObject({ code: 'source_links_unavailable', data: { details: { requestId: 'links-source-17' } } });
    });
    it('reads the first selected PR through Account activation without a retained census', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const configured = testkitConfiguredInstance();
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            sourceQualifiedId: `${entryRef.source.pluginId}/${entryRef.source.localId}`, configured }));
        const retained = await linkEntryToSession({ collections, entryRef, sessionId: 'retained-session',
            display: TESTKIT_LINK_DISPLAY, nowMs: 1234 });
        if (retained.status !== 'linked') throw new Error('Expected a retained development row');
        const censusReads = vi.spyOn(collections.sessionLinks, 'query');
        const source = testkitReadOnlySourceSnapshot().contributions[0]!;
        // Account storage and admitted source dispatch are host transport boundaries.
        const context = { surface: 'api', signal: new AbortController().signal, services: {
            storage: { account: { collection: (definition: PluginAccountCollectionDefinition) =>
                definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID ? collections.sessionLinks
                    : definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? collections.sourceInstances : collections.userMarks } },
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{ ...source,
                descriptor: { ...source.descriptor, sessionRelations: { kindIds: [entryRef.kindId] } },
                operations: { readSessionLinks: { role: 'read' }, linkSession: { role: 'write' } },
            }] }), dispose() {} }) },
            actions: { executeAdmittedTargetedOperation: async () => ({ kind: 'complete', links: [{
                localRef: { kindId: entryRef.kindId, collisionScope: entryRef.collisionScope, entryId: entryRef.entryId },
                sessionId: 'native-session', linkedAtMs: 5678, displayPath: 'Native PR',
            }] }) },
        } } as unknown as Parameters<PluginAccountActionHandler>[1];
        const handlers = new Map<string, PluginAccountActionHandler<JsonValue, JsonValue | void>>();
        activate({ resources: { registerDynamicResource() {} }, actions: { register(id, handler) {
            handlers.set(id, handler);
        } } } as PluginAccountApi);
        const read = handlers.get(TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1);
        if (read === undefined) throw new Error('Expected the registered relation owner');
        const result = TriageReadSourceSessionLinksResultV1Schema.parse(await read({ v: 1, entryRef,
            sourceInstanceId: configured.instance.sourceInstanceId }, context));

        expect(censusReads).toHaveBeenCalledTimes(0);
        expect(result).toMatchObject({ kind: 'complete', links: [{ entryRef, sessionId: 'native-session' }] });
        expect(result.links).toHaveLength(1);
        expect(await collections.sessionLinks.get(retained.linkTag)).not.toBeNull();
    });
});
