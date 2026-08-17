import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    normalizePluginAccountCollectionContractV1,
    PluginManifestV2Schema,
} from '@happier-dev/protocol';
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
    schemaVersion: 1,
    schema: defineProtocolObject({
        id: defineProtocolString({ maxLength: 256 }),
        title: defineProtocolString({ maxLength: 256 }),
        status: defineProtocolUnion([
            defineProtocolLiteral('open'),
            defineProtocolLiteral('closed'),
        ]),
    }, { policy: 'closed' }),
    rowIdField: 'id',
    identityFields: [],
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
});

const contract = normalizePluginAccountCollectionContractV1({
    pluginId,
    contribution: {
        ...collectionDefinition,
        schema: collectionDefinition.schema.jsonSchema,
        migrations: [],
    },
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

async function loadClient() {
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
        if (path === '/v1/plugins/data/mutate') {
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
        retire: () => {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        },
    };
}

describe('Plugin UI Data client', () => {
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
});
