import type { PluginInvocationCaller, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
    PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
    type PluginAccountCollectionDefinition,
} from '@happier-dev/plugin-sdk/collections';
import {
    MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TriageDetailSurfaceInputV1Schema,
    TriageSourceDescriptorV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageEntryRefV1,
    type TriageSourceDescriptorV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import {
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { linkEntryToSession } from '../sessions/entrySessionLinks.js';
import {
    TriageReadEntryDetailInputV1Schema,
    TriageReadEntryDetailResultV1Schema,
} from './entryDetailProtocol.js';
import { createTriageReadEntryDetailActionHandler } from './readEntryDetail.js';

/**
 * The durable half of one mounted detail input.
 *
 * The shell can select a row; without this read it holds nothing the strict
 * `TriageDetailSurfaceInputV1` will admit, because two of that value's three
 * members are Account Collection state a mounted surface cannot reach. These
 * cases are about the two ways that would go wrong quietly: handing over the
 * wrong connection's configuration, and letting any plugin ask for a source's
 * private one.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.example.forge', localId: 'example-forge' });
const OTHER_SOURCE = Object.freeze({ pluginId: 'happier.example.tracker', localId: 'example-tracker' });
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = 'session-1';

const ENTRY_REF: TriageEntryRefV1 = Object.freeze({
    source: SOURCE,
    kindId: 'pull-request',
    collisionScope: 'example/repository',
    entryId: '17',
});

function configuredInstance(input: Readonly<{
    source: Readonly<{ pluginId: string; localId: string }>;
    sourceInstanceId: string;
    token: string;
}>): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source: input.source, sourceInstanceId: input.sourceInstanceId },
        binding: {
            purpose: 'triage-source',
            account: {
                service: { pluginId: input.source.pluginId, localId: 'accounts' },
                accountId: `account-${input.token}`,
            },
        },
        localInstanceKey: `${input.source.localId}/${input.token}`,
        configuration: { v: 1, token: input.token },
        locator: { v: 1, displayLabel: `${input.source.localId} ${input.token}` },
    });
}

function instanceRow(input: Readonly<{
    tag: string;
    configured: TriageConfiguredSourceInstanceV1;
    lifecycle?: 'active' | 'retired';
}>): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: input.tag,
        sourceQualifiedId: `${input.configured.instance.source.pluginId}/${input.configured.instance.source.localId}`,
        lifecycle: input.lifecycle === 'retired'
            ? CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired
            : CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1_000,
        configured: input.configured,
        ...(input.lifecycle === 'retired' ? { retiredReason: 'userRemoved' as const } : {}),
    };
}

/**
 * One admitted V1 source contribution, as the host publishes it: the descriptor
 * is already parsed with this target's own schema, so the fixture parses it the
 * same way rather than hand-writing a shape the host could never emit.
 */
function admittedSource(input: Readonly<{
    source: Readonly<{ pluginId: string; localId: string }>;
    displayName: string;
    kinds: readonly Readonly<{ id: string; workflowSubject: string; displayName: string }>[];
}>) {
    return {
        contributor: {
            pluginId: input.source.pluginId,
            contributionId: input.source.localId,
            immutableGenerationId: 'generation-1',
        },
        protocol: { id: 'happier.triage/sources', version: 1 },
        descriptor: TriageSourceDescriptorV1Schema.parse({
            v: 1,
            purpose: 'triage-source',
            displayName: input.displayName,
            kinds: input.kinds,
        }) as TriageSourceDescriptorV1,
        operations: {},
        surfaces: {},
    };
}

const FORGE_CONTRIBUTION = admittedSource({
    source: SOURCE,
    displayName: 'Example forge',
    kinds: [
        { id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
        { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' },
    ],
});

const TRACKER_CONTRIBUTION = admittedSource({
    source: OTHER_SOURCE,
    displayName: 'Example tracker',
    kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Ticket' }],
});

function caller(pluginId: string): PluginInvocationCaller {
    return {
        kind: 'plugin',
        pluginId,
        contribution: { id: 'triage', qualifiedId: `${pluginId}/triage` },
        materialization: { pluginId, machineId: 'machine-1', materializationId: 'materialization-1' },
    } as unknown as PluginInvocationCaller;
}

function createContext(input: Readonly<{
    collections: CorpusCollectionsV1;
    callerPluginId?: string;
    sessionSummary?: Readonly<{ title?: string; updatedAtMs?: number }> | null;
    admitted?: readonly ReturnType<typeof admittedSource>[];
}>): PluginInvocationContext {
    return {
        signal: new AbortController().signal,
        caller: caller(input.callerPluginId ?? TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1),
        services: {
            storage: {
                account: {
                    collection: (definition: PluginAccountCollectionDefinition) => (
                        definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
                            ? input.collections.sourceInstances
                            : definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID
                                ? input.collections.sessionLinks
                                : input.collections.userMarks
                    ),
                },
            },
            sessions: {
                get: async () => (input.sessionSummary === undefined || input.sessionSummary === null
                    ? null
                    : { summary: async () => input.sessionSummary }),
            },
            targetedContributions: {
                observeForSelf: () => ({
                    readCurrent: async () => ({
                        generation: 'target-generation-1',
                        contributions: input.admitted ?? [FORGE_CONTRIBUTION],
                    }),
                    dispose: () => {},
                }),
            },
        },
    } as unknown as PluginInvocationContext;
}

function detailInput(sourceInstanceId: string) {
    return TriageReadEntryDetailInputV1Schema.parse({
        v: 1,
        entryRef: ENTRY_REF,
        sourceInstanceId,
    });
}

async function seedTwoConnections(): Promise<Readonly<{ collections: CorpusCollectionsV1 }>> {
    const { collections, control } = createTestkitCorpusCollections();
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow({
        tag: `a${'0'.repeat(42)}`,
        configured: configuredInstance({ source: SOURCE, sourceInstanceId: INSTANCE_A, token: 'token-a' }),
    })));
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow({
        tag: `b${'0'.repeat(42)}`,
        configured: configuredInstance({ source: SOURCE, sourceInstanceId: INSTANCE_B, token: 'token-b' }),
    })));
    return { collections };
}

