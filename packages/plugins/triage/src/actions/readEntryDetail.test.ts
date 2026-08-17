import type { PluginInvocationCaller, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import {
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TriageDetailSurfaceInputV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageEntryRefV1,
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
