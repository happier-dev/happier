import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    derivePluginCollectionIdentityTagV1} from '@happier-dev/protocol/crypto/accountScopedCipher';
import {
    FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    measurePluginCollectionMutationRequestEncodedBytesV1,
    normalizePluginAccountCollectionContractV1,
    PluginCollectionMutationRequestV1Schema} from '@happier-dev/protocol/plugins/data/collectionsV1';
import {
    PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1} from '@happier-dev/protocol/plugins/data/collectionLimitsV1';
import {
    PluginAccountStorageMutationRequestV1Schema} from '@happier-dev/protocol/plugins/data/accountKvV1';
import {
    PluginAccountCollectionContributionV1Schema} from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import {
    PluginManifestV2Schema,
} from '@happier-dev/protocol/plugins/manifest/v2';
import {
    type JsonValue,
} from '@happier-dev/plugin-sdk';
import { projectPluginAccountCollectionDeclaration } from '@happier-dev/plugin-sdk/collections';
import {
    defineAccountCollection,
} from '@happier-dev/plugin-sdk/collections';
import type { AccountKvTransaction } from '@happier-dev/plugin-sdk/storage';
import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import {
    createPluginAccountAvailabilityReader,
    type PluginAccountAvailabilitySnapshot,
} from '@/sync/domains/plugins/availability/reader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit';
import { PLUGIN_COLLECTION_LIMITS_V1 } from '@happier-dev/protocol/plugins/data/collectionLimitsV1';

const pluginId = 'example.tasks';
const collectionDefinition = defineAccountCollection({
    id: 'tasks',
    schemaVersion: 2,
    readableSchemaVersions: [1, 2],
    schema: defineProtocolObject({
        id: defineProtocolString({ maxLength: 256 }),
        title: defineProtocolString({ maxLength: 256 }),
        status: defineProtocolUnion([
            defineProtocolLiteral('open'),
            defineProtocolLiteral('closed'),
        ]),
    }, { policy: 'closed' }),
    rowIdField: 'id',
    identityFields: ['id'],
    serverReadable: ['title', 'status'],
    indexes: [{
        id: 'by-status',
        fields: [
            { field: 'status', direction: 'asc' },
            { field: 'id', direction: 'asc' },
        ],
    }],
    uiQueries: [{
        id: 'open',
        indexId: 'by-status',
        parameters: {
            status: { kind: 'string', maxUtf8Bytes: 16, enum: ['open'] },
        },
        prefix: [{ kind: 'parameter', parameterId: 'status' }],
        order: 'asc',
        pageSize: 50,
        projectedFields: ['title', 'status'],
    }],
    relations: [],
    // A declared migration carries executable target-artifact code. The admitted
    // contract is therefore built through the SDK's declaration projector — the
    // one owner that strips the callback and the executable schema — so this
    // harness proves the client resolves the same digest the daemon binds,
    // rather than proving a callback-free definition can be normalized.
    migrations: [{
        id: 'seed-status',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
        migrate: (value: Readonly<Record<string, JsonValue>>) => ({
            ...value,
            status: 'open',
        }) as never,
    }],
});

const contract = normalizePluginAccountCollectionContractV1({
    pluginId,
    contribution: PluginAccountCollectionContributionV1Schema.parse(
        projectPluginAccountCollectionDeclaration(collectionDefinition.id, collectionDefinition),
    ),
});
const ref = {
    pluginId: contract.pluginId,
    collectionId: contract.collectionId,
    schemaVersion: contract.schemaVersion,
    contractDigest: contract.contractDigest,
};

const forgedCollectionDefinition = defineAccountCollection({
    ...collectionDefinition,
    schema: defineProtocolObject({
        id: defineProtocolString(),
        title: defineProtocolString(),
        status: defineProtocolUnion([
            defineProtocolLiteral('open'),
            defineProtocolLiteral('blocked'),
        ]),
    }, { policy: 'closed' }),
});

const normalizedManifest = PluginManifestV2Schema.parse({
    schemaVersion: 2,
    id: pluginId,
    version: '1.0.0',
    displayName: 'Tasks',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: {},
    hostAccess: {
        required: [{
            id: 'account-storage',
            capability: 'storage.account',
            reason: 'Persist Account-scoped plugin state.',
            scope: { enabled: true },
        }],
        optional: [],
    },
});

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

function createAvailabilityReader(currentRef = ref) {
    const snapshot = {
        availabilityCursor: 7,
        materializations: [],
        snapshots: [],
        intentReads: [{
            pluginId,
            response: {
                availabilityCursor: 7,
                packageAssets: [],
                hostingCapability: {
                    enabled: true,
                    maxArtifactBytes: 1024,
                    maxAccountBytes: 2048,
                },
                intent: {
                    pluginId,
                    desiredVersion: '1.0.0',
                    enabled: true,
                    offlineUiHosting: 'enabled',
                    writableCollections: [currentRef],
                    revision: 'intent-7',
                },
                release: {
                    ref: { pluginId, version: '1.0.0' },
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest,
                    collectionContracts: [currentRef],
                    uiSlots: [],
                    packageAssetArchive: {
                        archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                        resources: [],
                    },
                },
                uiArtifacts: [],
            },
        }],
    } satisfies PluginAccountAvailabilitySnapshot;
    return createPluginAccountAvailabilityReader({
        scope: { serverId: 'server-a', accountId: 'account-a' },
        snapshot,
    });
}