describe('the entry detail read', () => {
    it('reports when the bounded linked-Session page has more rows', async () => {
        const { collections } = await seedTwoConnections();
        expect(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1)
            .toBe(PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1);
        for (let index = 0; index < MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1; index += 1) {
            await linkEntryToSession({
                collections,
                entryRef: ENTRY_REF,
                display: { locator: { v: 1, displayPath: 'example/repository#17' }, scopeLabel: 'example/repository' },
                sessionId: `session-${index}`,
                nowMs: 2_000 + index,
            });
        }

        const result = TriageReadEntryDetailResultV1Schema.parse(
            await createTriageReadEntryDetailActionHandler()(
                detailInput(INSTANCE_A),
                createContext({ collections }),
            ),
        );

        expect(result.kind).toBe('read');
        if (result.kind !== 'read') return;
        expect(result.linkedSessions).toHaveLength(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1);
        expect(result.linkedSessionsHasMore).toBe(true);
    });

    it('returns the exact selected connection when several observe one entry', async () => {
        const { collections } = await seedTwoConnections();

        const result = TriageReadEntryDetailResultV1Schema.parse(
            await createTriageReadEntryDetailActionHandler()(
                detailInput(INSTANCE_B),
                createContext({ collections }),
            ),
        );

        expect(result.kind).toBe('read');
        if (result.kind !== 'read') return;
        // The selected one, not the first. With two connections on the same
        // logical entry, opening the wrong one silently shows a different
        // provider's truth under the row the reader pressed.
        expect(result.instance.instance.sourceInstanceId).toBe(INSTANCE_B);
        expect(result.instance.configuration.token).toBe('token-b');
        expect(result.linkedSessions).toEqual([]);
    });

    it('composes a value the published strict detail boundary admits', async () => {
        const { collections } = await seedTwoConnections();
        await linkEntryToSession({
            collections,
            entryRef: ENTRY_REF,
            display: { locator: { v: 1, displayPath: 'example/repository#17' }, scopeLabel: 'example/repository' },
            sessionId: SESSION_ID,
            nowMs: 2_000,
        });

        const result = TriageReadEntryDetailResultV1Schema.parse(
            await createTriageReadEntryDetailActionHandler()(
                detailInput(INSTANCE_A),
                createContext({
                    collections,
                    sessionSummary: { title: 'Replace the duplicated normalizer', updatedAtMs: 3_000 },
                }),
            ),
        );

        expect(result.kind).toBe('read');
        if (result.kind !== 'read') return;
        expect(result.linkedSessions).toEqual([{
            sessionId: SESSION_ID,
            displayTitle: 'Replace the duplicated normalizer',
            updatedAtMs: 3_000,
        }]);
        // The whole point of the read: what it returns has to satisfy the exact
        // schema the mounted source detail is admitted through.
        expect(() => TriageDetailSurfaceInputV1Schema.parse({
            v: 1,
            instance: result.instance,
            observation: {
                entryRef: ENTRY_REF,
                observedAtMs: 4_000,
                locator: testkitLocator(),
                snapshot: testkitSnapshot(),
                viewer: testkitViewer(),
            },
            linkedSessions: result.linkedSessions,
            linkedSessionsHasMore: result.linkedSessionsHasMore,
        })).not.toThrow();
    });

    it('keeps a link whose session the host cannot answer for', async () => {
        const { collections } = await seedTwoConnections();
        await linkEntryToSession({
            collections,
            entryRef: ENTRY_REF,
            display: { locator: { v: 1, displayPath: 'example/repository#17' }, scopeLabel: 'example/repository' },
            sessionId: SESSION_ID,
            nowMs: 2_000,
        });

        const result = TriageReadEntryDetailResultV1Schema.parse(
            await createTriageReadEntryDetailActionHandler()(
                detailInput(INSTANCE_A),
                createContext({ collections, sessionSummary: null }),
            ),
        );

        expect(result.kind).toBe('read');
        if (result.kind !== 'read') return;
        // A tombstoned or unavailable Session loses its two presentation fields
        // and nothing else; dropping the row would say the entry was never
        // linked to anything.
        expect(result.linkedSessions).toEqual([{ sessionId: SESSION_ID }]);
    });

    it('refuses a retired connection instead of opening it', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow({
            tag: `a${'0'.repeat(42)}`,
            configured: configuredInstance({ source: SOURCE, sourceInstanceId: INSTANCE_A, token: 'token-a' }),
            lifecycle: 'retired',
        })));

        const result = await createTriageReadEntryDetailActionHandler()(
            detailInput(INSTANCE_A),
            createContext({ collections }),
        );

        expect(result).toEqual({ kind: 'unavailable' });
    });

    it('refuses a connection that belongs to a different source than the entry', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow({
            tag: `c${'0'.repeat(42)}`,
            configured: configuredInstance({
                source: OTHER_SOURCE,
                sourceInstanceId: INSTANCE_A,
                token: 'token-other',
            }),
        })));

        const result = await createTriageReadEntryDetailActionHandler()(
            detailInput(INSTANCE_A),
            createContext({ collections }),
        );

        // Handing a tracker's routing token to a forge renderer is how a detail
        // reads the wrong provider under the user's own account.
        expect(result).toEqual({ kind: 'unavailable' });
    });

    it('carries the entry source\'s own declared descriptor out of the admitted snapshot', async () => {
        const { collections } = await seedTwoConnections();

        const result = TriageReadEntryDetailResultV1Schema.parse(
            await createTriageReadEntryDetailActionHandler()(
                detailInput(INSTANCE_A),
                // A second admitted source is sorted ahead of the entry's own, and
                // declares its own name for the very same `kindId`. Taking "the
                // first admitted contribution" would name this pull request a
                // "Ticket" from the "Example tracker".
                createContext({ collections, admitted: [TRACKER_CONTRIBUTION, FORGE_CONTRIBUTION] }),
            ),
        );

        expect(result.kind).toBe('read');
        if (result.kind !== 'read') return;
        expect(result.sourceDescriptor?.displayName).toBe('Example forge');
        expect(result.sourceDescriptor?.kinds.map((kind) => kind.id))
            .toEqual(['pull-request', 'issue']);
    });

    it('omits the descriptor when the entry\'s source has no admitted contribution', async () => {
        const { collections } = await seedTwoConnections();

        const result = TriageReadEntryDetailResultV1Schema.parse(
            await createTriageReadEntryDetailActionHandler()(
                detailInput(INSTANCE_A),
                createContext({ collections, admitted: [TRACKER_CONTRIBUTION] }),
            ),
        );

        expect(result.kind).toBe('read');
        if (result.kind !== 'read') return;
        // Absent, never another source's descriptor and never a placeholder: the
        // configured connection is still readable, and naming it after whoever
        // else happens to be admitted is the failure this case exists for.
        expect(result.sourceDescriptor).toBeUndefined();
        expect(result.instance.instance.sourceInstanceId).toBe(INSTANCE_A);
    });

    it('refuses a caller that is not this target', async () => {
        const { collections } = await seedTwoConnections();

        const result = await createTriageReadEntryDetailActionHandler()(
            detailInput(INSTANCE_A),
            createContext({ collections, callerPluginId: OTHER_SOURCE.pluginId }),
        );

        // The aggregate list Action deliberately withholds the account binding
        // and the configuration token from its summaries. An exact-instance read
        // any plugin could call would be the way around that decision.
        expect(result).toEqual({ kind: 'invalidCaller' });
    });
});
