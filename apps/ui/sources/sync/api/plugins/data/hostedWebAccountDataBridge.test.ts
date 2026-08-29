import { afterEach, describe, expect, it, vi } from 'vitest';
import { derivePluginCollectionIdentityTagV1, normalizePluginAccountCollectionContractV1, PluginManifestV2Schema } from '@happier-dev/protocol';
import { defineAccountCollection } from '@happier-dev/plugin-sdk/collections';
import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';

import {
    createPluginAccountAvailabilityReader,
    type PluginAccountAvailabilitySnapshot,
} from '@/sync/domains/plugins/availability/reader';

const pluginId = 'example.tasks';
const collectionDefinition = defineAccountCollection({
    id: 'tasks',
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 256 },
            title: { type: 'string', maxLength: 256 },
            status: { type: 'string', enum: ['open', 'closed'] },
        },
        required: ['id', 'title', 'status'],
        additionalProperties: false,
    },
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
});

const contract = normalizePluginAccountCollectionContractV1({
    pluginId,
    contribution: {
        ...collectionDefinition,
        migrations: [],
    },
});
const ref = {
    pluginId: contract.pluginId,
    collectionId: contract.collectionId,
    schemaVersion: contract.schemaVersion,
    contractDigest: contract.contractDigest,
};

const normalizedManifest = PluginManifestV2Schema.parse({
    schemaVersion: 2,
    id: pluginId,
    version: '1.0.0',
    displayName: 'Tasks',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: {},
});

const firstPage = {
    rows: [{
        context: {
            collection: { pluginId, collectionId: 'tasks' },
            rowId: 'task-1',
            revision: 3,
        },
        fields: { status: 'open', title: 'Ship the hosted adapter' },
    }],
    nextCursor: 'host-private-page-2',
    changeCursor: 42,
};
const secondPage = {
    rows: [{
        context: {
            collection: { pluginId, collectionId: 'tasks' },
            rowId: 'task-2',
            revision: 4,
        },
        fields: { status: 'open', title: 'Verify the bridge contract' },
    }],
    changeCursor: 43,
};

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

function createAvailabilityReader() {
    return createPluginAccountAvailabilityReader({
        scope: { serverId: 'server-a', accountId: 'account-a' },
        snapshot: {
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
        } satisfies PluginAccountAvailabilitySnapshot,
    });
}

