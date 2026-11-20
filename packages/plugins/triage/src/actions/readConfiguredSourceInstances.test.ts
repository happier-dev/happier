import { TELEMETRY_EXCEPTION_SOURCE_DESCRIPTOR_V1, TELEMETRY_EXCEPTION_SOURCE_V1 } from '../../../telemetry/src/exceptions/source.js';
import type { DefinePluginInput, PluginInvocationCaller, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import {
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    isExternalActionResultWithinResponseEnvelopeLimitV1,
} from '@happier-dev/plugin-sdk/actions';
import {
    MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TriageReadConfiguredSourceInstancesInputV1Schema,
    TriageReadConfiguredSourceInstancesResultV1Schema,
    type TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';
import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { TRIAGE_ISSUE_WATCH_SOURCES_V1, triageIssueWatchOptionIdsV1 } from '@happier-dev/triage-sources/runtime';
import { TRIAGE_ACCOUNT_RESOURCES } from '../accountDefinition.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import {
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { findConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { readActiveConfiguredSourceRows } from '../corpus/configuration/readConfiguredSourceRows.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../internalTasks/identity.js';
import { deriveConfiguredSourceInstanceTag } from '../corpus/identity/tags.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import type { TriageAdmittedSourceV1 } from './listEntries.js';
import {
    createTriageReadConfiguredSourceInstancesActionHandler,
    fitTriageConfiguredSourceInstancesResult,
    readTriageConfiguredSourceInstances,
} from './readConfiguredSourceInstances.js';

/**
 * The read half of source administration.
 *
 * Three of the four `sources/administer-v1` arms name a `sourceInstanceId` the
 * caller must already hold, and nothing published one — so a source Settings
 * page could only ever ADD a source. Explicit reads select an admitted source;
 * source-less plugin reads keep their existing own-source default.
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
    surface?: PluginInvocationContext['surface'];
    admitted?: readonly TriageAdmittedSourceV1[];
    onInvalidated?: boolean;
}>): PluginInvocationContext {
    return {
        signal: new AbortController().signal,
        surface: input.surface ?? 'plugin',
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
    it.each([
        [TRIAGE_ISSUE_WATCH_SOURCES_V1.sentry, TRIAGE_ISSUE_WATCH_SOURCES_V1.posthog],
        [TRIAGE_ISSUE_WATCH_SOURCES_V1.posthog, TRIAGE_ISSUE_WATCH_SOURCES_V1.sentry],
    ])('offers only the selected source kind in the invoking Account (%j)', async (source, other) => {
        const current = createTestkitCorpusCollections();
        const foreign = createTestkitCorpusCollections();
        current.control.sourceInstances.seed(toCorpusStoredValue(instanceRow({ source, seed: 1 })));
        current.control.sourceInstances.seed(toCorpusStoredValue(instanceRow({ source: other, seed: 2 })));
        foreign.control.sourceInstances.seed(toCorpusStoredValue(instanceRow({ source, seed: 3 })));
        const handler = createTriageReadConfiguredSourceInstancesActionHandler();
        expect(parsePluginManifest(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
        const { source: inputTypeId } = triageIssueWatchOptionIdsV1(source);
        const optionsId = PLUGIN_MANIFEST.contributes.inputTypes.find(type => type.id === inputTypeId)?.options?.resource;
        if (typeof optionsId !== 'string') throw new Error('Expected a local options Resource reference');
        const resources: NonNullable<DefinePluginInput['resources']> = TRIAGE_ACCOUNT_RESOURCES;
        const options = resources[optionsId];
        if (options?.source !== 'dynamic') throw new Error('Expected the declared source options Resource');
        const read = (collections: CorpusCollectionsV1, failed = false) =>
            options.runtime.read(createTestResourceInvocationContext({
                readAction: async (_ref, input) => failed
                    ? { ok: false, errorCode: 'read_failed', error: 'read failed' }
                    : { ok: true, result: await handler(TriageReadConfiguredSourceInstancesInputV1Schema.parse(input),
                        createContext({ collections, admitted: [admittedSource(source), admittedSource(other)] })) },
            }));
        expect(JSON.parse(String(await read(current.collections)))).toEqual({
            options: [{ value: instanceId(1), label: `${source.localId} scope 1` }],
        });
        expect(JSON.parse(String(await read(foreign.collections)))).toEqual({
            options: [{ value: instanceId(3), label: `${source.localId} scope 3` }],
        });
        expect(JSON.parse(String(await read(createTestkitCorpusCollections().collections)))).toEqual({ options: [] });
        await expect(read(current.collections, true)).rejects.toMatchObject({ code: 'read_failed' });
    });

    it('reads the admitted exceptions instance in a fresh Account without a setup write', async () => {
        const { collections } = createTestkitCorpusCollections();
        const source = { ...admittedSource(TELEMETRY_EXCEPTION_SOURCE_V1), descriptor: TELEMETRY_EXCEPTION_SOURCE_DESCRIPTOR_V1 };
        const context = createContext({ collections, surface: 'ui', admitted: [source] });
        const handler = createTriageReadConfiguredSourceInstancesActionHandler();
        const result = await handler({ v: 1, source: TELEMETRY_EXCEPTION_SOURCE_V1 }, context);
        expect(result).toMatchObject({ kind: 'read', status: 'complete', instances: [{ lifecycle: 'active', configured: {
            instance: { source: TELEMETRY_EXCEPTION_SOURCE_V1 }, binding: { purpose: 'exceptions', source: 'accountData' },
        } }] });
        if (result.kind !== 'read') throw new Error('Expected the configured source');
        const configured = result.instances[0]!.configured;
        expect(await handler({ v: 1, source: TELEMETRY_EXCEPTION_SOURCE_V1, exact: configured }, context)).toEqual(result);
        expect((await collections.sourceInstances.query({ index: 'by-lifecycle', order: 'asc' })).rows).toEqual([]);
    });

    it('checks one exact private tuple with one get and no inventory walk, without disclosing foreign rows', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const wanted = instanceRow({ source: FORGE, seed: 1 });
        const foreign = instanceRow({ source: TRACKER, seed: 2 });
        const inventory = [wanted, foreign, ...Array.from({ length: 98 }, (_, index) =>
            instanceRow({ source: index % 2 === 0 ? FORGE : TRACKER, seed: index + 3 }))];
        for (const row of inventory) {
            const instanceTag = await deriveConfiguredSourceInstanceTag(collections.sourceInstances, {
                source: row.configured.instance.source, binding: row.configured.binding,
                localInstanceKey: row.configured.localInstanceKey,
            });
            control.sourceInstances.seed(toCorpusStoredValue({ ...row, instanceTag }));
        }
        const query = vi.fn(collections.sourceInstances.query);
        const bounded = { ...collections, sourceInstances: { ...collections.sourceInstances, query } };
        const context = createContext({ collections: bounded, caller: pluginCaller(FORGE.pluginId) });
        const handler = createTriageReadConfiguredSourceInstancesActionHandler();
        const selected = { v: 1 as const, exact: wanted.configured };
        expect(await handler(selected, context)).toEqual({ kind: 'read', status: 'complete',
            instances: [{ v: 1, lifecycle: 'active', configured: wanted.configured }] });
        expect(control.sourceInstances.getCallCount()).toBe(1);
        expect(query).not.toHaveBeenCalled();
        expect(await handler({ ...selected, exact: foreign.configured }, context))
            .toEqual({ kind: 'read', status: 'complete', instances: [] });
        expect(control.sourceInstances.getCallCount()).toBe(1);
        expect(await handler({ ...selected, exact: { ...wanted.configured, instance: {
            ...wanted.configured.instance, sourceInstanceId: foreign.configured.instance.sourceInstanceId,
        } } }, context)).toEqual({ kind: 'read', status: 'complete', instances: [] });
        expect(control.sourceInstances.getCallCount()).toBe(2);
        expect(query).not.toHaveBeenCalled();
    });
    it('keeps an uninstalled source active in storage and resumes the same configuration on reinstall', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow({ source: FORGE, seed: 1 })));
        const tracked = instanceRow({ source: TRACKER, seed: 2 });
        const { rowId, revision } = control.sourceInstances.seed(toCorpusStoredValue(tracked));
        const handler = createTriageReadConfiguredSourceInstancesActionHandler();
        const result = await handler(INPUT, createContext({
            collections, surface: 'cli', admitted: [admittedSource(FORGE)],
        }));
        expect(result).toMatchObject({ kind: 'read', status: 'complete' });
        expect(result.kind === 'read' && result.instances.map(record => record.configured.instance.source)).toEqual([FORGE]);
        const retained = await readActiveConfiguredSourceRows(collections.sourceInstances);
        expect(retained.rows.map(row => row.configured.instance.source)).toEqual([INTERNAL_TASK_SOURCE_V1, FORGE, TRACKER]);
        expect(control.sourceInstances.inspect(rowId)).toEqual({ revision, deleted: false });

        const reinstalled = admittedSource(TRACKER);
        const restored = await handler({ v: 1, source: TRACKER }, createContext({
            collections, surface: 'cli', admitted: [{ ...reinstalled,
                contributor: { ...reinstalled.contributor, immutableGenerationId: 'generation-2' },
            }],
        }));
        expect(restored).toEqual({ kind: 'read', status: 'complete', instances: [{
            v: 1, lifecycle: 'active', configured: tracked.configured,
        }] });
        expect(control.sourceInstances.inspect(rowId)).toEqual({ revision, deleted: false });
    });
    it.each(['background', 'plugin'] as const)('does not treat an absent-caller %s surface as host Action authority', async (surface) => {
        const { collections } = createTestkitCorpusCollections();
        expect(await createTriageReadConfiguredSourceInstancesActionHandler()(
            INPUT, createContext({ collections, surface }),
        )).toEqual({ kind: 'invalidCaller' });
    });

    it('does not treat host webhook ingress as an account Action caller on the API surface', async () => {
        const { collections } = createTestkitCorpusCollections();
        const caller: PluginInvocationCaller = {
            kind: 'host', domain: 'ingress', originSurface: 'webhook',
            contribution: { id: 'webhook', qualifiedId: 'happier.example.forge/webhook' },
        };
        expect(await createTriageReadConfiguredSourceInstancesActionHandler()(
            INPUT, createContext({ collections, surface: 'api', caller }),
        )).toEqual({ kind: 'invalidCaller' });
    });

    it.each(['ui', 'voice', 'agent', 'mcp', 'cli', 'api'] as const)('lets a host %s caller discover sources and another plugin select an admitted source', async (surface) => {
        const { collections, control } = createTestkitCorpusCollections();
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow({ source: FORGE, seed: 1 })));
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow({ source: TRACKER, seed: 2 })));
        const handler = createTriageReadConfiguredSourceInstancesActionHandler();
        const result = await handler(INPUT, createContext({ collections, surface }));
        expect(result.kind).toBe('read');
        if (result.kind !== 'read') return;
        expect(result.instances.map((record) => record.configured.instance.source)).toEqual([FORGE, TRACKER]);
        const selected = TriageReadConfiguredSourceInstancesInputV1Schema.parse({ v: 1, source: TRACKER });
        expect(await handler(selected, createContext({ collections, surface, caller: pluginCaller(FORGE.pluginId) })))
            .toEqual({ kind: 'read', status: 'complete', instances: [{ v: 1, lifecycle: 'active',
                configured: instanceRow({ source: TRACKER, seed: 2 }).configured }] });
        const filtered = await handler(selected, createContext({ collections, surface }));
        expect(filtered.kind === 'read' ? filtered.instances.map((record) => record.configured.instance.source) : filtered)
            .toEqual([TRACKER]);
    });

    it.each(['background', 'plugin'] as const)('lets a %s caller name an admitted source without host provenance', async (surface) => {
        const { collections, control } = createTestkitCorpusCollections();
        const row = instanceRow({ source: TRACKER, seed: 2 });
        control.sourceInstances.seed(toCorpusStoredValue(row));
        const handler = createTriageReadConfiguredSourceInstancesActionHandler();
        const context = createContext({ collections, surface });
        expect(await handler({ v: 1, source: TRACKER }, context)).toEqual({ kind: 'read', status: 'complete',
            instances: [{ v: 1, lifecycle: 'active', configured: row.configured }] });
        expect(await handler({ v: 1, source: { ...TRACKER, localId: 'not-admitted' } }, context))
            .toEqual({ kind: 'invalidCaller' });
    });

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

    it('returns the once-admitted caller rows when the source view invalidates during resolution', async () => {
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

        expect(result).toMatchObject({ kind: 'read', status: 'complete',
            instances: [{ configured: configuredInstance(FORGE, 1) }] });
    });

    it('returns every caller-owned active and retired row instead of truncating at thirty-two', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        for (let seed = 1; seed <= 34; seed += 1) {
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
        expect(result.instances).toHaveLength(34);
        expect(result.status).toBe('complete');
    });

    it('reports the tail omitted only when whole configured records reach the Action envelope', () => {
        const recordCount = Math.floor(
            EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES
                / ((MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1
                    + MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1
                    + MAX_TRIAGE_TEXT_UTF8_BYTES_V1 * 2) * 2),
        ) + 1;
        const configurationToken = '\\'.repeat(MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1);
        const localInstanceKey = '\\'.repeat(MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1);
        const displayText = '\\'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
        const records = Array.from({ length: recordCount }, (_unused, index) => ({
            v: 1 as const,
            lifecycle: 'retired' as const,
            configured: {
                ...configuredInstance(FORGE, index + 1),
                localInstanceKey,
                configuration: { v: 1 as const, token: configurationToken },
                locator: { v: 1 as const, displayLabel: displayText, displayPath: displayText },
            },
        }));

        const result = TriageReadConfiguredSourceInstancesResultV1Schema.parse(
            fitTriageConfiguredSourceInstancesResult(records),
        );
        expect(result.kind).toBe('read');
        if (result.kind !== 'read') return;
        expect(result.status).toBe('truncated');
        expect(result.instances.length).toBeGreaterThan(0);
        expect(result.instances.length).toBeLessThan(records.length);
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    }, 30_000);

    it('settles a repeated Collection cursor instead of walking forever', async () => {
        let calls = 0;
        const sourceInstances = {
            query: async () => {
                calls += 1;
                return { rows: [], nextCursor: 'same-cursor' };
            },
        } as never;
        await expect(readTriageConfiguredSourceInstances(FORGE, {
            sourceInstances,
        })).rejects.toThrow('repeated continuation cursor');
        expect(calls).toBe(2);

        calls = 0;
        await expect(findConfiguredSourceInstanceRow(sourceInstances, instanceId(1)))
            .rejects.toThrow('repeated continuation cursor');
        expect(calls).toBe(2);
    });
});
