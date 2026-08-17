import type { PluginInvocationCaller, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import {
    MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TriageReadConfiguredSourceInstancesInputV1Schema,
    TriageReadConfiguredSourceInstancesResultV1Schema,
    type TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import {
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import type { TriageAdmittedSourceV1 } from './listEntries.js';
import { createTriageReadConfiguredSourceInstancesActionHandler } from './readConfiguredSourceInstances.js';

/**
 * The read half of caller-bound source administration.
 *
 * Three of the four `sources/administer-v1` arms name a `sourceInstanceId` the
 * caller must already hold, and nothing published one — so a source Settings
 * page could only ever ADD a source. These cases are about the one property
 * that makes publishing the read safe at all: a source sees exactly its own
 * configured instances, and never learns that another source's exists.
 */

const FORGE = Object.freeze({ pluginId: 'happier.example.forge', localId: 'example-forge' });
const TRACKER = Object.freeze({ pluginId: 'happier.example.tracker', localId: 'example-tracker' });
const PURPOSE = 'triage-source';

function instanceId(seed: number): string {
    return `${String(seed).padStart(8, '0')}-1111-4111-8111-111111111111`;
}

function configuredInstance(
    source: Readonly<{ pluginId: string; localId: string }>,
    seed: number,
): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source, sourceInstanceId: instanceId(seed) },
        binding: {
            purpose: PURPOSE,
            account: {
                service: { pluginId: source.pluginId, localId: 'accounts' },
                accountId: `account-${seed}`,
            },
        },
        localInstanceKey: `${source.localId}/scope-${seed}`,
        configuration: { v: 1, token: `routing-token-${seed}` },
        locator: { v: 1, displayLabel: `${source.localId} scope ${seed}` },
    });
}

function instanceRow(input: Readonly<{
    source: Readonly<{ pluginId: string; localId: string }>;
    seed: number;
    lifecycle?: 'active' | 'retired';
}>): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: `t${String(input.seed).padStart(42, '0')}`,
        sourceQualifiedId: `${input.source.pluginId}/${input.source.localId}`,
        lifecycle: input.lifecycle === 'retired'
            ? CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired
            : CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1_000 + input.seed,
        configured: configuredInstance(input.source, input.seed),
        ...(input.lifecycle === 'retired' ? { retiredReason: 'userRemoved' as const } : {}),
    };
}

function admittedSource(source: Readonly<{ pluginId: string; localId: string }>): TriageAdmittedSourceV1 {
    return {
        contributor: {
            pluginId: source.pluginId,
            contributionId: source.localId,
            immutableGenerationId: 'generation-1',
        },
        protocol: {
            id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
            version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        },
        descriptor: {
            v: 1,
            purpose: PURPOSE,
            displayName: source.localId,
            kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
        },
        operations: { listInstances: {}, scan: { role: 'scan' }, get: {} },
        surfaces: { detail: {} },
        // Host-created admitted entries are not constructible from plugin code.
    } as unknown as TriageAdmittedSourceV1;
}

const ADMITTED = Object.freeze([admittedSource(FORGE), admittedSource(TRACKER)]);

function pluginCaller(pluginId: string): PluginInvocationCaller {
    return {
        kind: 'plugin',
        pluginId,
        contribution: { id: 'settings', qualifiedId: `${pluginId}/settings` },
        materialization: { pluginId, machineId: 'machine-1', materializationId: 'materialization-1' },
    } as unknown as PluginInvocationCaller;
}

function createContext(input: Readonly<{
    collections: CorpusCollectionsV1;
    caller?: PluginInvocationCaller;
    admitted?: readonly TriageAdmittedSourceV1[];
    onInvalidated?: boolean;
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
                observeForSelf: (
                    _point: unknown,
                    options: Readonly<{ onInvalidated: () => void }>,
                ) => ({
                    readCurrent: async () => {
                        if (input.onInvalidated === true) options.onInvalidated();
                        return { generation: 'generation-1', contributions: input.admitted ?? ADMITTED };
                    },
                    dispose: () => {},
                }),
            },
        },
    } as unknown as PluginInvocationContext;
}

