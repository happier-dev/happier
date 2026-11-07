import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../projection/listWindow.js';
import { createTriageListWindowStore } from '../projection/listWindowStore.js';
import { readTriageListFailureNotice, resolveTriageListShellState } from '../ui/shell/windowState.js';
import { CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../corpus/testkit/observations.test-support.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import {
    createTriageListEntriesActionHandler,
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from './listEntries.js';
import {
    MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    TriageListEntriesResultV1Schema,
    type TriageListEntriesInputV1,
    type TriageListEntriesResultV1,
} from './listEntriesProtocol.js';

/**
 * The registered Action handler reaches the composed vertical through the exact
 * invocation context the host supplies — the declared Collection, this target's
 * own admitted contribution view, and the host Action dispatcher — and adds no
 * dispatcher, registry or cache of its own.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

describe('the aggregate list Action handler', () => {
    it('reads the configured Collection and the admitted source through the invocation context', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: `a${'0'.repeat(42)}`,
            sourceQualifiedId: `${SOURCE.pluginId}/${SOURCE.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: 1,
            configured: TriageConfiguredSourceInstanceV1Schema.parse({
                v: 1,
                instance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
                binding: {
                    purpose: 'triage-source',
                    account: { service: { pluginId: SOURCE.pluginId, localId: 'accounts' }, accountId: 'account-1' },
                },
                localInstanceKey: 'example/repository',
                configuration: { v: 1, token: 'routing-token' },
            }),
        }));

        const scanHandle = { role: 'scan' };
        const admitted = [{
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
                purpose: 'triage-source',
                displayName: 'Example forge',
                kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
            },
            operations: { listInstances: {}, scan: scanHandle, get: {} },
            surfaces: { detail: {} },
            // Host-created admitted entries are not constructible from plugin
            // code; the fixture stands in for the host at that one boundary.
        } as unknown as TriageAdmittedSourceV1];

        const observed: unknown[] = [];
        let disposedObservations = 0;
        const dispatched: unknown[] = [];
        let scanFailure: unknown;

        const context = {
            signal: new AbortController().signal,
            services: {
                storage: {
                    account: {
                        collection: (definition: PluginAccountCollectionDefinition) => (
                            definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
                                ? collections.sourceInstances
                                : collections.userMarks
                        ),
                    },
                },
                targetedContributions: {
                    observeForSelf: (point: unknown) => {
                        observed.push(point);
                        return {
                            readCurrent: async () => ({ generation: 'generation-1', contributions: admitted }),
                            dispose: () => { disposedObservations += 1; },
                        };
                    },
                },
                actions: {
                    executeAdmittedTargetedOperation: async (operation: unknown): Promise<TriageScanResultV1> => {
                        dispatched.push(operation);
                        if (scanFailure) throw scanFailure;
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
        } as unknown as PluginAccountActionContext;

        const result = await createTriageListEntriesActionHandler()({
            v: 1,
            sources: { kind: 'allConfigured' },
            limit: 10,
            order: 'newest',
        }, context);

        // Admission is observed once to grant the scan handle and once at the
        // result boundary to fence an immutable contribution replacement.
        expect(observed).toEqual([
            TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
            TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
        ]);
        expect(disposedObservations).toBe(2);
        // Only the original host-created handle carries authority, so it is
        // passed through untouched rather than reconstructed.
        expect(dispatched).toEqual([scanHandle]);
        expect(result.configuredSources).toEqual([{
            sourceInstanceId: INSTANCE_ID,
            source: SOURCE,
            configurationRevision: 1,
            available: true,
        }]);
        expect(result.window.rows.map((row) => row.entryRef.entryId)).toEqual(['17']);
        expect(result.window.coverage).toBe('complete');

        // Real handler -> strict wire consumer -> mounted store -> existing failure notice.
        // The source id is deliberately external; no bundled-plugin path may be required.
        scanFailure = new PluginError({
            code: 'plugin_action_caller_unavailable', retryable: false,
            message: 'private provider message', details: { credential: 'private provider data' },
        });
        let listReadFailure: unknown;
        const store = createTriageListWindowStore({
            readEntries: async input => {
                if (listReadFailure) throw listReadFailure;
                return TriageListEntriesResultV1Schema.parse(
                    await createTriageListEntriesActionHandler()(input, context),
                );
            },
            nowMs: () => 1000,
        });
        await store.refresh('view');
        const snapshot = store.getSnapshot();
        expect(snapshot.window?.lanes[0]?.health).toEqual({
            kind: 'unavailable', error: { code: 'plugin_action_caller_unavailable', retryable: false },
        });
        expect(snapshot.unreadableSources?.[0]).toMatchObject({
            code: 'plugin_action_caller_unavailable', retryable: false,
        });
        const state = resolveTriageListShellState(snapshot);
        expect(state.kind).toBe('window');
        if (state.kind !== 'window' || !state.failure) throw new Error('Expected named source failure');
        expect(state.failure.sources[0]).toMatchObject({ code: 'plugin_action_caller_unavailable', retryable: false });
        expect(readTriageListFailureNotice(state.failure).description).not.toContain('plugin_action_caller_unavailable');
        expect(JSON.stringify(snapshot)).not.toContain('private provider');
        // A later transport refusal must not keep diagnosing the earlier source scan.
        listReadFailure = new PluginError({ code: 'transport_unavailable', retryable: true });
        await store.refresh('manual');
        expect(store.getSnapshot().unreadableSources?.[0]?.code).not.toBe('plugin_action_caller_unavailable');
        listReadFailure = undefined;
        scanFailure = undefined;
        await store.refresh('manual');
        expect(store.getSnapshot().unreadableSources).toBeUndefined();
        expect(store.getSnapshot().window?.coverage).toBe('complete');
        store.dispose();
    });
});

describe('the aggregate list pass persists nothing provider-derived', () => {
    /**
     * The `r0.16` ruling is that no provider entity is durable anywhere. Nothing
     * proved it at the one place a resurrected cache would actually be written:
     * the registered handler binds all three declared Collections, so a later
     * "small" entry table, health row or detail cache has a handle to write
     * with. Every other test in this package would still pass with one.
     *
     * The pass below is a real multi-page walk against Collections that throw on
     * any mutation, so the first durable write of any kind fails here — and only
     * here.
     */
    it('completes a multi-page walk against Collections that reject every write', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
            instanceTag: paddedInstanceTag('a'),
            sourceInstanceId: INSTANCE_ID,
            configuredAtMs: 1,
        })));

        const rejectWrites = (handle: (typeof collections)[keyof typeof collections]) => ({
            ...handle,
            get: handle.get.bind(handle),
            query: handle.query.bind(handle),
            batch: () => {
                throw new Error('The list pass wrote a durable row.');
            },
        });

        let page = 0;
        const context = {
            signal: new AbortController().signal,
            services: {
                storage: {
                    account: {
                        collection: (definition: PluginAccountCollectionDefinition) => (
                            definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
                                ? rejectWrites(collections.sourceInstances)
                                : rejectWrites(collections.userMarks)
                        ),
                    },
                },
                targetedContributions: {
                    observeForSelf: () => ({
                        readCurrent: async () => ({ generation: 'generation-1', contributions: [ADMITTED_SOURCE] }),
                        dispose: () => {},
                    }),
                },
                actions: {
                    executeAdmittedTargetedOperation: async (): Promise<TriageScanResultV1> => {
                        page += 1;
                        const observation = {
                            kind: 'present',
                            localRef: {
                                kindId: 'pull-request',
                                collisionScope: 'example/repository',
                                entryId: String(page),
                            },
                            locator: testkitLocator(),
                            snapshot: testkitSnapshot(),
                            viewer: testkitViewer(),
                        } as const;
                        return page < 2
                            ? {
                                kind: 'page',
                                observations: [observation],
                                evidence: { kind: 'partial', reason: 'more-pages' },
                                continuation: { v: 1, token: 'page-2' },
                            }
                            : { kind: 'complete', observations: [observation], evidence: { kind: 'walkFinished' } };
                    },
                },
            },
        } as unknown as PluginInvocationContext;

        const first = await createTriageListEntriesActionHandler()({
            v: 1,
            sources: { kind: 'allConfigured' },
            limit: 10,
            order: 'newest',
        }, context);
        const result = await createTriageListEntriesActionHandler()({
            v: 1,
            sources: { kind: 'allConfigured' },
            limit: 10,
            order: 'newest',
            resume: first.window.continuations,
        }, context);

        // The walk really happened; a pass that never ran would pass this test
        // for the wrong reason.
        expect(page).toBe(2);
        expect(first.window.rows.map((row) => row.entryRef.entryId)).toEqual(['1']);
        expect(result.window.rows.map((row) => row.entryRef.entryId)).toEqual(['2']);
        expect(result.window.coverage).toBe('complete');
    });
});

