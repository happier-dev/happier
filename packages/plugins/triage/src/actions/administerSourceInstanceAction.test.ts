import type { PluginInvocationCaller, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageSourceInstanceDraftV1Schema,
    TriageSourceAdministrationActionResultV1Schema,
    type TriageGetResultV1,
    type TriageScanResultV1,
    type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import {
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_USER_MARKS_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections, selectTestkitConfiguredSources } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef, testkitLocator, testkitSnapshot, testkitViewer } from '../corpus/testkit/observations.test-support.js';
import { setPinned } from '../corpus/marks/setPinned.js';
import { readPinnedSection } from '../corpus/query/pinnedSection.js';
import { projectTriagePinnedRow } from '../ui/marks/pinnedRows.js';
import { linkEntryToSession } from '../sessions/entrySessionLinks.js';
import { readTriageSessionLinksPageV1 } from '../sessions/readEntrySessionLinks.js';
import { openLinkedSession } from '../sessions/entrySessionOpen.js';
import { deriveTriageComposerEntryAttachmentKey } from '../composer/attachmentValue.js';
import { createTriageEntryAttachmentRuntime } from '../composer/attachmentRuntime.js';
import { createTriageListEntriesActionHandler } from './listEntries.js';
import type { TriageAdmittedSourceV1 } from './listEntries.js';
import { createTriageAdministerSourceInstanceActionHandler } from './administerSourceInstanceAction.js';