const INPUT = TriageReadConfiguredSourceInstancesInputV1Schema.parse({ v: 1 });

describe('the caller-scoped configured-instance read', () => {
    it('returns exactly the calling source instances and no others', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow({ source: FORGE, seed: 1 })));
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow({ source: TRACKER, seed: 2 })));
        control.sourceInstances.seed(toCorpusStoredValue(
            instanceRow({ source: FORGE, seed: 3, lifecycle: 'retired' }),
        ));

        const result = TriageReadConfiguredSourceInstancesResultV1Schema.parse(
            await createTriageReadConfiguredSourceInstancesActionHandler()(
                INPUT,
                createContext({ collections, caller: pluginCaller(FORGE.pluginId) }),
            ),
        );

        expect(result.kind).toBe('read');
        if (result.kind !== 'read') return;
        expect(result.status).toBe('complete');
        // Both of this caller's rows, in lifecycle order, and nothing of the
        // tracker's — not its id, not its account, not its routing token.
        expect(result.instances.map((record) => ({
            lifecycle: record.lifecycle,
            sourceInstanceId: record.configured.instance.sourceInstanceId,
            source: record.configured.instance.source,
        }))).toEqual([
            { lifecycle: 'active', sourceInstanceId: instanceId(1), source: FORGE },
            { lifecycle: 'retired', sourceInstanceId: instanceId(3), source: FORGE },
        ]);
        expect(JSON.stringify(result)).not.toContain(TRACKER.pluginId);
        expect(JSON.stringify(result)).not.toContain('routing-token-2');
    });

    it('carries the whole configured record a reconfiguration has to start from', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow({ source: FORGE, seed: 1 })));

        const result = TriageReadConfiguredSourceInstancesResultV1Schema.parse(
            await createTriageReadConfiguredSourceInstancesActionHandler()(
                INPUT,
                createContext({ collections, caller: pluginCaller(FORGE.pluginId) }),
            ),
        );

        expect(result.kind).toBe('read');
        if (result.kind !== 'read') return;
        // A Settings page reconfigures by sending a new draft. Without the
        // current account binding, source-native key and its own configuration
        // token, the only reconfiguration it could offer would start from a
        // blank form.
        expect(result.instances[0]?.configured).toEqual(configuredInstance(FORGE, 1));
    });

    it('refuses a caller with no admitted source contribution', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow({ source: FORGE, seed: 1 })));

        const result = await createTriageReadConfiguredSourceInstancesActionHandler()(
            INPUT,
            createContext({
                collections,
                caller: pluginCaller('happier.example.bystander'),
            }),
        );

        expect(result).toEqual({ kind: 'invalidCaller' });
    });

    it('asks a caller whose admitted view moved to read again rather than calling it invalid', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow({ source: FORGE, seed: 1 })));

        const result = await createTriageReadConfiguredSourceInstancesActionHandler()(
            INPUT,
            createContext({
                collections,
                caller: pluginCaller(FORGE.pluginId),
                onInvalidated: true,
            }),
        );

        // "You are not a configured source" and "ask again" are opposite
        // sentences for a Settings page to render.
        expect(result).toEqual({ kind: 'currentnessConflict' });
    });

    it('says the page is truncated rather than presenting a short one as the whole set', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        for (let seed = 1; seed <= MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1 + 2; seed += 1) {
            control.sourceInstances.seed(toCorpusStoredValue(instanceRow({
                source: FORGE,
                seed,
                lifecycle: seed > 4 ? 'retired' : 'active',
            })));
        }

        const result = TriageReadConfiguredSourceInstancesResultV1Schema.parse(
            await createTriageReadConfiguredSourceInstancesActionHandler()(
                INPUT,
                createContext({ collections, caller: pluginCaller(FORGE.pluginId) }),
            ),
        );

        expect(result.kind).toBe('read');
        if (result.kind !== 'read') return;
        expect(result.instances).toHaveLength(MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1);
        expect(result.status).toBe('truncated');
    });
});
