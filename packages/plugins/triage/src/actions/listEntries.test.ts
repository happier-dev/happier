import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1 } from '../corpus/configuration/administerConfiguredSourceInstance.js';
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

        const result = await createTriageListEntriesActionHandler()({
            v: 1,
            sources: { kind: 'allConfigured' },
            limit: 10,
            order: 'newest',
        }, context);

        // The walk really happened; a pass that never ran would pass this test
        // for the wrong reason.
        expect(page).toBe(2);
        // Both pages reached the window. Ordering is owned and proved elsewhere,
        // so this compares the set rather than restating that contract.
        expect([...result.window.rows.map((row) => row.entryRef.entryId)].sort()).toEqual(['1', '2']);
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

    it('reports partial coverage when more sources are configured than one result can name', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        // One past the maximum. Two racing creates at the boundary can leave the
        // durable set here, and the read must not answer as if the surplus row
        // did not exist.
        for (let index = 0; index <= MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1; index += 1) {
            control.sourceInstances.seed(toCorpusStoredValue(configuredRow({
                instanceTag: paddedInstanceTag(`s${String(index).padStart(3, '0')}`),
                sourceInstanceId: numberedInstanceId(index),
                configuredAtMs: index + 1,
            })));
        }

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

        // The result stays inside the array bound its own schema declares — and
        // says so through coverage instead of silently dropping the surplus.
        expect(result.configuredSources).toHaveLength(MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1);
        expect(result.window.lanes.every((lane) => lane.exhausted)).toBe(true);
        expect(result.window.coverage).toBe('partial');
    });
});
