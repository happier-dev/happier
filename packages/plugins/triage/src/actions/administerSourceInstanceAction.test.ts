import type { PluginInvocationCaller, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageSourceInstanceDraftV1Schema,
    type TriageScanResultV1,
    type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import {
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTriageInitialScanOwner } from '../corpus/configuration/initialScan.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../corpus/testkit/observations.test-support.js';
import { createTriageListEntriesActionHandler } from './listEntries.js';
import type { TriageAdmittedSourceV1 } from './listEntries.js';
import { createTriageAdministerSourceInstanceActionHandler } from './administerSourceInstanceAction.js';

/**
 * The one public source-administration Action — the entry point without which
 * nothing writes `source-instances` and the composed list is structurally
 * always empty.
 *
 * The request carries no source, plugin or contribution identity: the host
 * stamps the caller and this handler resolves the caller's own currently
 * admitted V1 source contribution before either the writer or the initial pass
 * runs.
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
    operations: { listInstances: {}, scan: SCAN_HANDLE, get: {} },
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
    admitted?: readonly TriageAdmittedSourceV1[];
    onScan?: (operation: unknown) => void;
}>): PluginInvocationContext {
    return {
        signal: new AbortController().signal,
        ...(input.caller === undefined ? {} : { caller: input.caller }),
        services: {
            storage: {
                account: {
                    collection: (definition: PluginAccountCollectionDefinition) => (
                        definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
                            ? input.collections.sourceInstances
                            : input.collections.userMarks
                    ),
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
                executeAdmittedTargetedOperation: async (operation: unknown): Promise<TriageScanResultV1> => {
                    input.onScan?.(operation);
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
    it('configures a source end to end: one row written by the Action, one scan, one visible entry', async () => {
        const { collections } = createTestkitCorpusCollections();
        const initialScan = createTriageInitialScanOwner({ nowMs: () => 1_000 });
        const settled: Promise<void>[] = [];
        const scanned: unknown[] = [];

        const handler = createTriageAdministerSourceInstanceActionHandler({
            initialScan: {
                request: (request) => {
                    const promise = initialScan.request(request);
                    settled.push(promise);
                    return promise;
                },
                retire: (id) => initialScan.retire(id),
                dispose: () => initialScan.dispose(),
            },
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

        // Exactly one bounded pass follows explicit configuration.
        await Promise.all(settled);
        expect(scanned).toEqual([SCAN_HANDLE]);

        // And the composed aggregate list now returns that source's entries,
        // which it structurally could not do before a row existed.
        const listed = await createTriageListEntriesActionHandler()(
            { v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest' },
            createContext({ collections }),
        );
        expect(listed.configuredSources).toEqual([{
            sourceInstanceId: INSTANCE_ID,
            source: SOURCE,
            displayLabel: 'example/repository',
            available: true,
        }]);
        expect(listed.window.rows.map((row) => row.entryRef.entryId)).toEqual(['17']);

        initialScan.dispose();
    });

    it('rejects a caller with no currently admitted V1 source contribution before any write', async () => {
        const { collections } = createTestkitCorpusCollections();
        const requested: string[] = [];
        const handler = createTriageAdministerSourceInstanceActionHandler({
            initialScan: {
                request: async (request) => { requested.push(request.sourceInstanceId); },
                retire: () => {},
                dispose: () => {},
            },
            mintSourceInstanceId: () => INSTANCE_ID,
            nowMs: () => 1_000,
        });

        // A different plugin's Settings surface.
        expect(await handler(
            { v: 1, kind: 'create', draft: draft() },
            createContext({ collections, caller: pluginCaller('happier.other.source') }),
        )).toEqual({ kind: 'invalidCaller' });

        // A host or automation caller, which owns no source contribution at all.
        expect(await handler(
            { v: 1, kind: 'create', draft: draft() },
            createContext({ collections }),
        )).toEqual({ kind: 'invalidCaller' });

        // A retired source: its contribution is no longer admitted.
        expect(await handler(
            { v: 1, kind: 'create', draft: draft() },
            createContext({ collections, caller: pluginCaller(SOURCE.pluginId), admitted: [] }),
        )).toEqual({ kind: 'invalidCaller' });

        expect(await readRows(collections)).toHaveLength(0);
        expect(requested).toEqual([]);
    });

    it('retires the instance on remove and schedules no pass for it', async () => {
        const { collections } = createTestkitCorpusCollections();
        const requested: string[] = [];
        const retired: string[] = [];
        const handler = createTriageAdministerSourceInstanceActionHandler({
            initialScan: {
                request: async (request) => { requested.push(request.sourceInstanceId); },
                retire: (id) => { retired.push(id); },
                dispose: () => {},
            },
            mintSourceInstanceId: () => INSTANCE_ID,
            nowMs: () => 1_000,
        });
        const context = createContext({ collections, caller: pluginCaller(SOURCE.pluginId) });

        await handler({ v: 1, kind: 'create', draft: draft() }, context);
        const removed = await handler(
            { v: 1, kind: 'remove', sourceInstanceId: INSTANCE_ID },
            context,
        );

        expect(removed).toEqual({ kind: 'removed', sourceInstanceId: INSTANCE_ID });
        expect(requested).toEqual([INSTANCE_ID]);
        expect(retired).toEqual([INSTANCE_ID]);

        const rows = await readRows(collections);
        expect(rows[0]?.lifecycle).toBe(CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired);
        expect(rows[0]?.retiredReason).toBe('userRemoved');

        // A retired instance disappears from the aggregate list without any
        // durable cleanup, because nothing provider-derived was durable.
        const listed = await createTriageListEntriesActionHandler()(
            { v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest' },
            createContext({ collections }),
        );
        expect(listed.configuredSources).toEqual([]);
        expect(listed.window.rows).toEqual([]);
    });
});