async function loadBridge() {
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
    const queryResponses = [firstPage, secondPage, firstPage];
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
        if (path === '/v1/plugins/data/ui-query') {
            return new Response(JSON.stringify(queryResponses.shift() ?? secondPage), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (path === `/v1/account/plugin-storage/${pluginId}`) {
            if ((_init?.method ?? 'GET') === 'GET') {
                return new Response(JSON.stringify({ status: 'absent' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            accountKvWrites.push(JSON.parse(String(_init?.body ?? 'null')));
            return new Response(JSON.stringify({ status: 'updated', revision: 3 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
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
    const { publishActivePluginCollectionUiQueryChanges } = await import(
        './queryPluginCollectionUiQuery'
    );
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
    const module: unknown = await import('./hostedWebAccountDataBridge');
    const create = Reflect.get(module as object, 'createHostedWebAccountDataBridge');
    expect(create).toEqual(expect.any(Function));
    const changes: unknown[] = [];
    const bridge = (create as (input: Readonly<{
        dataClient: ReturnType<typeof createPluginUiDataClient>;
        publish(change: unknown): void;
    }>) => Readonly<{
        handle(operation: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown>;
        dispose(): void;
    }>)(
        {
            dataClient: createPluginUiDataClient({
                pluginId,
                accountLifetime: lifetime,
                availabilityReader: createAvailabilityReader(),
            }),
            publish: (change) => { changes.push(change); },
        },
    );
    return {
        bridge,
        changes,
        transport,
        accountKvWrites,
        retire: () => {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        },
        invalidate: () => {
            publishActivePluginCollectionUiQueryChanges([{
                cursor: 8,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.tasks/data-collection/tasks',
                changedAt: 12,
                hint: {
                    pluginDomain: 'dataCollection',
                    pluginId,
                    collectionId: 'tasks',
                    contractDigest: contract.contractDigest,
                    revision: 4,
                    full: true,
                },
            }]);
        },
    };
}

describe('hosted-web Account Data bridge adapter', () => {
    it('does not publish a transaction when cancellation wins during begin settlement', async () => {
        const controller = new AbortController();
        let executionSettled = false;
        const accountKv = {
            async transaction<T>(operation: (transaction: Readonly<{
                get(key: string): Promise<null>;
            }>) => Promise<T>): Promise<T> {
                const pending = operation({
                    async get() { return null; },
                });
                controller.abort();
                try {
                    return await pending;
                } finally {
                    executionSettled = true;
                }
            },
        };
        const { createHostedWebAccountDataBridge } = await import('./hostedWebAccountDataBridge');
        const bridge = createHostedWebAccountDataBridge({
            dataClient: { accountKv } as unknown as PluginUiDataClient,
            publish: () => undefined,
        });

        await expect(bridge.handle({
            kind: 'data',
            operation: 'accountKv.transaction.begin',
            arguments: [],
        }, { signal: controller.signal })).resolves.toMatchObject({
            kind: 'error',
            error: { code: 'plugin_account_storage_unavailable' },
        });
        expect(executionSettled).toBe(true);
        await expect(bridge.handle({
            kind: 'data',
            operation: 'accountKv.transaction.get',
            arguments: ['transaction_1', 'cursor'],
        })).resolves.toMatchObject({
            kind: 'error',
            error: { code: 'plugin_account_kv_invalid' },
        });
    });

    it('keeps a hosted Account KV callback atomic in the native row owner', async () => {
        const { bridge, accountKvWrites } = await loadBridge();
        const begun = await bridge.handle({
            kind: 'data',
            operation: 'accountKv.transaction.begin',
            arguments: [],
        });
        expect(begun).toMatchObject({ kind: 'data', value: expect.any(String) });
        const transactionId = (begun as { value: string }).value;

        await expect(bridge.handle({
            kind: 'data',
            operation: 'accountKv.transaction.set',
            arguments: [transactionId, 'cursor', { value: { page: 2 }, expectedVersion: 'absent' }],
        })).resolves.toEqual({ kind: 'data', value: { version: 0 } });
        expect(accountKvWrites).toEqual([]);

        await expect(bridge.handle({
            kind: 'data',
            operation: 'accountKv.transaction.commit',
            arguments: [transactionId],
        })).resolves.toEqual({ kind: 'data', value: null });
        expect(accountKvWrites).toHaveLength(1);

        const second = await bridge.handle({
            kind: 'data',
            operation: 'accountKv.transaction.begin',
            arguments: [],
        });
        const secondTransactionId = (second as { value: string }).value;
        await bridge.handle({
            kind: 'data',
            operation: 'accountKv.transaction.set',
            arguments: [secondTransactionId, 'discarded', { value: true, expectedVersion: 'absent' }],
        });
        await expect(bridge.handle({
            kind: 'data',
            operation: 'accountKv.transaction.rollback',
            arguments: [secondTransactionId],
        })).resolves.toEqual({ kind: 'data', value: null });
        expect(accountKvWrites).toHaveLength(1);
    });

    it('rolls back an open transaction and fails later Data operations closed when retired', async () => {
        const { bridge, accountKvWrites } = await loadBridge();
        const begun = await bridge.handle({
            kind: 'data',
            operation: 'accountKv.transaction.begin',
            arguments: [],
        });
        const transactionId = (begun as { value: string }).value;
        await bridge.handle({
            kind: 'data',
            operation: 'accountKv.transaction.set',
            arguments: [transactionId, 'discarded', { value: true, expectedVersion: 'absent' }],
        });

        bridge.dispose();

        expect(accountKvWrites).toEqual([]);
        await expect(bridge.handle({
            kind: 'data',
            operation: 'accountKv.get',
            arguments: ['discarded'],
        })).resolves.toMatchObject({
            kind: 'error',
            error: { code: 'plugin_account_storage_unavailable' },
        });
    });

    it('delegates generic Collection identity to the mounted current-Account client without guest authority', async () => {
        const { bridge } = await loadBridge();

        await expect(bridge.handle({
            kind: 'data',
            operation: 'collection.identityTag',
            definition: collectionDefinition,
            arguments: [{ field: 'id', components: ['github', 'task', '1'] }],
        })).resolves.toEqual({
            kind: 'data',
            value: derivePluginCollectionIdentityTagV1({
                accountEncryptionMode: 'plain',
                material: null,
                pluginId,
                collectionId: 'tasks',
                field: 'id',
                components: ['github', 'task', '1'],
            }),
        });

        await expect(bridge.handle({
            kind: 'data',
            operation: 'collection.identityTag',
            definition: { ...collectionDefinition, id: 'other' },
            arguments: [{ field: 'id', components: ['github', 'task', '1'] }],
        })).resolves.toMatchObject({
            kind: 'error',
            error: { code: 'plugin_collection_undeclared' },
        });
    });

    it('uses the mounted same-plugin Data client for open/page/content-free-wakeup/close without exposing its cursor', async () => {
        const { bridge, changes, transport, invalidate } = await loadBridge();

        const opened = await bridge.handle({
            kind: 'open',
            collectionId: 'tasks',
            uiQueryId: 'open',
            parameters: { status: 'open' },
        });
        expect(opened).toMatchObject({
            kind: 'snapshot',
            queryId: expect.any(String),
            snapshot: { status: 'ready', rows: firstPage.rows, hasMore: true },
        });
        const queryId = (opened as { queryId: string }).queryId;
        // Query rows belong only to the request response. Direct pager updates
        // caused by this operation must not manufacture a row-bearing event.
        expect(changes).toEqual([]);

        await expect(bridge.handle({ kind: 'page', queryId })).resolves.toMatchObject({
            kind: 'snapshot',
            queryId,
            snapshot: { status: 'ready', rows: secondPage.rows, hasMore: false },
        });
        const calls = transport.mock.calls.filter(([path]) => path === '/v1/plugins/data/ui-query');
        expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({
            pluginId,
            collectionId: 'tasks',
            uiQueryId: 'open',
        });
        expect(JSON.parse(String(calls[1]?.[1]?.body))).toMatchObject({
            cursor: 'host-private-page-2',
        });
        expect(changes).toEqual([]);

        // AccountChange is content-free. The mounted pager re-reads through
        // Data, while the hosted bridge publishes only opaque query wakeup.
        invalidate();
        await vi.waitFor(() => {
            expect(changes).toContainEqual({ kind: 'change', queryId });
        });
        expect(JSON.stringify(changes)).not.toContain('Ship the hosted adapter');
        expect(JSON.stringify(changes)).not.toContain('host-private-page-2');
        expect(JSON.stringify(changes)).not.toContain('account-a');

        await expect(bridge.handle({ kind: 'close', queryId })).resolves.toEqual({
            kind: 'closed',
            queryId,
        });
        const publishedBeforeClose = changes.length;
        await expect(bridge.handle({ kind: 'page', queryId })).resolves.toEqual({
            kind: 'closed',
            queryId,
        });
        expect(changes).toHaveLength(publishedBeforeClose);
    });

    it('fails closed with a typed unavailable snapshot after the shared Account lifetime retires', async () => {
        const { bridge, transport, retire } = await loadBridge();
        retire();

        await expect(bridge.handle({
            kind: 'open',
            collectionId: 'tasks',
            uiQueryId: 'open',
            parameters: { status: 'open' },
        })).resolves.toMatchObject({
            kind: 'snapshot',
            snapshot: { status: 'unavailable', rows: [], hasMore: false },
        });
        expect(transport).not.toHaveBeenCalled();
    });
});