/**
 * The one public source-administration Action — the entry point without which
 * nothing writes `source-instances` and the composed list is structurally
 * always empty.
 *
 * The host stamps provenance. A requested source selects an admitted address
 * for host automated callers; plugins remain scoped to their own contribution.
 * The handler resolves that admission before the writer runs. It reads no provider
 * of its own; the aggregate list read is the one producer of observations.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const PURPOSE = 'triage-source';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

function draft(overrides: Readonly<{ localInstanceKey?: string }> = {}): TriageSourceInstanceDraftV1 {
    return TriageSourceInstanceDraftV1Schema.parse({
        v: 1,
        binding: {
            purpose: PURPOSE,
            account: {
                service: { pluginId: SOURCE.pluginId, localId: 'accounts' },
                accountId: 'account-1',
            },
        },
        localInstanceKey: overrides.localInstanceKey ?? 'example/repository',
        keyStability: 'stable',
        configuration: { v: 1, token: 'routing-token' },
        locator: { v: 1, displayLabel: 'example/repository' },
    });
}

const SCAN_HANDLE = Object.freeze({ role: 'scan' });
const GET_HANDLE = Object.freeze({ role: 'get' });

const ADMITTED = [{
    contributor: {
        pluginId: SOURCE.pluginId,
        contributionId: SOURCE.localId,
        immutableGenerationId: 'generation-1',
    },
    protocol: {
        id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
        version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    },
    descriptor: {
        v: 1,
        purpose: PURPOSE,
        displayName: 'Example forge',
        kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
    },
    operations: { listInstances: {}, scan: SCAN_HANDLE, get: GET_HANDLE },
    surfaces: { detail: {} },
    // Host-created admitted entries are not constructible from plugin code; the
    // fixture stands in for the host at that one boundary.
} as unknown as TriageAdmittedSourceV1];

function pluginCaller(pluginId: string): PluginInvocationCaller {
    return {
        kind: 'plugin',
        pluginId,
        // A source Settings surface reaches this Action through the incumbent
        // plugin dispatcher, so its own contribution identity is the settings
        // projection rather than its `sources` contribution.
        contribution: { id: 'settings', qualifiedId: `${pluginId}/settings` },
        materialization: {
            pluginId,
            machineId: 'machine-1',
            materializationId: 'materialization-1',
        },
    } as unknown as PluginInvocationCaller;
}

function createContext(input: Readonly<{
    collections: CorpusCollectionsV1;
    caller?: PluginInvocationCaller;
    surface?: PluginInvocationContext['surface'];
    admitted?: readonly TriageAdmittedSourceV1[];
    onScan?: (operation: unknown) => void;
}>): PluginInvocationContext {
    return {
        signal: new AbortController().signal,
        surface: input.surface ?? 'plugin',
        ...(input.caller === undefined ? {} : { caller: input.caller }),
        services: {
            storage: {
                account: {
                    collection: (definition: PluginAccountCollectionDefinition) => {
                        if (definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID) return input.collections.sourceInstances;
                        if (definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID) return input.collections.sessionLinks;
                        if (definition.id === CORPUS_USER_MARKS_COLLECTION_ID) return input.collections.userMarks;
                        throw new Error(`Undeclared Collection: ${definition.id}`);
                    },
                },
            },
            targetedContributions: {
                observeForSelf: () => ({
                    readCurrent: async () => ({
                        generation: 'generation-1',
                        contributions: input.admitted ?? ADMITTED,
                    }),
                    dispose: () => {},
                }),
            },
            actions: {
                executeAdmittedTargetedOperation: async (operation: unknown): Promise<TriageScanResultV1 | TriageGetResultV1> => {
                    input.onScan?.(operation);
                    if (operation === GET_HANDLE) {
                        const { source: _source, ...localRef } = testkitEntryRef();
                        return { kind: 'present', localRef, locator: testkitLocator(),
                            snapshot: testkitSnapshot(), viewer: testkitViewer() };
                    }
                    return {
                        kind: 'complete',
                        observations: [{
                            kind: 'present',
                            localRef: {
                                kindId: 'pull-request',
                                collisionScope: 'example/repository',
                                entryId: '17',
                            },
                            locator: testkitLocator(),
                            snapshot: testkitSnapshot(),
                            viewer: testkitViewer(),
                        }],
                        evidence: { kind: 'walkFinished' },
                    };
                },
            },
        },
    } as unknown as PluginInvocationContext;
}

async function readRows(
    collections: CorpusCollectionsV1,
): Promise<readonly CorpusSourceInstanceRowV1[]> {
    const page = await collections.sourceInstances.query({ index: 'by-lifecycle', order: 'asc', limit: 64 });
    return page.rows.map((row) => fromCorpusStoredRow<CorpusSourceInstanceRowV1>(row).value);
}

describe('the source administration Action handler', () => {
    it('returns secret-free caller admission operands and leaves storage unchanged', async () => {
        const { collections } = createTestkitCorpusCollections();
        const handler = createTriageAdministerSourceInstanceActionHandler({ mintSourceInstanceId: () => INSTANCE_ID, nowMs: () => 1 });
        const result = await handler({ v: 1, kind: 'create', draft: draft() },
            createContext({ collections, caller: pluginCaller(SOURCE.pluginId), surface: 'ui', admitted: [] }));
        expect(result).toMatchObject({ kind: 'invalidCaller', admission: {
            caller: { kind: 'plugin', pluginId: SOURCE.pluginId }, surface: 'ui', candidateCount: 0,
        } });
        expect(TriageSourceAdministrationActionResultV1Schema.parse(result)).toEqual(result);
        expect(await readRows(collections)).toHaveLength(0);
    });
    it('lets an agent configure native service metadata and persists no account or credential', async () => {
        const { collections } = createTestkitCorpusCollections();
        const handler = createTriageAdministerSourceInstanceActionHandler({
            mintSourceInstanceId: () => INSTANCE_ID,
            nowMs: () => 1_000,
        });
        const binding = {
            purpose: PURPOSE,
            source: 'native' as const,
            service: { pluginId: SOURCE.pluginId, localId: 'accounts' },
        };
        const nativeDraft = { ...draft(), binding };
        expect(await handler(
            { v: 1, kind: 'create', source: SOURCE, draft: nativeDraft },
            createContext({ collections, surface: 'agent' }),
        )).toEqual({ kind: 'active', sourceInstanceId: INSTANCE_ID });
        const rows = await readRows(collections);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.configured.binding).toEqual(binding);
        expect(rows[0]?.configured.binding).not.toHaveProperty('account');
        expect(JSON.stringify(rows)).not.toContain('authorization');
        expect(JSON.stringify(rows)).not.toContain('credential');
    });

    it.each(['ui', 'voice', 'agent', 'api'] as const)('lets a host %s caller configure an admitted source and remove its existing instance without spoofing provenance', async (surface) => {
        const { collections } = createTestkitCorpusCollections();
        const handler = createTriageAdministerSourceInstanceActionHandler({
            mintSourceInstanceId: () => INSTANCE_ID,
            nowMs: () => 1_000,
        });
        const request = { v: 1 as const, kind: 'create' as const, source: SOURCE, draft: draft() };
        expect(await handler(request, createContext({ collections, surface })))
            .toEqual({ kind: 'active', sourceInstanceId: INSTANCE_ID });
        expect(await handler(request, createContext({ collections, surface, caller: pluginCaller('happier.other') })))
            .toMatchObject({ kind: 'invalidCaller', failure: { class: 'permission' } });
        expect(await handler({ v: 1, kind: 'remove', sourceInstanceId: INSTANCE_ID }, createContext({ collections, surface })))
            .toEqual({ kind: 'removed', sourceInstanceId: INSTANCE_ID });
        expect((await readRows(collections))[0]?.lifecycle).toBe(CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired);
        expect(await handler({ v: 1, kind: 'create', draft: draft() }, createContext({ collections, surface })))
            .toMatchObject({ kind: 'invalidCaller', failure: { class: 'permission' } });
    });

    it('configures a source end to end: one row written by the Action, no provider read, one visible entry', async () => {
        const { collections } = createTestkitCorpusCollections();
        const scanned: unknown[] = [];

        const handler = createTriageAdministerSourceInstanceActionHandler({
            mintSourceInstanceId: () => INSTANCE_ID,
            nowMs: () => 1_000,
        });

        const result = await handler(
            { v: 1, kind: 'create', draft: draft() },
            createContext({ collections, caller: pluginCaller(SOURCE.pluginId), onScan: (op) => scanned.push(op) }),
        );

        // The Action's result names only the canonical stable ref.
        expect(result).toEqual({ kind: 'active', sourceInstanceId: INSTANCE_ID });

        // The row exists, and it exists because the Action wrote it.
        const rows = await readRows(collections);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.lifecycle).toBe(CORPUS_SOURCE_INSTANCE_LIFECYCLE.active);
        expect(rows[0]?.configured.instance.sourceInstanceId).toBe(INSTANCE_ID);

        // Configuring a source performs no provider read of its own: the
        // aggregate list Action below is the one producer, and it runs when the
        // list is opened or refreshed.
        expect(scanned).toEqual([]);

        // Select the administered external connection; personal tasks now exist
        // independently of configured source rows.
        const listed = await createTriageListEntriesActionHandler()(
            { v: 1, sources: await selectTestkitConfiguredSources([INSTANCE_ID], collections.sourceInstances), limit: 10, order: 'newest' },
            createContext({ collections, onScan: (op) => scanned.push(op) }),
        );
        expect(listed.configuredSources).toEqual([{
            sourceInstanceId: INSTANCE_ID,
            configurationRowId: rows[0]?.instanceTag,
            source: SOURCE,
            configurationRevision: 1,
            displayLabel: 'Example forge · example/repository',
            available: true,
        }]);
        expect(listed.window.rows.map((row) => row.entryRef.entryId)).toEqual(['17']);

        // And that composed read is what reached the provider.
        expect(scanned).toEqual([SCAN_HANDLE]);
    });

    it('rejects a caller with no currently admitted V1 source contribution before any write', async () => {
        const { collections } = createTestkitCorpusCollections();
        const handler = createTriageAdministerSourceInstanceActionHandler({
            mintSourceInstanceId: () => INSTANCE_ID,
            nowMs: () => 1_000,
        });

        // A different plugin's Settings surface.
        expect(await handler(
            { v: 1, kind: 'create', draft: draft() },
            createContext({ collections, caller: pluginCaller('happier.other.source') }),
        )).toMatchObject({ kind: 'invalidCaller', failure: { class: 'permission' } });

        // A host or automation caller, which owns no source contribution at all.
        expect(await handler(
            { v: 1, kind: 'create', draft: draft() },
            createContext({ collections }),
        )).toMatchObject({ kind: 'invalidCaller', failure: { class: 'permission' } });

        // A retired source: its contribution is no longer admitted.
        expect(await handler(
            { v: 1, kind: 'create', draft: draft() },
            createContext({ collections, caller: pluginCaller(SOURCE.pluginId), admitted: [] }),
        )).toMatchObject({ kind: 'invalidCaller', failure: { class: 'permission' } });

        expect(await readRows(collections)).toHaveLength(0);
    });

    it.each(['ui', 'agent'] as const)('retains pins, links and dispatchable attachments through provider-silent %s removal/reactivation without a daemon', async (surface) => {
        const { collections } = createTestkitCorpusCollections();
        const handler = createTriageAdministerSourceInstanceActionHandler({
            mintSourceInstanceId: () => INSTANCE_ID,
            nowMs: () => 1_000,
        });
        const providerCalls: unknown[] = [];
        const unavailableAccess: string[] = [];
        const context = createContext({ collections, surface,
            ...(surface === 'ui' ? { caller: pluginCaller(SOURCE.pluginId) } : {}),
            onScan: operation => providerCalls.push(operation),
        });
        // These are genuine host service boundaries. No daemon or Message store
        // is available, including as an oracle for deciding what may be removed.
        for (const [target, port] of [
            [context.services, 'sessions'],
            [context.services.storage, 'daemon'],
            [context.services.storage, 'daemonSession'],
        ] as const) Object.defineProperty(target, port, { get() {
            unavailableAccess.push(port);
            throw new Error(`Unavailable host boundary: ${port}`);
        } });

        expect(await handler({ v: 1, kind: 'create', source: SOURCE, draft: draft() }, context))
            .toEqual({ kind: 'active', sourceInstanceId: INSTANCE_ID });
        const entryRef = testkitEntryRef();
        const displayAtMark = { title: 'Keep this pinned entry', scopeLabel: 'example/repository' };
        expect(await setPinned({ collections, entryRef, pinned: true, displayAtMark, nowMs: 10 }))
            .toMatchObject({ status: 'pinned' });
        const sessionId = 'session-retained';
        expect(await linkEntryToSession({ collections, entryRef, sessionId, nowMs: 20,
            display: { locator: testkitLocator(), scopeLabel: displayAtMark.scopeLabel },
        })).toMatchObject({ status: 'linked' });
        const pinsBefore = await readPinnedSection({ collections, limit: 10 });
        const linksBefore = await readTriageSessionLinksPageV1(collections.sessionLinks, { relation: { entryRef } });
        const attachment = { instanceId: 'attachment-retained',
            key: deriveTriageComposerEntryAttachmentKey(entryRef), value: { v: 1 as const, entryRef,
                sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID }, lastKnownLocator: testkitLocator() },
        };
        const request = { sessionId, localId: 'pending-retained', attachments: [attachment] };
        const runtime = createTriageEntryAttachmentRuntime();
        expect(providerCalls).toEqual([]);
        const removed = await handler(
            { v: 1, kind: 'remove', sourceInstanceId: INSTANCE_ID },
            context,
        );

        expect(removed).toEqual({ kind: 'removed', sourceInstanceId: INSTANCE_ID });

        const rows = await readRows(collections);
        expect(rows[0]?.lifecycle).toBe(CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired);
        expect(rows[0]?.retiredReason).toBe('userRemoved');

        // A retired instance disappears from the aggregate list without any
        // durable cleanup, because nothing provider-derived was durable.
        const listed = await createTriageListEntriesActionHandler()(
            { v: 1, sources: await selectTestkitConfiguredSources([INSTANCE_ID], collections.sourceInstances), limit: 10, order: 'newest' },
            context,
        );
        expect(listed.configuredSources).toEqual([]);
        expect(listed.window.rows).toEqual([]);

        const retainedPins = await readPinnedSection({ collections, limit: 10 });
        expect(retainedPins).toEqual(pinsBefore);
        const pin = retainedPins.marks[0];
        if (!pin) throw new Error('Removal lost the pin');
        expect(projectTriagePinnedRow(pin, null)).toMatchObject({
            entryRef, title: displayAtMark.title, scopeLabel: displayAtMark.scopeLabel,
            pinned: true, materialized: false,
        });
        const retainedLinks = await readTriageSessionLinksPageV1(collections.sessionLinks, { relation: { entryRef } });
        expect(retainedLinks).toEqual(linksBefore);
        const link = retainedLinks.links[0];
        if (!link) throw new Error('Removal lost the Session link');
        expect(link.displayPathAtLink).toBe(testkitLocator().displayPath);
        const opened: unknown[] = [];
        expect(await openLinkedSession({ sessionId: link.sessionId, execute: async (action, input) => {
            opened.push({ action, input });
        } })).toEqual({ status: 'opened' });
        expect(opened).toEqual([{ action: 'session.open', input: { sessionId } }]);

        // Exercise the registered attachment consumer, not an unchanged local
        // fixture value: retirement blocks dispatch without erasing the record.
        expect(await runtime.prepareForSend!(request, context)).toEqual({ attachments: [{
            instanceId: attachment.instanceId, status: 'ready', value: attachment.value,
        }] });
        expect((await runtime.resolveForDispatch!(request, context)).attachments)
            .toMatchObject([{ instanceId: attachment.instanceId, status: 'unavailable', retryable: false }]);
        expect(providerCalls).toEqual([]);

        expect(await handler({ v: 1, kind: 'reactivate', sourceInstanceId: INSTANCE_ID, draft: draft() }, context))
            .toEqual({ kind: 'reactivated', sourceInstanceId: INSTANCE_ID });
        const reactivated = await readRows(collections);
        expect(reactivated).toHaveLength(1);
        expect(reactivated[0]?.configured.instance).toEqual({ source: SOURCE, sourceInstanceId: INSTANCE_ID });
        expect(reactivated[0]?.lifecycle).toBe(CORPUS_SOURCE_INSTANCE_LIFECYCLE.active);
        expect(await readPinnedSection({ collections, limit: 10 })).toEqual(pinsBefore);
        expect(await readTriageSessionLinksPageV1(collections.sessionLinks, { relation: { entryRef } })).toEqual(linksBefore);
        expect(providerCalls).toEqual([]);

        // The original attachment becomes usable only through a fresh exact
        // provider read after explicit reactivation of its same configured tuple.
        expect((await runtime.resolveForDispatch!(request, context)).attachments)
            .toMatchObject([{ instanceId: attachment.instanceId, status: 'ready' }]);
        expect(providerCalls).toEqual([GET_HANDLE]);
        expect(unavailableAccess).toEqual([]);
    });
});
