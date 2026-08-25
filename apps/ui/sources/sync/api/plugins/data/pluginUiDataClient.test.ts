import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    derivePluginCollectionIdentityTagV1,
    FeaturesResponseSchema,
    measurePluginCollectionMutationRequestEncodedBytesV1,
    normalizePluginAccountCollectionContractV1,
    PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
    PluginAccountCollectionContributionV1Schema,
    PluginCollectionMutationRequestV1Schema,
    PluginManifestV2Schema,
} from '@happier-dev/protocol';
import { projectPluginAccountCollectionDeclaration, type JsonValue } from '@happier-dev/plugin-sdk';
import {
    defineAccountCollection,
} from '@happier-dev/plugin-sdk/collections';
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
});

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

function createAvailabilityReader() {
    const snapshot = {
        availabilityCursor: 7,
        materializations: [],
        snapshots: [],
        intentReads: [{
            pluginId,
            response: {
                availabilityCursor: 7,
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
                    revision: 'intent-7',
                },
                release: {
                    ref: { pluginId, version: '1.0.0' },
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest,
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
    } satisfies PluginAccountAvailabilitySnapshot;
    return createPluginAccountAvailabilityReader({
        scope: { serverId: 'server-a', accountId: 'account-a' },
        snapshot,
    });
}

async function loadClient(options: Readonly<{
    mutationResponse?: () => Response;
    accountKvRead?: () => Response;
    accountKvWrite?: (body: unknown) => Response;
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
            return new Response(JSON.stringify({
                mode: 'plain',
                version: 7,
                signingKeyFingerprint: null,
                contentKeyFingerprint: null,
                updatedAt: 11,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/v1/plugins/data/contract') {
            return new Response(JSON.stringify({ contract }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (path === `/v1/account/plugin-storage/${pluginId}`) {
            if ((_init?.method ?? 'GET') === 'GET') {
                return options.accountKvRead?.() ?? new Response(
                    JSON.stringify({ status: 'absent' }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            const parsedBody = JSON.parse(String(_init?.body ?? 'null')) as unknown;
            accountKvWrites.push(parsedBody);
            return options.accountKvWrite?.(parsedBody) ?? new Response(
                JSON.stringify({ status: 'updated', revision: 3 }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
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
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope', () => ({
        captureSessionRequestAuthorityForServerAccountScope: async () => ({
            scope: lifetime.scope,
            context: { token: 'account-token' },
            request: transport,
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
    return {
        client: createPluginUiDataClient({
            pluginId,
            accountLifetime: lifetime,
            availabilityReader: createAvailabilityReader(),
        }),
        transport,
        accountKvWrites,
        retire: () => {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        },
    };
}

describe('Plugin UI Data client', () => {
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

    it('writes one atomic row for a transaction and reports a row-CAS conflict to the author', async () => {
        const { client, accountKvWrites } = await loadClient({
            accountKvWrite: () => new Response(
                JSON.stringify({ status: 'conflict', revision: 12 }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        });

        await expect(client.accountKv.transaction(async (transaction) => {
            await transaction.set('one', 1, { expectedVersion: 'absent' });
            await transaction.set('two', 2, { expectedVersion: 'absent' });
            await expect(client.accountKv.set('three', 3, { expectedVersion: 'absent' }))
                .rejects.toMatchObject({ code: 'plugin_account_kv_invalid' });
        })).rejects.toMatchObject({ code: 'plugin_account_kv_conflict' });

        expect(accountKvWrites).toHaveLength(1);
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

    it('rejects a same-id local definition that differs from the admitted contract before transport', async () => {
        const { client, transport } = await loadClient();
        const collection = client.collection(forgedCollectionDefinition);

        await expect(collection.put({
            id: 'task-1',
            title: 'Forged local contract',
            status: 'open',
        }, { expectedRevision: 'absent' })).rejects.toMatchObject({
            code: 'plugin_collection_undeclared',
        });
        expect(transport).not.toHaveBeenCalled();
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
        const { client, transport } = await loadClient();

        await expect(client.collection(forgedCollectionDefinition).limits()).rejects.toMatchObject({
            code: 'plugin_collection_undeclared',
        });
        expect(transport).not.toHaveBeenCalled();
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
