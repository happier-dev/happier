import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import {
    MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../projection/listWindow.js';
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

        const result = await createTriageListEntriesActionHandler()({
            v: 1,
            sources: { kind: 'allConfigured' },
            limit: 10,
            order: 'newest',
        }, context);

        expect(observed).toEqual([TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1]);
        expect(disposedObservations).toBe(1);
        // Only the original host-created handle carries authority, so it is
        // passed through untouched rather than reconstructed.
        expect(dispatched).toEqual([scanHandle]);
        expect(result.configuredSources).toEqual([{
            sourceInstanceId: INSTANCE_ID,
            source: SOURCE,
            available: true,
        }]);
        expect(result.window.rows.map((row) => row.entryRef.entryId)).toEqual(['17']);
        expect(result.window.coverage).toBe('complete');
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
            { sourceInstanceId: first, continuation: { v: 1, token: `next:${first}` } },
            { sourceInstanceId: second, continuation: { v: 1, token: `next:${second}` } },
        ]);
        expect(result.window.coverage).toBe('partial');
    });

    it('resumes each named lane at its own frontier and starts the rest at the first page', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const [first, second, third] = seedInstances(control, 3);
        const seen = new Map<string, unknown>();

        await listTriageEntries({
            v: 1,
            sources: { kind: 'allConfigured' },
            limit: 10,
            order: 'newest',
            resume: [
                { sourceInstanceId: second, continuation: { v: 1, token: 'frontier-of-second' } },
                // A frontier for a connection this request does not walk. It is
                // ignored rather than refused: refusing would cost the caller
                // the whole list over a stale token.
                { sourceInstanceId: SECOND_INSTANCE_ID, continuation: { v: 1, token: 'stale' } },
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
        // Every lane spends its whole published frontier on every page — the
        // pathological set, at the maximum admitted source count. `"` doubles
        // under JSON escaping, so this is the costliest admitted fill.
        const maximalToken = (page: number): string => {
            const marker = `p${page}:`;
            return `${marker}${'"'.repeat(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 - marker.length)}`;
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