async function loadClient(options: Readonly<{
    mutationResponse?: () => Response;
    accountKvRead?: () => Response | Promise<Response>;
    accountKvWrite?: (body: unknown, init?: RequestInit) => Response | Promise<Response>;
    availabilityReader?: ReturnType<typeof createAvailabilityReader>;
    readAvailability?: () => ReturnType<typeof createAvailabilityReader>;
    collectionContractRead?: () => Response;
    collectionRead?: () => Response;
}> = {}) {
    vi.resetModules();
    let current = true;
    const retireCallbacks = new Set<() => void>();
    const lifetime = {
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => current,
        onRetire: (callback: () => void) => {
            retireCallbacks.add(callback);
            return { dispose: () => { retireCallbacks.delete(callback); } };
        },
    };
    const accountKvWrites: unknown[] = [];
    const transport = vi.fn(async (path: string, _init?: RequestInit) => {
        if (path === '/v1/account/encryption/currentness') {
            return new Response(JSON.stringify(createPlainAccountEncryptionCurrentnessFixture({
                version: 7,
                updatedAt: 11,
            })), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/v1/plugins/data/contract') {
            if (options.collectionContractRead) return options.collectionContractRead();
            return new Response(JSON.stringify({ access: 'writable', contract }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (path === '/v1/plugins/data/get' || path === '/v1/plugins/data/query') {
            if (options.collectionRead) return options.collectionRead();
            if (path === '/v1/plugins/data/query') return Response.json({ rows: [], changeCursor: 1 });
            return new Response(JSON.stringify({ row: null, absenceEpoch: 0 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (path === `/v1/account/plugin-storage/${pluginId}`) {
            if ((_init?.method ?? 'GET') === 'GET') {
                return await (options.accountKvRead?.() ?? new Response(
                    JSON.stringify({ status: 'absent' }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ));
            }
            const parsedBody = JSON.parse(String(_init?.body ?? 'null')) as unknown;
            accountKvWrites.push(parsedBody);
            return await (options.accountKvWrite?.(parsedBody, _init) ?? new Response(
                JSON.stringify({ status: 'updated', revision: 3 }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ));
        }
        if (path === '/v1/plugins/data/mutate') {
            if (options.mutationResponse) return options.mutationResponse();
            return new Response(JSON.stringify({
                status: 'updated',
                results: [{ rowId: 'task-1', revision: 2, deleted: false }],
                changeCursor: 19,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`Unexpected Data path: ${path}`);
    });

    vi.doMock('@/sync/domains/scope/activeServerAccountScope', () => ({
        captureActiveServerAccountScopeLifetime: () => lifetime,
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'server-a',
            serverUrl: 'https://server.example',
            generation: 1,
        }),
    }));
    vi.doMock('@/sync/api/session/apiSocket', () => ({ apiSocket: { request: vi.fn() } }));
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
        captureServerRequestAuthorityForServerAccountScope: async () => ({
            scope: lifetime.scope,
            context: { token: 'account-token' },
            request: transport,
            release: async () => undefined,
        }),
    }));

    const { createPluginUiDataClient } = await import('./pluginUiDataClient');
    const { recordAccountStoredContentServerRequirements } = await import(
        '@/sync/http/accountStoredContentCompatibility'
    );
    recordAccountStoredContentServerRequirements({
        serverUrl: 'https://server.example',
        requirements: {
            v: 1,
            minimumProtocolVersion: 2,
            currentProtocolVersion: 3,
            declarationTransport: 'http-header-and-socket-auth-v1',
        },
    });
    const createClient = () => createPluginUiDataClient({
        pluginId,
        accountLifetime: lifetime,
        readAvailability: options.readAvailability
            ?? (() => options.availabilityReader ?? createAvailabilityReader()),
    });
    return {
        client: createClient(),
        /** Another binding of the same loaded module, as a fresh Action invocation gets. */
        createClient,
        transport,
        accountKvWrites,
        retire: () => {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        },
    };
}

describe('Plugin UI Data client', () => {
    it('carries one prefix-set query through the public Account Collection adapter', async () => {
        const { client, transport } = await loadClient();
        const prefixes = [['open'], ['closed']];
        await expect(client.collection(collectionDefinition).query({ index: 'by-status', prefixes, order: 'asc' }))
            .resolves.toMatchObject({ rows: [], changeCursor: 1 });
        const reads = transport.mock.calls.filter(([path]) => path === '/v1/plugins/data/query');
        expect(reads).toHaveLength(1);
        expect(JSON.parse(String(reads[0]?.[1]?.body))).toMatchObject({ indexId: 'by-status', prefixes });
    });
    it('normalizes one Collection definition once, however many bindings and operations reach it', async () => {
        // Channels calls `collection(DEFINITION)` per operation, from a fresh binding per Action
        // invocation; each normalization digests the whole contract (a 322 KB schema for Channels).
        let definitionReads = 0;
        const counted = new Proxy(collectionDefinition, {
            get(target, key, receiver) { definitionReads++; return Reflect.get(target, key, receiver); },
            ownKeys(target) { definitionReads++; return Reflect.ownKeys(target); },
        });
        const first = await loadClient();
        first.client.collection(counted);
        const firstNormalization = definitionReads;
        first.client.collection(counted);
        const second = { client: first.createClient() };
        second.client.collection(counted);
        second.client.collection(counted);
        expect({ firstNormalization: firstNormalization > 0, repeatedReads: definitionReads - firstNormalization })
            .toEqual({ firstNormalization: true, repeatedReads: 0 });
        // The held normalization still addresses the admitted contract.
        await expect(second.client.collection(counted).query({ index: 'by-status', prefix: ['open'], order: 'asc' }))
            .resolves.toMatchObject({ rows: [] });
        // A different definition object is normalized on its own (and refused when the release does not admit it).
        expect(() => second.client.collection(forgedCollectionDefinition)).not.toThrow();
    });
    it('normalizes an equal Collection declaration once when every bridge message carries a fresh copy', async () => {
        // The hosted-web bridge parses the declaration out of each message, so no two operations share an object.
        const harness = await loadClient();
        const contracts = await import('@happier-dev/protocol/plugins/data/collectionsV1');
        const normalizations = vi.spyOn(contracts, 'normalizePluginAccountCollectionContractV1');
        const declared = JSON.stringify(projectPluginAccountCollectionDeclaration(collectionDefinition.id, collectionDefinition));
        const message = () => JSON.parse(declared) as typeof collectionDefinition;
        try {
            // Workload: 1 cold operation, then 10 messages with equal declarations.
            harness.client.collection(message());
            const cold = normalizations.mock.calls.length;
            for (let index = 0; index < 10; index += 1) harness.client.collection(message());
            expect({ cold, repeated: normalizations.mock.calls.length - cold }).toEqual({ cold: 1, repeated: 0 });
            await expect(harness.client.collection(message()).query({ index: 'by-status', prefix: ['open'], order: 'asc' }))
                .resolves.toMatchObject({ rows: [] });
            // A changed declaration under the same id is judged again, never answered from the held one
            // (this one lacks its migration, so the release cannot declare it).
            const changed = { ...message(), schemaVersion: 3, readableSchemaVersions: [1, 2, 3] };
            expect(() => harness.client.collection(changed as typeof collectionDefinition)).toThrow('not declared');
            // The entry follows the latest declaration: returning to the original prepares it once more.
            harness.client.collection(message());
            expect(normalizations.mock.calls.length - cold).toBe(1);
        } finally { normalizations.mockRestore(); }
    });
    it.each(['cancelled', 'retired', 'lost', 'malformed'] as const)('settles issued Account KV transactions without replay when %s', async (settlement) => {
        const cancellation = new AbortController();
        let retire: () => void = () => undefined;
        let persisted: unknown;
        const harness = await loadClient({
            accountKvWrite: (body) => {
                persisted = body;
                if (settlement === 'cancelled') cancellation.abort();
                if (settlement === 'retired') retire();
                if (settlement === 'lost') throw new Error('Response lost after commit');
                return new Response(JSON.stringify(settlement === 'malformed' ? {} : { status: 'updated', revision: 0 }), { status: 200 });
            },
        });
        retire = harness.retire;
        let callbacks = 0;
        const outcome = harness.client.accountKv.transaction(async (transaction) => {
            callbacks += 1;
            await transaction.set('theme', 'dark', { expectedVersion: 'absent' });
            return 'callback-result';
        }, { signal: cancellation.signal });
        if (settlement === 'lost' || settlement === 'malformed') {
            await expect(outcome).rejects.toMatchObject({ code: 'plugin_account_storage_outcome_unknown', retryable: false });
        } else {
            await expect(outcome).resolves.toBe('callback-result');
        }
        expect(callbacks).toBe(1);
        expect(persisted).toMatchObject({ content: { t: 'plain', v: { values: { theme: { value: 'dark' } } } } });
    });

    it('preserves an issued Collection put through the UI facade after retirement', async () => {
        let retire: () => void = () => undefined;
        const harness = await loadClient({
            mutationResponse: () => {
                retire();
                return new Response(JSON.stringify({
                    status: 'updated', results: [{ rowId: 'task-1', revision: 2, deleted: false }], changeCursor: 19,
                }), { status: 200 });
            },
        });
        retire = harness.retire;
        const value = { id: 'task-1', title: 'Settled', status: 'open' as const };
        await expect(harness.client.collection(collectionDefinition).put(value, { expectedRevision: 1 }))
            .resolves.toEqual({ rowId: 'task-1', revision: 2, value });
    });

    it('rejects Account KV before transport when the exact current release lacks storage.account', async () => {
        const admitted = createAvailabilityReader();
        const currentRelease = admitted.readCurrentReleaseSelection({ pluginId });
        if (currentRelease.kind !== 'available') throw new Error('Fixture requires a current release.');
        const availabilityReader = createPluginAccountAvailabilityReader({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            snapshot: {
                availabilityCursor: 8,
                materializations: [],
                snapshots: [],
                intentReads: [{
                    pluginId,
                    response: {
                        availabilityCursor: 8,
                        packageAssets: [],
                        hostingCapability: {
                            enabled: true,
                            maxArtifactBytes: 1024,
                            maxAccountBytes: 2048,
                        },
                        intent: {
                            pluginId,
                            desiredVersion: '1.0.0',
                            enabled: true,
                            offlineUiHosting: 'enabled',
                            writableCollections: [ref],
                            revision: 'intent-8',
                        },
                        release: {
                            ref: currentRelease.release.ref,
                            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                            normalizedManifest: PluginManifestV2Schema.parse({
                                ...normalizedManifest,
                                hostAccess: { required: [], optional: [] },
                            }),
                            collectionContracts: [ref],
                            uiSlots: [],
                            packageAssetArchive: {
                                archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                                resources: [],
                            },
                        },
                        uiArtifacts: [],
                    },
                }],
            } satisfies PluginAccountAvailabilitySnapshot,
        });
        let currentAvailabilityReader = createAvailabilityReader();
        const { client, transport } = await loadClient({
            readAvailability: () => currentAvailabilityReader,
        });
        currentAvailabilityReader = availabilityReader;

        await expect(client.accountKv.get('theme')).rejects.toMatchObject({
            code: 'plugin_account_storage_unavailable',
        });
        expect(transport).not.toHaveBeenCalledWith(
            `/v1/account/plugin-storage/${pluginId}`,
            expect.anything(),
        );
    });

    it('reaches the plugin\'s own Account KV row from a surface with no daemon in the path', async () => {
        const { client, accountKvWrites, transport } = await loadClient();

        await expect(client.accountKv.get('theme')).resolves.toBeNull();

        const written = await client.accountKv.set('theme', { mode: 'dark' }, {
            expectedVersion: 'absent',
        });
        expect(written).toEqual({ version: 0 });
        expect(accountKvWrites).toEqual([{
            expectedRevision: 'absent',
            content: { t: 'plain', v: { v: 1, values: { theme: { version: 0, value: { mode: 'dark' } } } } },
        }]);
        expect(transport.mock.calls.some(([path]) => path === '/v1/plugins/data/mutate')).toBe(false);
    });

    it('applies the same per-key CAS, tombstone and paging rules the daemon scope applies', async () => {
        const row = {
            v: 1,
            values: {
                'a/1': { version: 2, value: 'one' },
                'a/2': { version: 0, value: 'two' },
                'b/1': { version: 5, deleted: true },
            },
        };
        const { client, accountKvWrites } = await loadClient({
            accountKvRead: () => new Response(
                JSON.stringify({ status: 'present', revision: 9, content: { t: 'plain', v: row } }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        });

        await expect(client.accountKv.get('a/1')).resolves.toEqual({ version: 2, value: 'one' });
        await expect(client.accountKv.get('b/1')).resolves.toEqual({ version: 5, deleted: true });

        // A stale writer that believes the key is absent must not resurrect it.
        // The Protocol row owner's own error class already carries this `code`, so
        // the name is asserted too: it is what proves the surface translated the
        // rule violation into the author-facing `PluginError` a daemon plugin gets,
        // rather than leaking a raw internal error past the SDK contract.
        await expect(client.accountKv.set('b/1', 'revived', { expectedVersion: 'absent' }))
            .rejects.toMatchObject({ name: 'PluginError', code: 'plugin_account_kv_conflict' });
        await expect(client.accountKv.set('a/1', 'stale', { expectedVersion: 1 }))
            .rejects.toMatchObject({ code: 'plugin_account_kv_conflict' });
        expect(accountKvWrites).toEqual([]);

        const page = await client.accountKv.list({ prefix: 'a/', limit: 1 });
        expect(page.items).toEqual([{ key: 'a/1', version: 2, value: 'one' }]);
        expect(page.nextCursor).toBeDefined();
        await expect(client.accountKv.list({ prefix: 'a/', limit: 1, cursor: page.nextCursor! }))
            .resolves.toMatchObject({ items: [{ key: 'a/2', version: 0, value: 'two' }] });

        await expect(client.accountKv.list({ prefix: '@happier/anything' }))
            .rejects.toMatchObject({ code: 'plugin_account_kv_invalid' });
    });

    it('reports a typed conflict without rebasing when another key advanced the physical row', async () => {
        let readCount = 0;
        let writeCount = 0;
        const { client, accountKvWrites } = await loadClient({
            accountKvRead: () => {
                readCount += 1;
                return new Response(JSON.stringify({
                    status: 'present',
                    revision: 4,
                    content: {
                        t: 'plain',
                        v: { v: 1, values: { other: { version: 0, value: 'before' } } },
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            },
            accountKvWrite: () => {
                writeCount += 1;
                return new Response(
                    JSON.stringify({ status: 'conflict', revision: 5 }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            },
        });

        // A rebasing implementation would reread revision 5, overlay `target`
        // and commit a second time. The approved contract does not: one read,
        // one CAS, and the author owns the retry.
        await expect(client.accountKv.set('target', 'mine', { expectedVersion: 'absent' }))
            .rejects.toMatchObject({ name: 'PluginError', code: 'plugin_account_kv_conflict' });

        expect(accountKvWrites).toEqual([{
            expectedRevision: 4,
            content: {
                t: 'plain',
                v: {
                    v: 1,
                    values: {
                        other: { version: 0, value: 'before' },
                        target: { version: 0, value: 'mine' },
                    },
                },
            },
        }]);
        expect(readCount).toBe(1);
        expect(writeCount).toBe(1);
    });

    it('invokes a transaction callback once and never re-enters it after a physical conflict', async () => {
        let readCount = 0;
        let writeCount = 0;
        const callback = vi.fn(async (transaction: AccountKvTransaction) => {
            const source = await transaction.get<number>('source');
            await transaction.set('derived', (source && 'value' in source ? source.value : 0) * 2, {
                expectedVersion: 'absent',
            });
        });
        const { client } = await loadClient({
            accountKvRead: () => {
                readCount += 1;
                return new Response(JSON.stringify({
                    status: 'present',
                    revision: readCount,
                    content: {
                        t: 'plain',
                        v: {
                            v: 1,
                            values: {
                                source: {
                                    version: readCount - 1,
                                    value: readCount + 1,
                                },
                            },
                        },
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            },
            accountKvWrite: () => {
                writeCount += 1;
                return new Response(JSON.stringify({ status: 'conflict', revision: 2 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
        });

        await expect(client.accountKv.transaction(callback))
            .rejects.toMatchObject({ name: 'PluginError', code: 'plugin_account_kv_conflict' });
        // One snapshot, one callback invocation, one CAS: a replaying or
        // rereading implementation would move at least one of these counters.
        expect(callback).toHaveBeenCalledOnce();
        expect(readCount).toBe(1);
        expect(writeCount).toBe(1);
    });

    it('serializes overlapping service mutations and gives the loser a typed conflict', async () => {
        let releaseInitialReads!: () => void;
        const initialReadsStarted = new Promise<void>((resolve) => {
            releaseInitialReads = resolve;
        });
        let readCount = 0;
        let writeCount = 0;
        let persisted: unknown = null;
        const { client, accountKvWrites } = await loadClient({
            accountKvRead: async () => {
                readCount += 1;
                if (readCount === 2) releaseInitialReads();
                await initialReadsStarted;
                return new Response(JSON.stringify({ status: 'absent' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
            accountKvWrite: (body) => {
                writeCount += 1;
                const request = PluginAccountStorageMutationRequestV1Schema.parse(body);
                if (writeCount === 1) {
                    persisted = request.content;
                    return new Response(JSON.stringify({ status: 'updated', revision: 0 }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                return new Response(JSON.stringify({ status: 'conflict', revision: 0 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
        });

        // Both mutations observe the same absent row, so the second one loses
        // the single physical CAS. Disjoint logical keys do not make it safe to
        // rebase and retry behind the author's back: the loser is told.
        const outcomes = await Promise.allSettled([
            client.accountKv.set('first', 1, { expectedVersion: 'absent' }),
            client.accountKv.set('second', 2, { expectedVersion: 'absent' }),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled'))
            .toEqual([{ status: 'fulfilled', value: { version: 0 } }]);
        const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
        expect(rejected).toMatchObject({
            reason: { name: 'PluginError', code: 'plugin_account_kv_conflict' },
        });
        expect(accountKvWrites).toHaveLength(2);
        expect(writeCount).toBe(2);
        expect(readCount).toBe(2);
        expect(persisted).toEqual({
            t: 'plain',
            v: { v: 1, values: { first: { version: 0, value: 1 } } },
        });
    });

    it('treats service mutations during an awaiting transaction as separate logical mutations', async () => {
        let revision: number | 'absent' = 'absent';
        let persistedContent: unknown = null;
        const { client } = await loadClient({
            accountKvRead: () => revision === 'absent'
                ? new Response(JSON.stringify({ status: 'absent' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(JSON.stringify({
                    status: 'present',
                    revision,
                    content: persistedContent,
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            accountKvWrite: (body) => {
                const request = PluginAccountStorageMutationRequestV1Schema.parse(body);
                if (request.expectedRevision !== revision) {
                    return new Response(JSON.stringify({ status: 'conflict', revision }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                revision = revision === 'absent' ? 0 : revision + 1;
                persistedContent = request.content;
                return new Response(JSON.stringify({ status: 'updated', revision }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
        });
        let markTransactionPaused!: () => void;
        const transactionPaused = new Promise<void>((resolve) => {
            markTransactionPaused = resolve;
        });
        let resumeTransaction!: () => void;
        const transactionResume = new Promise<void>((resolve) => {
            resumeTransaction = resolve;
        });

        const explicitTransaction = client.accountKv.transaction(async (transaction) => {
            await transaction.set('transaction-write', 1, { expectedVersion: 'absent' });
            markTransactionPaused();
            await transactionResume;
            await expect(client.accountKv.transaction(async (nested) => await nested.set(
                'nested-transaction-write',
                4,
                { expectedVersion: 'absent' },
            )))
                .rejects.toMatchObject({ code: 'plugin_account_kv_invalid' });
            await expect(client.accountKv.delete(
                'independent-write',
                { expectedVersion: 0 },
            )).resolves.toEqual({ version: 1, deleted: true });
            await expect(client.accountKv.set(
                'callback-service-write',
                3,
                { expectedVersion: 'absent' },
            )).resolves.toEqual({ version: 0 });
        });
        await transactionPaused;
        const independentWrite = client.accountKv.set('independent-write', 2, {
            expectedVersion: 'absent',
        });
        const [independentOutcome] = await Promise.allSettled([independentWrite]);
        resumeTransaction();

        const [transactionOutcome] = await Promise.allSettled([explicitTransaction]);
        // The service calls really are separate logical mutations: each one
        // read, committed and advanced the physical row while the callback was
        // still open. That is exactly why the enclosing transaction — still
        // holding the snapshot it opened on — loses its one CAS and reports a
        // typed conflict instead of being replayed onto the newer row.
        expect(transactionOutcome).toMatchObject({
            status: 'rejected',
            reason: { name: 'PluginError', code: 'plugin_account_kv_conflict' },
        });
        expect(independentOutcome).toEqual({ status: 'fulfilled', value: { version: 0 } });
        expect(persistedContent).toEqual({
            t: 'plain',
            v: {
                v: 1,
                values: {
                    'callback-service-write': { version: 0, value: 3 },
                    'independent-write': { version: 1, deleted: true },
                },
            },
        });
    });

    it('honors cancellation supplied to an individual direct transaction method', async () => {
        const { client, accountKvWrites } = await loadClient();
        const cancellation = new AbortController();
        cancellation.abort();

        await expect(client.accountKv.transaction(async (transaction) => {
            return await transaction.set('cancelled', true, {
                expectedVersion: 'absent',
                signal: cancellation.signal,
            });
        })).rejects.toMatchObject({ code: 'plugin_collection_cancelled' });
        expect(accountKvWrites).toEqual([]);
    });

    it('keeps an inner direct transaction signal active through the physical commit', async () => {
        const { client, accountKvWrites } = await loadClient();
        const cancellation = new AbortController();

        await expect(client.accountKv.transaction(async (transaction) => {
            await transaction.set('cancelled', true, {
                expectedVersion: 'absent',
                signal: cancellation.signal,
            });
            cancellation.abort();
        })).rejects.toMatchObject({ code: 'plugin_collection_cancelled' });
        expect(accountKvWrites).toEqual([]);
    });

    it('carries an inner direct transaction signal into the physical commit request', async () => {
        const cancellation = new AbortController();
        let dispatched!: () => void;
        const dispatch = new Promise<void>((resolve) => { dispatched = resolve; });
        let requestSignal: AbortSignal | null = null;
        const { client, accountKvWrites } = await loadClient({
            accountKvWrite: async (_body, init) => {
                requestSignal = init?.signal ?? null;
                dispatched();
                // A real transport rejects an in-flight request when its own
                // signal aborts, so the interrupted physical write settles the
                // way the platform settles it.
                await new Promise<void>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        reject(new Error('Account KV commit request aborted'));
                    }, { once: true });
                });
                return new Response(JSON.stringify({ status: 'updated', revision: 3 }), { status: 200 });
            },
        });

        const outcome = client.accountKv.transaction(async (transaction) => {
            await transaction.set('cursor', true, {
                expectedVersion: 'absent',
                signal: cancellation.signal,
            });
        });
        await dispatch;
        expect(requestSignal).not.toBeNull();
        expect(requestSignal!.aborted).toBe(false);

        cancellation.abort();

        expect(requestSignal!.aborted).toBe(true);
        // Cancelling a dispatched write cannot claim the server did not commit.
        await expect(outcome).rejects.toMatchObject({
            code: 'plugin_account_storage_outcome_unknown',
        });
        expect(accountKvWrites).toHaveLength(1);
    });

    it('preserves a direct Account KV physical conflict after cancellation without rereading', async () => {
        const cancellation = new AbortController();
        let reads = 0;
        const { client, accountKvWrites } = await loadClient({
            accountKvRead: () => {
                reads += 1;
                return new Response(JSON.stringify({ status: 'absent' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
            accountKvWrite: () => {
                cancellation.abort();
                return new Response(JSON.stringify({ status: 'conflict', revision: 0 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
        });

        await expect(client.accountKv.set('target', 'mine', {
            expectedVersion: 'absent',
            signal: cancellation.signal,
        })).rejects.toMatchObject({ code: 'plugin_account_kv_conflict' });

        expect(accountKvWrites).toHaveLength(1);
        expect(reads).toBe(1);
    });

    it('writes one atomic row for a transaction and rejects when a written dependency changed', async () => {
        let readCount = 0;
        const { client, accountKvWrites } = await loadClient({
            accountKvRead: () => {
                readCount += 1;
                return readCount === 1
                    ? new Response(JSON.stringify({ status: 'absent' }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    })
                    : new Response(JSON.stringify({
                        status: 'present',
                        revision: 12,
                        content: {
                            t: 'plain',
                            v: {
                                v: 1,
                                values: { one: { version: 0, value: 'external' } },
                            },
                        },
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            },
            accountKvWrite: () => new Response(
                JSON.stringify({ status: 'conflict', revision: 12 }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        });

        await expect(client.accountKv.transaction(async (transaction) => {
            await transaction.set('one', 1, { expectedVersion: 'absent' });
            await transaction.set('two', 2, { expectedVersion: 'absent' });
        })).rejects.toMatchObject({ code: 'plugin_account_kv_conflict' });

        expect(accountKvWrites).toHaveLength(1);
        // The row the transaction saw is the only row it writes against: no
        // second read is spent looking for a rebase opportunity.
        expect(readCount).toBe(1);
        expect(accountKvWrites[0]).toMatchObject({
            expectedRevision: 'absent',
            content: {
                t: 'plain',
                v: { v: 1, values: { one: { version: 0, value: 1 }, two: { version: 0, value: 2 } } },
            },
        });
    });

    it('refuses Account KV work after the captured Account scope is retired', async () => {
        const { client, retire } = await loadClient();
        retire();

        await expect(client.accountKv.get('theme'))
            .rejects.toMatchObject({ code: 'plugin_account_storage_unavailable' });
    });

    it('preserves server refusal of an incompatible exact local contract without mutation', async () => {
        const { client, transport } = await loadClient({
            collectionContractRead: () => new Response(JSON.stringify({ error: 'collection_unavailable' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            }),
        });
        const collection = client.collection(forgedCollectionDefinition);

        await expect(collection.put({
            id: 'task-1',
            title: 'Forged local contract',
            status: 'open',
        }, { expectedRevision: 'absent' })).rejects.toMatchObject({
            code: 'plugin_collection_undeclared',
        });
        expect(transport.mock.calls.some(([path]) => path === '/v1/plugins/data/contract')).toBe(true);
        expect(transport.mock.calls.some(([path]) => path === '/v1/plugins/data/mutate')).toBe(false);
    });

    it('reads an exact retained same-version contract admitted read-only by the server and cannot mutate it', async () => {
        const { client, transport } = await loadClient({
            availabilityReader: createAvailabilityReader({ ...ref, contractDigest: `${'B'.repeat(42)}A` }),
            collectionContractRead: () => new Response(JSON.stringify({ access: 'readOnly', contract }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
            collectionRead: () => new Response(JSON.stringify({ row: { rowId: 'task-1', revision: 3,
                content: { t: 'plain', v: { addedPrivateField: 'new writer' } },
                projection: { title: 'Retained row', status: 'open' } }, absenceEpoch: 0 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        });
        const collection = client.collection(collectionDefinition);
        await expect(collection.get('task-1')).resolves.toEqual({ rowId: 'task-1', revision: 3,
            value: { id: 'task-1', title: 'Retained row', status: 'open' } });
        const contractCall = transport.mock.calls.find(([path]) => path === '/v1/plugins/data/contract');
        expect(JSON.parse(String(contractCall?.[1]?.body))).toMatchObject({ ref });
        await expect(collection.put({ id: 'task-1', title: 'Retained', status: 'open' }, { expectedRevision: 'absent' }))
            .rejects.toMatchObject({ code: 'plugin_account_storage_unavailable' });
        expect(transport.mock.calls.some(([path]) => path === '/v1/plugins/data/mutate')).toBe(false);
    });

    it('uses the exact admitted release contract before a direct offline CAS', async () => {
        const { client, transport } = await loadClient();
        const collection = client.collection(collectionDefinition);

        await expect(collection.put({
            id: 'task-1',
            title: 'Close the migration',
            status: 'open',
        }, { expectedRevision: 'absent' })).resolves.toEqual({
            rowId: 'task-1',
            revision: 2,
            value: {
                id: 'task-1',
                title: 'Close the migration',
                status: 'open',
            },
        });

        const contractCall = transport.mock.calls.find(([path]) => path === '/v1/plugins/data/contract');
        expect(contractCall).toBeDefined();
        const mutationCall = transport.mock.calls.find(([path]) => path === '/v1/plugins/data/mutate');
        expect(mutationCall).toBeDefined();
        expect(JSON.parse(String(mutationCall?.[1]?.body))).toMatchObject({
            pluginId,
            collectionId: 'tasks',
            writerContext: {
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            },
        });
    });

    it('derives a mode-aware identity tag from a surface through the one host derivation owner', async () => {
        const { client } = await loadClient();
        const collection = client.collection(collectionDefinition);

        await expect(collection.identityTag({
            field: 'id',
            components: ['github', 'pull-request', '42'],
        })).resolves.toBe(derivePluginCollectionIdentityTagV1({
            accountEncryptionMode: 'plain',
            material: null,
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            field: 'id',
            components: ['github', 'pull-request', '42'],
        }));
    });

    it('refuses an identity field the admitted contract does not declare with the code a daemon plugin already handles', async () => {
        const { client } = await loadClient();
        const collection = client.collection(collectionDefinition);

        await expect(collection.identityTag({
            field: 'title',
            components: ['github'],
        })).rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
    });

    it('rejects a retained collection facade once its captured Account lifetime retires', async () => {
        const { client, transport, retire } = await loadClient();
        const collection = client.collection(collectionDefinition);
        retire();

        await expect(collection.put({
            id: 'task-1',
            title: 'Late Account A write',
            status: 'open',
        }, { expectedRevision: 'absent' })).rejects.toMatchObject({
            code: 'plugin_account_storage_unavailable',
        });
        expect(transport).not.toHaveBeenCalled();
    });

    it('gives a plugin UI the same effective Collection limits a daemon plugin plans against', async () => {
        const { client, transport } = await loadClient();
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({
            serverId: 'server-a',
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {},
                    capabilities: {
                        pluginDataCollections: {
                            maxRowEncodedBytes: 256 * 1024,
                            maxBatchBytes: 4 * 1024 * 1024,
                            maxBatchRows: 40,
                            maxAccountRows: 5_000,
                            maxAccountBytes: 64 * 1024 * 1024,
                        },
                    },
                }),
            },
        });

        await expect(client.collection(collectionDefinition).limits()).resolves.toEqual({
            maxRowEncodedBytes: 256 * 1024,
            maxRows: 5_000,
            maxCollectionEncodedBytes: 64 * 1024 * 1024,
            maxBatchBytes: 4 * 1024 * 1024,
            maxBatchRows: 40,
            maxAccountRows: 5_000,
            maxAccountBytes: 64 * 1024 * 1024,
            basis: 'deployment',
        });
        expect(transport.mock.calls.some(([path]) => path === '/v1/plugins/data/mutate')).toBe(false);
    });

    it('reports the shipped deployment policy to a plugin UI when no capability is published', async () => {
        const { client } = await loadClient();

        await expect(client.collection(collectionDefinition).limits()).resolves.toEqual({
            ...PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
            maxRows: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountRows,
            maxCollectionEncodedBytes: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountBytes,
            basis: 'default',
        });
    });

    it('measures a plugin UI batch through the same sealed request its write sends', async () => {
        const { client, transport } = await loadClient();
        const collection = client.collection(collectionDefinition);
        const operations = [
            {
                kind: 'put' as const,
                expectedRevision: 'absent' as const,
                value: { id: 'task-1', title: 'a'.repeat(8), status: 'open' as const },
            },
            {
                kind: 'put' as const,
                expectedRevision: 'absent' as const,
                value: { id: 'task-2', title: 'b'.repeat(200), status: 'open' as const },
            },
        ];

        const measurement = await collection.measureBatch(operations);
        await collection.batch(operations);

        expect(measurement.operationEncodedBytes).toHaveLength(2);
        expect(measurement.operationEncodedBytes[1]!).toBeGreaterThan(
            measurement.operationEncodedBytes[0]! + 190,
        );
        const mutationCall = transport.mock.calls.find(([path]) => path === '/v1/plugins/data/mutate');
        const sentRequest = PluginCollectionMutationRequestV1Schema.parse(
            JSON.parse(String(mutationCall?.[1]?.body)),
        );
        expect(
            measurement.overheadEncodedBytes
            + measurement.operationEncodedBytes.reduce((total, bytes) => total + bytes, 0)
            - 1,
        ).toBe(measurePluginCollectionMutationRequestEncodedBytesV1(sentRequest));
    });

    it('refuses to size a batch for a same-id local definition the release does not admit', async () => {
        const { client, transport } = await loadClient({
            collectionContractRead: () => new Response(JSON.stringify({ error: 'collection_unavailable' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            }),
        });

        await expect(client.collection(forgedCollectionDefinition).limits()).rejects.toMatchObject({
            code: 'plugin_collection_undeclared',
        });
        expect(transport.mock.calls.some(([path]) => path === '/v1/plugins/data/mutate')).toBe(false);
    });
    it.each(['contract', 'rows'] as const)(
        'keeps a Collection HTTP 503 retryable at the public %s boundary and recovers',
        async boundary => {
            let unavailable = true;
            const outage = () => new Response(JSON.stringify({ error: 'database_connection_unavailable' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
            });
            const { client } = await loadClient(boundary === 'contract' ? {
                collectionContractRead: () => unavailable
                    ? outage() : Response.json({ access: 'writable', contract }),
            } : {
                collectionRead: () => unavailable
                    ? outage() : Response.json({ rows: [], changeCursor: 1 }),
            });
            const collection = client.collection(collectionDefinition);
            await expect(collection.query({ index: 'by-status', prefix: ['open'], order: 'asc' }))
                .rejects.toMatchObject({ code: 'plugin_account_storage_unavailable', retryable: true });
            unavailable = false;
            await expect(collection.query({ index: 'by-status', prefix: ['open'], order: 'asc' }))
                .resolves.toMatchObject({ rows: [], changeCursor: 1 });
        },
    );

    it.each([
        'collection_index_not_ready', 'collection_update_required',
        'collection_content_mode_mismatch', 'collection_contract_inconsistent',
    ])('preserves %s as a nonretryable Collection read refusal without extra requests', async code => {
        const { client, transport } = await loadClient({
            collectionRead: () => new Response(JSON.stringify({ error: code }), { status: 409 }),
        });
        const collection = client.collection(collectionDefinition);
        await expect(collection.get('task-1')).rejects.toMatchObject({ code, retryable: false });
        await expect(collection.query({ index: 'by-status', prefix: ['open'], order: 'asc' }))
            .rejects.toMatchObject({ code, retryable: false });
        expect(transport.mock.calls.filter(([path]) => path === '/v1/plugins/data/get')).toHaveLength(1);
        expect(transport.mock.calls.filter(([path]) => path === '/v1/plugins/data/query')).toHaveLength(1);
    });

    it('keeps the exact compiled reader refusal visible to a bundled plugin UI', async () => {
        const { client, transport } = await loadClient({
            collectionContractRead: () => new Response(JSON.stringify({ error: 'collection_update_required' }), {
                status: 409, headers: { 'Content-Type': 'application/json' },
            }),
        });
        await expect(client.collection(collectionDefinition).limits()).rejects.toMatchObject({ code: 'collection_update_required' });
        expect(transport.mock.calls.some(([path]) => path === '/v1/plugins/data/mutate')).toBe(false);
    });

    it('projects local envelope size refusals through the real UI Data adapter as PluginError', async () => {
        const definition = defineAccountCollection({ ...collectionDefinition,
            schema: defineProtocolObject({
                id: defineProtocolString({ maxLength: 256 }),
                title: defineProtocolString({ maxLength: 256 }),
                status: defineProtocolUnion([defineProtocolLiteral('open'), defineProtocolLiteral('closed')]),
                privateNote: defineProtocolString(),
            }, { policy: 'closed' }),
        });
        const largeContract = normalizePluginAccountCollectionContractV1({ pluginId,
            contribution: PluginAccountCollectionContributionV1Schema.parse(
                projectPluginAccountCollectionDeclaration(definition.id, definition),
            ),
        });
        const { client, transport } = await loadClient({
            availabilityReader: createAvailabilityReader({ ...ref, contractDigest: largeContract.contractDigest }),
            collectionContractRead: () => new Response(JSON.stringify({ access: 'writable', contract: largeContract }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            }),
        });
        const maximum = PLUGIN_COLLECTION_LIMITS_V1.maximumPrivateEnvelopeEncodedBytes;
        const operations = [{ kind: 'put' as const, expectedRevision: 1,
            value: { id: 'task-1', title: 'Large', status: 'open' as const, privateNote: 'é'.repeat(maximum / 2) } }];
        const collection = client.collection(definition);
        const expected = { code: 'collection_quota_incompatible',
            details: { dimension: 'maxRowEncodedBytes', effectiveMaximum: maximum } };
        await expect(collection.measureBatch(operations)).rejects.toMatchObject(expected);
        await expect(collection.batch(operations)).rejects.toMatchObject(expected);
        expect(transport.mock.calls.some(([path]) => path === '/v1/plugins/data/mutate')).toBe(false);
    });

    it('hands a plugin UI the same typed quota incompatibility a daemon plugin receives', async () => {
        const { client } = await loadClient({
            mutationResponse: () => new Response(JSON.stringify({
                error: 'collection_quota_incompatible',
                dimension: 'maxBatchBytes',
                effectiveMaximum: 4 * 1024 * 1024,
            }), { status: 413, headers: { 'Content-Type': 'application/json' } }),
        });

        await expect(client.collection(collectionDefinition).batch([{
            kind: 'put',
            expectedRevision: 'absent',
            value: { id: 'task-1', title: 'Too large for one batch', status: 'open' },
        }])).rejects.toMatchObject({
            code: 'collection_quota_incompatible',
            details: { dimension: 'maxBatchBytes', effectiveMaximum: 4 * 1024 * 1024 },
        });
    });
});


it('pushes configured health result batches without per-row reads or equal-result publications', async () => {
    const current = (id: string, status = 'up', observedAt = 1, history?: import('@happier-dev/plugins-machine-services/health-results').HealthResultProjection['checks'][number]['history']) => ({ v: 1,
        members: [{ automationId: id, triggerId: id, triggerRevision: 1, sourceSelectorId: 'selector-' + id }],
        checks: [{ checkId: 'http', ...(history ? { history } : {}), result: { status, observedAt, evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'http' }, author: { kind: 'process' }, text: 'result' }] } } }] });
    let values = { 'health:a': { version: 1, value: { current: current('a') } },
        'health:b': { version: 1, value: { current: current('b') } } };
    const harness = await loadClient({ accountKvRead: () => Response.json({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, values } } }) });
    const { observeConfiguredHealthResults, configuredHealthResultKey, configuredHealthResultsForTrigger } = await import('@/components/store/inventory/configuredHealthResults');
    const { registerActivePluginCollectionChangeWatch, publishActivePluginCollectionChanges } = await import('./pluginCollectionChangeWatch');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    const controller = new AbortController();
    const published: Parameters<Parameters<typeof observeConfiguredHealthResults>[0]['publish']>[0][] = [];
    const dispose = observeConfiguredHealthResults({ kv: harness.client.accountKv, signal: controller.signal,
        subscribe: listener => {
            const watch = registerActivePluginCollectionChangeWatch({ pluginId, kvPrefix: 'health:', lifetime, onInvalidated: listener });
            return () => watch.dispose();
        }, publish: value => published.push(value) });
    const reads = () => harness.transport.mock.calls.filter(([path]) => path === '/v1/account/plugin-storage/' + pluginId).length;
    const { buildPluginDomainAccountChangeEntityId, PluginDomainChangeEntrySchema } = await import('@happier-dev/protocol/changes');
    const hint = (cursor: number, id: string) => publishActivePluginCollectionChanges([PluginDomainChangeEntrySchema.parse({ kind: 'pluginDomain', changedAt: 1,
        entityId: buildPluginDomainAccountChangeEntityId({ pluginDomain: 'dataKv', pluginId, keys: [id] }),
        cursor, hint: { pluginDomain: 'dataKv', pluginId, keys: [id] } })]);
    try {
        await vi.waitFor(() => expect(published).toHaveLength(1));
        expect(reads()).toBe(1);
        const first = published[0]!;
        if ('kind' in first) throw Error('Expected health result page');
        expect(configuredHealthResultsForTrigger(first, 'a', { id: 'a', revision: 2, sourceSelectorId: 'selector-a' })).toEqual({ kind: 'neverObserved' });
        expect(configuredHealthResultsForTrigger(first, 'a', { id: 'a', revision: 1, sourceSelectorId: 'other-selector' })).toEqual({ kind: 'neverObserved' });
        hint(10, 'other-domain:row'); await Promise.resolve();
        expect(reads()).toBe(1);
        values = { ...values, 'health:a': { version: 2, value: { current: current('a', 'up', 2) } } };
        hint(11, 'health:a');
        await vi.waitFor(() => expect(reads()).toBe(2));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(published).toHaveLength(1);
        values = { ...values, 'health:a': { version: 3, value: { current: current('a', 'down', 3) } } };
        hint(12, 'health:a');
        await vi.waitFor(() => expect(published).toHaveLength(2));
        const second = published[1]!;
        if ('kind' in second) throw Error('Expected health result page');
        expect(second.results.get(configuredHealthResultKey('a', 'a'))?.state).toMatchObject({ kind: 'available', checks: [{ result: { status: 'down' } }] });
        expect(second.results.get(configuredHealthResultKey('b', 'b'))).toBe(first.results.get(configuredHealthResultKey('b', 'b')));
        const { retainHealthResult, healthResultProjectionSchema } = await import('@happier-dev/plugins-machine-services/health-results');
        const sample = healthResultProjectionSchema.parse(current('a', 'down', Date.now())).checks[0]!;
        const retained = retainHealthResult(undefined, sample.checkId, sample.result);
        values = { ...values, 'health:a': { version: 4, value: { current: current('a', 'down', sample.result.observedAt, retained.history) } } };
        hint(13, 'health:a');
        await vi.waitFor(() => expect(published).toHaveLength(3));
        const third = published[2]!;
        if ('kind' in third) throw Error('Expected health result page');
        expect(third.results.get(configuredHealthResultKey('a', 'a'))?.state).toMatchObject({ kind: 'available',
            checks: [{ history: { uptimePercent: 0, days: [{ down: 1 }] } }] });
        hint(14, 'health:a');
        await vi.waitFor(() => expect(reads()).toBe(5));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(published).toHaveLength(3);
        harness.retire();
        hint(15, 'health:a'); await Promise.resolve();
        expect(reads()).toBe(5);
    } finally { controller.abort(); dispose.dispose(); }
});


it('acquires one health result page until explicit continuation and marks missing partial results notLoaded', async () => {
    const { PLUGIN_ACCOUNT_STORAGE_BROWSER_NEUTRAL_LIMITS_V1 } = await import('@happier-dev/protocol/plugins/data/accountKvValueV1');
    const total = PLUGIN_ACCOUNT_STORAGE_BROWSER_NEUTRAL_LIMITS_V1.maximumLogicalKeys;
    const values = Object.fromEntries(Array.from({ length: total }, (_, index) => {
        const id = String(index).padStart(5, '0');
        return ['health:' + id, { version: 1, value: { current: { v: 1,
            members: [{ automationId: id, triggerId: id, triggerRevision: 1, sourceSelectorId: id }],
            checks: [{ checkId: 'http', result: { status: 'up', observedAt: 1,
                evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'http' }, author: { kind: 'process' }, text: 'up' }] } } }] } } }];
    }));
    const harness = await loadClient({ accountKvRead: () => Response.json({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, values } } }) });
    const { observeConfiguredHealthResults, configuredHealthResultsForTrigger } = await import('@/components/store/inventory/configuredHealthResults');
    const controller = new AbortController();
    const published: Parameters<Parameters<typeof observeConfiguredHealthResults>[0]['publish']>[0][] = [];
    const observer = observeConfiguredHealthResults({ kv: harness.client.accountKv, signal: controller.signal,
        subscribe: () => () => {}, publish: page => published.push(page) });
    const reads = () => harness.transport.mock.calls.filter(([path]) => path === '/v1/account/plugin-storage/' + pluginId).length;
    try {
        await vi.waitFor(() => expect(published).toHaveLength(1));
        expect(reads()).toBe(1);
        const first = published[0]!;
        if ('kind' in first) throw Error('Expected health result page');
        expect(first.results.size).toBeGreaterThan(0);
        expect(first.results.size).toBeLessThan(total);
        expect(first.nextCursor).toBeDefined();
        const id = String(total - 1).padStart(5, '0');
        expect(configuredHealthResultsForTrigger(first, id, { id, revision: 1, sourceSelectorId: id })).toEqual({ kind: 'notLoaded' });
        let current = first;
        let expectedReads = 1;
        while (current.nextCursor) {
            observer.loadNext();
            expectedReads += 1;
            await vi.waitFor(() => expect(published).toHaveLength(expectedReads));
            expect(reads()).toBe(expectedReads);
            const next = published.at(-1)!;
            if ('kind' in next) throw Error('Expected health result page');
            current = next;
        }
        const last = current;
        if ('kind' in last) throw Error('Expected health result page');
        expect(last.preceding).toBe(true);
        expect(last.nextCursor).toBeUndefined();
        expect(configuredHealthResultsForTrigger(last, id, { id, revision: 1, sourceSelectorId: id })).toMatchObject({ kind: 'available' });
        expect(configuredHealthResultsForTrigger(last, '00000', { id: '00000', revision: 1, sourceSelectorId: '00000' })).toEqual({ kind: 'notLoaded' });
    } finally { controller.abort(); observer.dispose(); }
});