/**
 * Coverage is a claim about what was **asked**, not about what answered.
 *
 * A configured source the pass could not invoke — because no contribution is
 * admitted for it, or because more sources are configured than one result can
 * name — is a source whose entries are missing from this window. Counting only
 * the lanes that ran makes an empty list say "every configured source answered"
 * while an entire connection was never reached, and a reader who is told
 * nothing needs them stops looking.
 */

const OTHER_SOURCE = Object.freeze({ pluginId: 'happier.other.source', localId: 'other-forge' });
const SECOND_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

function paddedInstanceTag(seed: string): string {
    return `${seed}${'0'.repeat(43 - seed.length)}`;
}

function numberedInstanceId(index: number): string {
    return `33333333-3333-4333-8333-33333333${String(index).padStart(4, '0')}`;
}

function configuredRow(input: Readonly<{
    instanceTag: string;
    sourceInstanceId: string;
    configuredAtMs: number;
    source?: Readonly<{ pluginId: string; localId: string }>;
}>): CorpusSourceInstanceRowV1 {
    // The projected qualified id is derived from the configured source by the
    // one lifecycle writer, so a row where they disagree is not producible.
    const source = input.source ?? SOURCE;
    return {
        instanceTag: input.instanceTag,
        sourceQualifiedId: `${source.pluginId}/${source.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: input.configuredAtMs,
        configured: TriageConfiguredSourceInstanceV1Schema.parse({
            v: 1,
            instance: { source, sourceInstanceId: input.sourceInstanceId },
            binding: {
                purpose: 'triage-source',
                account: {
                    service: { pluginId: source.pluginId, localId: 'accounts' },
                    accountId: `account-${input.configuredAtMs}`,
                },
            },
            localInstanceKey: `example/repository-${input.configuredAtMs}`,
            configuration: { v: 1, token: 'routing-token' },
        }),
    };
}

const SCAN_HANDLE = { role: 'scan' };

const ADMITTED_SOURCE = {
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
        purpose: 'triage-source',
        displayName: 'Example forge',
        kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
    },
    operations: { listInstances: {}, scan: SCAN_HANDLE, get: {} },
    surfaces: { detail: {} },
    // Host-created admitted entries are not constructible from plugin code; the
    // fixture stands in for the host at that one boundary.
} as unknown as TriageAdmittedSourceV1;

/** Every lane finishes its walk, so only an unasked source can make it partial. */
const finishedWalk: TriageAdmittedOperationExecutorV1 = async () => ({
    kind: 'complete',
    observations: [],
    evidence: { kind: 'walkFinished' },
});

describe('the aggregate list coverage claim', () => {
    it.each([
        ['refused', new PluginError({ code: 'plugin_action_caller_unavailable', retryable: false }),
            'plugin_action_caller_unavailable'],
        ['unknown', new PluginError({ code: 'plugin_action_outcome_unknown', retryable: false }),
            'plugin_action_outcome_unknown'],
        ['native Machine absent', new PluginError({ code: 'plugin_action_machine_required', retryable: false }),
            'plugin_action_machine_required'],
        ['J3 admission refused', new PluginError({ code: 'plugin_action_form_connected_account_options_unavailable', retryable: false }),
            'plugin_action_form_connected_account_options_unavailable'],
        ['unclassified', new Error('private invocation outcome'), 'triage/scanInvocationRejected'],
    ] as const)('keeps %s source outcomes distinct from a successful empty walk', async (_kind, refusal, code) => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
            instanceTag: paddedInstanceTag('a'), sourceInstanceId: INSTANCE_ID, configuredAtMs: 1,
        })));
        const admitted: TriageAdmittedSourceV1 = {
            ...ADMITTED_SOURCE,
            descriptor: {
                ...ADMITTED_SOURCE.descriptor,
                scopeUnit: { singularLabel: 'Project', pluralLabel: 'Projects' },
            },
            operations: {
                ...ADMITTED_SOURCE.operations,
                // Only the real host can mint an admitted execution handle.
                listScopeUnits: {} as NonNullable<TriageAdmittedSourceV1['operations']['listScopeUnits']>,
            },
        };
        let unavailable = true;
        let scopeReads = 0;
        let scans = 0;
        let releaseScan = (): void => {};
        const firstScan = new Promise<void>((resolve) => { releaseScan = resolve; });
        const limits: number[] = [];
        const store = createTriageListWindowStore({
            readEntries: async (input) => {
                limits.push(input.limit);
                return TriageListEntriesResultV1Schema.parse(await listTriageEntries(input, {
                    sourceInstances: collections.sourceInstances,
                    readAdmittedSources: async () => [admitted],
                    executeScopeUnits: async () => {
                        scopeReads += 1;
                        if (unavailable) throw refusal;
                        return { kind: 'page', status: 'complete', selection: { kind: 'all' }, units: [] };
                    },
                    executeScan: async () => {
                        scans += 1;
                        if (scans === 1) await firstScan;
                        if (unavailable) throw refusal;
                        return { kind: 'complete', observations: [], evidence: { kind: 'walkFinished' } };
                    },
                    nowMs: () => 1000,
                }));
            },
            nowMs: () => 1000,
        });

        const refreshing = store.refresh('view');
        await vi.waitFor(() => expect(scans).toBe(1));
        expect(store.getSnapshot().pending).toBe('initial');
        expect(store.getSnapshot().window).toBeUndefined();
        releaseScan();
        await refreshing;
        const snapshot = store.getSnapshot();
        expect(limits).toEqual([0, MAX_TRIAGE_LIST_WINDOW_ROWS_V1]);
        expect({ scopeReads, scans }).toEqual({ scopeReads: 2, scans: 1 });
        expect(snapshot.configuredSources[0]?.scope?.projection).toEqual({
            kind: 'failed', failure: { class: 'unknown', code: refusal instanceof PluginError ? code : 'scope_projection_unavailable' },
        });
        expect(snapshot.window?.rows).toEqual([]);
        expect(snapshot.window?.coverage).toBe('partial');
        expect(snapshot.window?.lanes[0]).toMatchObject({
            health: { kind: 'unavailable', error: { code } }, exhausted: false,
        });
        const state = resolveTriageListShellState(snapshot);
        expect(state.kind).toBe('window');
        if (state.kind !== 'window') throw new Error('Expected an incomplete window');
        expect(state.failure?.sources[0]).toMatchObject({ sourceInstanceId: INSTANCE_ID, code });
        expect(JSON.stringify(snapshot)).not.toContain('private invocation outcome');

        unavailable = false;
        await store.refresh('manual');
        const recovered = store.getSnapshot();
        expect(limits).toEqual([0, MAX_TRIAGE_LIST_WINDOW_ROWS_V1, 0, MAX_TRIAGE_LIST_WINDOW_ROWS_V1]);
        expect({ scopeReads, scans }).toEqual({ scopeReads: 4, scans: 2 });
        expect(recovered.window?.rows).toEqual([]);
        expect(recovered.window?.coverage).toBe('complete');
        expect(recovered.unreadableSources).toBeUndefined();
        const recoveredState = resolveTriageListShellState(recovered);
        expect(recoveredState.kind).toBe('window');
        if (recoveredState.kind !== 'window') throw new Error('Expected a completed empty window');
        expect(recoveredState.failure).toBeNull();
        store.dispose();
    });

    it('does not publish a provider result after its configured row is removed during the scan', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const seeded = control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
            instanceTag: paddedInstanceTag('a'),
            sourceInstanceId: INSTANCE_ID,
            configuredAtMs: 1,
        })));
        let release = (): void => {};
        const held = new Promise<void>((resolve) => { release = resolve; });
        let started = false;
        const resultPromise = listTriageEntries({
            v: 1,
            sources: { kind: 'selected', sourceInstanceIds: [INSTANCE_ID] },
            limit: 10,
            order: 'newest',
        }, {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => [ADMITTED_SOURCE],
            executeScan: async () => {
                started = true;
                await held;
                return {
                    kind: 'page',
                    observations: [{
                        kind: 'present',
                        localRef: {
                            kindId: 'pull-request',
                            collisionScope: 'example/repository',
                            entryId: 'late-row',
                        },
                        locator: testkitLocator(),
                        snapshot: testkitSnapshot(),
                        viewer: testkitViewer(),
                    }],
                    evidence: { kind: 'partial', reason: 'more-pages' },
                    continuation: { v: 1, token: 'late-frontier' },
                };
            },
            nowMs: () => 1_760_000_000_000,
        });

        await vi.waitFor(() => expect(started).toBe(true));
        control.sourceInstances.tombstone(seeded.rowId);
        release();
        const result = await resultPromise;

        expect(result.configuredSources).toEqual([]);
        expect(result.window.rows).toEqual([]);
        expect(result.window.lanes).toEqual([]);
        expect(result.window.continuations).toBeUndefined();
        // A request whose sole lane retired while it was running has no settled
        // lane evidence. The empty configured summary is the lifecycle truth;
        // coverage stays conservative rather than laundering cancellation into
        // a completed provider walk.
        expect(result.window.coverage).toBe('partial');
    });

    it('does not invoke a source whose admitted descriptor has duplicate kind ids', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
            instanceTag: paddedInstanceTag('a'),
            sourceInstanceId: INSTANCE_ID,
            configuredAtMs: 1,
        })));
        const duplicateDescriptor = {
            ...ADMITTED_SOURCE,
            descriptor: {
                ...ADMITTED_SOURCE.descriptor,
                kinds: [
                    ADMITTED_SOURCE.descriptor.kinds[0],
                    { ...ADMITTED_SOURCE.descriptor.kinds[0], displayName: 'Duplicate' },
                ],
            },
        } as unknown as TriageAdmittedSourceV1;
        const executeScan = vi.fn(finishedWalk);

        const result = await listTriageEntries({
            v: 1,
            sources: { kind: 'allConfigured' },
            limit: 10,
            order: 'newest',
        }, {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => [duplicateDescriptor],
            executeScan,
            nowMs: () => 1_760_000_000_000,
        });

        expect(executeScan).not.toHaveBeenCalled();
        expect(result.configuredSources).toEqual([expect.objectContaining({ available: false })]);
        expect(result.window.coverage).toBe('partial');
    });

    it('counts a configured source with no admitted contribution as an unfinished lane', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
            instanceTag: paddedInstanceTag('a'),
            sourceInstanceId: INSTANCE_ID,
            configuredAtMs: 1,
        })));
        // The second configured source resolves to no admitted contribution: it
        // is exactly the connection that cannot be asked.
        control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
            instanceTag: paddedInstanceTag('b'),
            sourceInstanceId: SECOND_INSTANCE_ID,
            configuredAtMs: 2,
            source: OTHER_SOURCE,
        })));

        const result = await listTriageEntries({
            v: 1,
            sources: { kind: 'allConfigured' },
            limit: 10,
            order: 'newest',
        }, {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => [ADMITTED_SOURCE],
            executeScan: finishedWalk,
            nowMs: () => 1_760_000_000_000,
        });

        expect(result.configuredSources.map((source) => source.available)).toEqual([true, false]);
        // The unasked source is a lane of the window, not an absence from it.
        expect(result.window.lanes).toContainEqual({
            sourceInstanceId: SECOND_INSTANCE_ID,
            source: OTHER_SOURCE,
            health: { kind: 'unavailable' },
            exhausted: false,
        });
        expect(result.window.coverage).toBe('partial');
    });

    it('pages configured source summaries through the Collection cursor without reading providers', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        for (let index = 0; index <= MAX_TRIAGE_LIST_SOURCE_BATCH_V1; index += 1) {
            control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
                instanceTag: paddedInstanceTag(`s${String(index).padStart(3, '0')}`),
                sourceInstanceId: numberedInstanceId(index),
                configuredAtMs: index + 1,
            })));
        }

        const first = await listTriageEntries({
            v: 1,
            sources: { kind: 'allConfigured' },
            limit: 0,
            order: 'newest',
        }, {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => [ADMITTED_SOURCE],
            executeScan: finishedWalk,
            nowMs: () => 1_760_000_000_000,
        });
        expect(first.configuredSources).toHaveLength(MAX_TRIAGE_LIST_SOURCE_BATCH_V1);
        expect(first.configuredSourcesStatus).toBe('truncated');
        expect(first.configuredSourcesNextCursor).toBeDefined();
        expect(first.window.rows).toEqual([]);
        const cursor = first.configuredSourcesNextCursor;
        if (cursor === undefined) throw new Error('The first configured-source page must carry its cursor.');

        const second = await listTriageEntries({
            v: 1,
            sources: {
                kind: 'allConfigured',
                cursor,
            },
            limit: 0,
            order: 'newest',
        }, {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => [ADMITTED_SOURCE],
            executeScan: finishedWalk,
            nowMs: () => 1_760_000_000_000,
        });

        expect(second.configuredSources).toHaveLength(1);
        expect(second.configuredSourcesStatus).toBe('complete');
        expect(second.configuredSourcesNextCursor).toBeUndefined();
        expect(second.window.rows).toEqual([]);
    });
});

/**
 * Paging a mixed multi-source window.
 *
 * `PLAN.md` §0a A9: the list pages exactly the way its first page loaded —
 * every walked lane resuming its own frontier through the same rotation. The
 * predecessor admitted one continuation, and only for a request that selected
 * one instance, on the arithmetic that thirty-two maximal tokens overflow the
 * host byte gate. The set is bounded against that gate directly instead, and
 * the result is never refused whole over a paging token.
 */

/** A page that fills the submitted limit and asks to be called again. */
function pagingScan(input: Readonly<{
    /** Tokens by lane, so a resumed lane can be told apart from a restarted one. */
    tokenFor: (sourceInstanceId: string) => string;
    seen?: Map<string, unknown>;
    limit: number;
}>): TriageAdmittedOperationExecutorV1 {
    const geometry = new Map<string, number>();
    return async (_operation, scanInput): Promise<TriageScanResultV1> => {
        const sourceInstanceId = scanInput.instance.instance.sourceInstanceId;
        if (!input.seen?.has(sourceInstanceId)) input.seen?.set(sourceInstanceId, scanInput.page);
        if (scanInput.page.kind === 'initial') geometry.set(sourceInstanceId, scanInput.page.limit);
        const limit = Math.min(input.limit, geometry.get(sourceInstanceId) ?? input.limit);
        return {
            kind: 'page',
            observations: Array.from({ length: limit }, (_unused, index) => ({
                kind: 'present',
                localRef: {
                    kindId: 'pull-request',
                    collisionScope: 'example/repository',
                    entryId: `${sourceInstanceId}-${index}`,
                },
                locator: testkitLocator(),
                snapshot: testkitSnapshot(),
                viewer: testkitViewer(),
            })),
            evidence: { kind: 'partial', reason: 'more-pages' },
            continuation: { v: 1, token: input.tokenFor(sourceInstanceId) },
        };
    };
}

function seedInstances(
    control: ReturnType<typeof createTestkitCorpusCollections>['control'],
    count: number,
): readonly string[] {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
        const sourceInstanceId = numberedInstanceId(index);
        ids.push(sourceInstanceId);
        control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
            instanceTag: paddedInstanceTag(`s${String(index).padStart(3, '0')}`),
            sourceInstanceId,
            configuredAtMs: index + 1,
        })));
    }
    return ids;
}

describe('the aggregate list continuation set', () => {
    it.each([
        { limit: 4, minimum: 10, total: 2 },
        { limit: 1, minimum: 10, total: 12 },
        { limit: 1, minimum: MAX_TRIAGE_LIST_WINDOW_ROWS_V1, total: MAX_TRIAGE_LIST_WINDOW_ROWS_V1 },
    ])('carries native pages whole across a $limit-row share with minimum $minimum and $total entries', async ({ limit, minimum, total }) => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
            instanceTag: paddedInstanceTag('a'), sourceInstanceId: INSTANCE_ID, configuredAtMs: 1,
        })));
        const submitted: number[] = [];
        const deps = {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => [{ ...ADMITTED_SOURCE,
                descriptor: { ...ADMITTED_SOURCE.descriptor, minimumScanPageSize: minimum } }],
            executeScan: async (_operation, input): Promise<TriageScanResultV1> => {
                const offset = input.page.kind === 'initial' ? 0 : minimum;
                if (input.page.kind === 'initial') submitted.push(input.page.limit);
                else expect(input.page.continuation.token).toBe('native-next');
                const observations = Array.from({ length: Math.min(minimum, total - offset) }, (_, index) => ({
                    kind: 'present' as const,
                    localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: String(offset + index) },
                    locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
                }));
                return offset + observations.length < total
                    ? { kind: 'page', observations, evidence: { kind: 'partial', reason: 'more-pages' },
                        continuation: { v: 1, token: 'native-next' } }
                    : { kind: 'complete', observations, evidence: { kind: 'walkFinished' } };
            },
            nowMs: () => 1000,
        } satisfies Parameters<typeof listTriageEntries>[1];
        const input = { v: 1, sources: { kind: 'selected', sourceInstanceIds: [INSTANCE_ID] }, limit, order: 'newest' } as const;
        const first = TriageListEntriesResultV1Schema.parse(await listTriageEntries(input, deps));
        expect(submitted).toEqual([minimum]);
        expect(first.window.rows).toHaveLength(Math.min(minimum, total));
        const rows = [...first.window.rows];
        if (total > minimum) {
            expect(first.window.continuations).toEqual([{ sourceInstanceId: INSTANCE_ID, pageLimit: minimum,
                continuation: { v: 1, token: 'native-next' } }]);
            const second = TriageListEntriesResultV1Schema.parse(await listTriageEntries({ ...input, resume: first.window.continuations }, deps));
            rows.push(...second.window.rows);
            expect(second.window.coverage).toBe('complete');
            expect(second.window.continuations ?? []).toEqual([]);
        } else expect(first.window.coverage).toBe('complete');
        expect(new Set(rows.map(row => row.entryRef.entryId))).toEqual(new Set(Array.from({ length: total }, (_, index) => String(index))));
        expect(rows).toHaveLength(total);
    });

    it('keeps every native minimum-page row and rotates a deferred peer before deepening that source', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const nativeSource = { pluginId: 'example.native-pages', localId: 'forge' };
        control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
            instanceTag: paddedInstanceTag('a'), sourceInstanceId: INSTANCE_ID, configuredAtMs: 1, source: nativeSource,
        })));
        control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
            instanceTag: paddedInstanceTag('b'), sourceInstanceId: SECOND_INSTANCE_ID, configuredAtMs: 2,
        })));
        const native = { ...ADMITTED_SOURCE,
            contributor: { ...ADMITTED_SOURCE.contributor, pluginId: nativeSource.pluginId, contributionId: nativeSource.localId },
            descriptor: { ...ADMITTED_SOURCE.descriptor, minimumScanPageSize: 10 },
        };
        const submitted: { id: string; limit: number }[] = [];
        const deps = {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => [native, ADMITTED_SOURCE],
            executeScan: async (_operation, input): Promise<TriageScanResultV1> => {
                const id = input.instance.instance.sourceInstanceId;
                const nativePage = id === INSTANCE_ID;
                const limit = input.page.kind === 'initial' ? input.page.limit : 10;
                submitted.push({ id, limit });
                if (nativePage && limit < 10) return { kind: 'failed', failure: {
                    class: 'unsupportedContract', code: 'example/minimum-page', detail: 'Native pages require ten rows.',
                } };
                const offset = input.page.kind === 'continuation' ? 10 : 0;
                const count = nativePage ? Math.min(limit, 12 - offset) : 5;
                const observations = Array.from({ length: count }, (_, index) => ({
                    kind: 'present' as const,
                    localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: `${id}-${offset + index}` },
                    locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
                }));
                return nativePage && offset === 0
                    ? { kind: 'page', observations, evidence: { kind: 'partial', reason: 'more-pages' }, continuation: { v: 1, token: 'native-next' } }
                    : { kind: 'complete', observations, evidence: { kind: 'walkFinished' } };
            },
            nowMs: () => 1000,
        } satisfies Parameters<typeof listTriageEntries>[1];
        const initial = { v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest' } as const;
        const first = await listTriageEntries(initial, deps);
        expect(submitted).toEqual([{ id: INSTANCE_ID, limit: 10 }]);
        expect(first.window.rows).toHaveLength(10);
        expect(first.window.continuations).toEqual([
            { sourceInstanceId: SECOND_INSTANCE_ID, pageLimit: 5 },
            { sourceInstanceId: INSTANCE_ID, pageLimit: 10, continuation: { v: 1, token: 'native-next' } },
        ]);
        const second = await listTriageEntries({ ...initial, resume: first.window.continuations }, deps);
        expect(submitted[1]).toEqual({ id: SECOND_INSTANCE_ID, limit: 5 });
        expect(second.window.rows).toHaveLength(5);
        const third = await listTriageEntries({ ...initial, resume: second.window.continuations }, deps);
        const rows = [...first.window.rows, ...second.window.rows, ...third.window.rows];
        expect(rows).toHaveLength(17);
        expect(new Set(rows.map(row => row.entryRef.entryId)).size).toBe(17);
        expect(third.window.coverage).toBe('complete');
        expect(third.window.continuations ?? []).toEqual([]);
    });
    it('starts both post-provider currentness reads before either boundary settles', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const ids = seedInstances(control, 1);
        let releaseConfiguration = (): void => {};
        const configurationPending = new Promise<void>(resolve => { releaseConfiguration = resolve; });
        let markPostReadStarted = (): void => {};
        const postReadStarted = new Promise<void>(resolve => { markPostReadStarted = resolve; });
        let configurationReads = 0;
        let admissionReads = 0;
        const result = listTriageEntries({ v: 1, sources: { kind: 'selected', sourceInstanceIds: ids },
            limit: 10, order: 'newest' }, {
            // Only the persistent-store boundary is held; configuration
            // decoding, source admission and the aggregate remain real.
            sourceInstances: { query: async (...args) => {
                configurationReads++;
                if (configurationReads === 2) {
                    markPostReadStarted();
                    await configurationPending;
                }
                return collections.sourceInstances.query(...args);
            } },
            readAdmittedSources: async () => { admissionReads++; return [ADMITTED_SOURCE]; },
            executeScan: async () => ({ kind: 'complete', observations: [], evidence: { kind: 'walkFinished' } }),
            nowMs: () => 1000,
        });
        try {
            await postReadStarted;
            // Initial admission plus the independent post-provider fence.
            // Neither fence may serialize its start behind the other's I/O.
            expect(admissionReads).toBe(2);
        } finally {
            releaseConfiguration();
            await result;
        }
        expect(configurationReads).toBe(2);
        expect((await result).configuredSources.map(source => source.sourceInstanceId)).toEqual(ids);
    });

    it('reports one frontier per walked connection rather than one for the whole request', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const [first, second] = seedInstances(control, 2);

        const result = await listTriageEntries({
            v: 1,
            sources: { kind: 'allConfigured' },
            limit: 10,
            order: 'newest',
        }, {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => [ADMITTED_SOURCE],
            executeScan: pagingScan({ tokenFor: (id) => `next:${id}`, limit: 10 }),
            nowMs: () => 1_760_000_000_000,
        });

        // Both lanes stopped with more to give, and each names itself. A window
        // that carried one of them is a window whose other connection restarts
        // its walk on every press.
        expect(result.window.continuations).toEqual([
            { sourceInstanceId: first, pageLimit: 5, continuation: { v: 1, token: `next:${first}` } },
            { sourceInstanceId: second, pageLimit: 5, continuation: { v: 1, token: `next:${second}` } },
        ]);
        expect(result.window.coverage).toBe('partial');
    });

    it('resumes each named lane and starts other explicitly selected lanes at their first page', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const [first, second, third] = seedInstances(control, 3);
        const seen = new Map<string, unknown>();

        await listTriageEntries({
            v: 1,
            sources: { kind: 'selected', sourceInstanceIds: [first, second, third] },
            limit: 10,
            order: 'newest',
            resume: [
                { sourceInstanceId: second, pageLimit: 3, continuation: { v: 1, token: 'frontier-of-second' } },
                // A frontier for a connection this request does not walk. It is
                // ignored rather than refused: refusing would cost the caller
                // the whole list over a stale token.
                { sourceInstanceId: SECOND_INSTANCE_ID, pageLimit: 1, continuation: { v: 1, token: 'stale' } },
            ],
        }, {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => [ADMITTED_SOURCE],
            executeScan: pagingScan({ tokenFor: (id) => `next:${id}`, seen, limit: 10 }),
            nowMs: () => 1_760_000_000_000,
        });

        expect(seen.get(second)).toEqual({
            kind: 'continuation',
            continuation: { v: 1, token: 'frontier-of-second' },
        });
        expect(seen.get(first)).toEqual({ kind: 'initial', limit: 3 });
        expect(seen.get(third)).toEqual({ kind: 'initial', limit: 3 });
    });

    it('keeps each resumed lane on the page geometry that minted its continuation after peers compact', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const [first, second] = seedInstances(control, 2);
        const observations = (sourceInstanceId: string, count: number, page: string) => Array.from(
            { length: count },
            (_unused, index) => ({
                kind: 'present' as const,
                localRef: {
                    kindId: 'pull-request',
                    collisionScope: 'example/repository',
                    entryId: `${sourceInstanceId}-${page}-${index}`,
                },
                locator: testkitLocator(),
                snapshot: testkitSnapshot(),
                viewer: testkitViewer(),
            }),
        );
        const executeScan: TriageAdmittedOperationExecutorV1 = async (_operation, input) => {
            const sourceInstanceId = input.instance.instance.sourceInstanceId;
            if (input.page.kind === 'initial') {
                return sourceInstanceId === first
                    ? {
                        kind: 'complete',
                        observations: observations(sourceInstanceId, 5, 'initial'),
                        evidence: { kind: 'walkFinished' },
                    }
                    : {
                        kind: 'page',
                        observations: observations(sourceInstanceId, 5, 'initial'),
                        evidence: { kind: 'partial', reason: 'more-pages' },
                        continuation: { v: 1, token: 'second-page' },
                    };
            }
            // Valid against the compacted request's recomputed share of 10, but
            // invalid against the source walk's original per-page geometry of 5.
            return {
                kind: 'complete',
                observations: observations(sourceInstanceId, 6, 'continued'),
                evidence: { kind: 'walkFinished' },
            };
        };

        const firstPage = await listTriageEntries({
            v: 1,
            sources: { kind: 'allConfigured' },
            limit: 10,
            order: 'newest',
        }, {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => [ADMITTED_SOURCE],
            executeScan,
            nowMs: () => 1_760_000_000_000,
        });
        expect(firstPage.window.continuations).toEqual([{
            sourceInstanceId: second,
            pageLimit: 5,
            continuation: { v: 1, token: 'second-page' },
        }]);

        const compacted = await listTriageEntries({
            v: 1,
            sources: { kind: 'selected', sourceInstanceIds: [second] },
            limit: 10,
            order: 'newest',
            resume: firstPage.window.continuations,
        }, {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => [ADMITTED_SOURCE],
            executeScan,
            nowMs: () => 1_760_000_000_001,
        });

        expect(compacted.window.rows).toEqual([]);
        expect(compacted.window.lanes[0]?.health).toMatchObject({
            kind: 'failed',
            failure: { class: 'unsupportedContract', code: 'triage/pageLimitExceeded' },
        });
        expect(compacted.window.continuations).toBeUndefined();
    });

    /**
     * The deciding case for `PLAN.md` §0a A9a.
     *
     * The predecessor packed the frontier set against a fixed byte budget and
     * dropped the lowest-priority tail, calling a restarted lane "a rounding
     * error the user never sees". It is not. A dropped lane restarts at page
     * one, the rows it replays are deduped away while still spending its share
     * of the row budget, the set overflows the same way on the next page, and
     * its token is dropped again — for the same lanes every time, because the
     * drop order is the stable rotation order. Unique older rows in the tail
     * lanes become PERMANENTLY unreachable, which is the silent-failure class
     * this surface exists to refuse.
     *
     * So the set is never cut. The row budget is derived from what the gate
     * leaves after the frontiers the walked lanes may spend, so the whole set
     * always fits and no lane is ever asked to restart.
     */
    it('reaches a deeper lane\'s older rows instead of starving the tail of the rotation', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const ids = seedInstances(control, MAX_TRIAGE_LIST_SOURCE_BATCH_V1);
        const tail = ids[ids.length - 1] ?? '';
        const pages = new Map<string, number>();
        // Every lane spends a frontier wider than the retired 4 KiB feature
        // cap. The Action envelope remains the single byte boundary.
        const maximalToken = (page: number): string => {
            const marker = `p${page}:`;
            return `${marker}${'"'.repeat((32 * 1024) - marker.length)}`;
        };
        // The page geometry a source is told once, on the initial ask, and keeps
        // inside its own frontier: the continuation arm carries no limit, so a
        // resumed page that returned a different size would be a source-contract
        // failure rather than a page.
        const geometry = new Map<string, number>();
        let fetchedThisPress = new Set<string>();
        let fetchedCount = 0;
        const executeScan: TriageAdmittedOperationExecutorV1 = async (_operation, scanInput) => {
            const sourceInstanceId = scanInput.instance.instance.sourceInstanceId;
            const page = scanInput.page.kind === 'initial'
                ? 0
                : Number(/^p(\d+):/u.exec(scanInput.page.continuation.token)?.[1] ?? '0');
            pages.set(sourceInstanceId, page);
            if (scanInput.page.kind === 'initial') geometry.set(sourceInstanceId, scanInput.page.limit);
            const limit = geometry.get(sourceInstanceId) ?? 1;
            const observations = Array.from({ length: limit }, (_unused, index) => ({
                kind: 'present' as const,
                localRef: {
                    kindId: 'pull-request',
                    collisionScope: 'example/repository',
                    entryId: `${sourceInstanceId}-p${page}-${index}`,
                },
                locator: testkitLocator(),
                snapshot: testkitSnapshot(),
                viewer: testkitViewer(),
                // Each page reads older than the one before it, so a lane
                // that never advances can only ever contribute its newest
                // rows.
                sourceUpdatedAtMs: 1_000_000 - page * 1_000 - index,
            }));
            for (const observation of observations) fetchedThisPress.add(observation.localRef.entryId);
            fetchedCount += observations.length;
            return {
                kind: 'page',
                observations,
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: maximalToken(page + 1) },
            };
        };

        let resume: TriageListEntriesInputV1['resume'];
        const seen = new Set<string>();
        // Four presses of the reader's own continuation row. One is enough for
        // a lane that keeps its frontier; a starved lane never gets there.
        for (let press = 0; press < 4; press += 1) {
            fetchedThisPress = new Set<string>();
            const result: TriageListEntriesResultV1 = await listTriageEntries({
                v: 1,
                sources: { kind: 'allConfigured' },
                limit: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
                order: 'newest',
                ...(resume === undefined ? {} : { resume }),
            }, {
                sourceInstances: collections.sourceInstances,
                readAdmittedSources: async () => [ADMITTED_SOURCE],
                executeScan,
                nowMs: () => 1_760_000_000_000,
            });

            // The result is never refused whole over a paging token, and it is
            // strict host JSON admission that answers.
            expect(AgentRuntimeJsonValueV1Schema.safeParse(result).success).toBe(true);
            // Nothing is dropped: every lane that stopped with more to give
            // carries its own frontier, all thirty-two of them.
            expect(result.window.continuations ?? []).toHaveLength(
                MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
            );
            const returnedThisPress = new Set(result.window.rows.map((row) => row.entryRef.entryId));
            const lostThisPress = [...fetchedThisPress].filter((entryId) => !returnedThisPress.has(entryId));
            expect({
                fetched: fetchedThisPress.size,
                seen: returnedThisPress.size,
                lost: lostThisPress.length,
            }).toEqual({
                fetched: fetchedThisPress.size,
                seen: fetchedThisPress.size,
                lost: 0,
            });
            for (const entryId of returnedThisPress) seen.add(entryId);
            resume = result.window.continuations;
        }

        // The tail of the rotation advanced its walk rather than restarting it,
        // and its unique older rows are reachable.
        expect(pages.get(tail)).toBeGreaterThan(0);
        expect([...seen].some((entryId) => entryId.startsWith(`${tail}-p1-`))).toBe(true);
        expect(fetchedCount).toBe(seen.size);
    }, 60_000);
});
