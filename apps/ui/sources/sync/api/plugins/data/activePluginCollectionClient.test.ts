import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    normalizePluginAccountCollectionContractV1,
    openPluginCollectionPrivatePayloadV1,
    sealPluginCollectionPrivatePayloadV1,
} from '@happier-dev/protocol';

const contract = normalizePluginAccountCollectionContractV1({
    pluginId: 'example.channels',
    contribution: {
        id: 'channel-state',
        schemaVersion: 1,
        rowIdField: 'id',
        identityFields: [],
        schema: {
            type: 'object',
            properties: {
                id: { type: 'string', maxLength: 256 },
                status: { type: 'string', enum: ['enabled', 'disabled'] },
                title: { type: 'string', maxLength: 256 },
                pendingMachineReconciliation: { type: 'boolean' },
                privateNote: { type: 'string', maxLength: 256 },
            },
            required: ['id', 'status', 'title'],
            additionalProperties: false,
        },
        serverReadable: ['status', 'title'],
        indexes: [{
            id: 'by-status',
            fields: [
                { field: 'status', direction: 'asc' },
                { field: 'id', direction: 'asc' },
            ],
        }],
        uiQueries: [],
        relations: [],
        migrations: [],
    },
});

const plainCurrentness = {
    mode: 'plain' as const,
    version: 7,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 11,
};

const e2eeSecret = new Uint8Array(32).fill(7);
const e2eeCredentials = {
    token: 'account-token',
    secret: Buffer.from(e2eeSecret).toString('base64url'),
};
const e2eeMaterial = { type: 'legacy' as const, secret: e2eeSecret };
const e2eeCurrentness = {
    mode: 'e2ee' as const,
    version: 8,
    signingKeyFingerprint: 'signing-key-8',
    contentKeyFingerprint:
        convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({
                accountEncryptionMode: 'e2ee',
                material: e2eeMaterial,
            }).contentPublicKeyFingerprint,
        ),
    updatedAt: 12,
};

type ClientHarnessOptions = Readonly<{
    currentness?: typeof plainCurrentness | typeof e2eeCurrentness;
    credentials?: typeof e2eeCredentials;
    responseForDataPath?: (path: string, init: RequestInit) => Response;
    retireDuringDataRequest?: boolean;
    advanceServerGenerationDuringDataRequest?: boolean;
    serverProtocolVersion?: number | null;
}>;

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

async function loadClient(options: ClientHarnessOptions = {}) {
    vi.resetModules();
    let current = true;
    let generation = 1;
    const retireCallbacks = new Set<() => void>();
    const lifetime = {
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => current,
        onRetire: (callback: () => void) => {
            retireCallbacks.add(callback);
            return { dispose: () => { retireCallbacks.delete(callback); } };
        },
    };
    const transport = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(
        async (path, init = {}) => {
            if (path === '/v1/account/encryption/currentness') {
                return new Response(JSON.stringify(options.currentness ?? plainCurrentness), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (options.retireDuringDataRequest) {
                current = false;
                for (const callback of [...retireCallbacks]) callback();
            }
            if (options.advanceServerGenerationDuringDataRequest) generation += 1;
            return options.responseForDataPath?.(path, init) ?? new Response(JSON.stringify({
                status: 'updated',
                results: [{ rowId: 'channel-1', revision: 2, deleted: false }],
                changeCursor: 19,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    );
    const activeRequest = vi.fn();
    const captureAuthority = vi.fn(async () => ({
        scope: lifetime.scope,
        context: {
            token: 'account-token',
            ...(options.credentials ? { credentials: options.credentials } : {}),
        },
        request: transport,
    }));

    vi.doMock('@/sync/domains/scope/activeServerAccountScope', () => ({
        captureActiveServerAccountScopeLifetime: () => lifetime,
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'server-a',
            serverUrl: 'https://server.example',
            generation,
        }),
    }));
    vi.doMock('@/sync/api/session/apiSocket', () => ({ apiSocket: { request: activeRequest } }));
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope', () => ({
        captureSessionRequestAuthorityForServerAccountScope: captureAuthority,
    }));

    const client = await import('./activePluginCollectionClient');
    const { publishActivePluginCollectionChanges } = await import(
        './queryPluginCollectionUiQuery'
    );
    if (options.serverProtocolVersion !== null) {
        const { recordAccountStoredContentServerRequirements } = await import(
            '@/sync/http/accountStoredContentCompatibility'
        );
        recordAccountStoredContentServerRequirements({
            serverUrl: 'https://server.example',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: options.serverProtocolVersion ?? 3,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });
    }

    return {
        ...client,
        publishActivePluginCollectionChanges,
        activeRequest,
        captureAuthority,
        transport,
        retireScope: () => {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        },
        advanceGeneration: () => { generation += 1; },
    };
}

async function loadCrossAccountLifetimeHarness() {
    vi.resetModules();
    let activeAccount: 'a' | 'b' = 'a';
    let accountACurrent = true;
    const accountALifetime = {
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => accountACurrent,
        onRetire: (_callback: () => void) => ({ dispose() {} }),
    };
    const accountBLifetime = {
        scope: { serverId: 'server-a', accountId: 'account-b' },
        isCurrent: () => true,
        onRetire: (_callback: () => void) => ({ dispose() {} }),
    };
    const accountATransport = vi.fn(async (path: string) => {
        if (path === '/v1/account/encryption/currentness') {
            return new Response(JSON.stringify(plainCurrentness), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (path === '/v1/plugins/data/contract') {
            return new Response(JSON.stringify({ contract }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        throw new Error(`Unexpected Account A Data path: ${path}`);
    });
    const accountBTransport = vi.fn(async (path: string) => {
        if (path === '/v1/account/encryption/currentness') {
            return new Response(JSON.stringify(plainCurrentness), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (path === '/v1/plugins/data/mutate') {
            return new Response(JSON.stringify({
                status: 'updated',
                results: [{ rowId: 'channel-1', revision: 2, deleted: false }],
                changeCursor: 19,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        throw new Error(`Unexpected Account B Data path: ${path}`);
    });

    vi.doMock('@/sync/domains/scope/activeServerAccountScope', () => ({
        captureActiveServerAccountScopeLifetime: () => activeAccount === 'a'
            ? accountALifetime
            : accountBLifetime,
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
        captureSessionRequestAuthorityForServerAccountScope: async (input: Readonly<{
            scope: { accountId: string };
        }>) => ({
            scope: input.scope,
            context: { token: `${input.scope.accountId}-token` },
            request: input.scope.accountId === 'account-a'
                ? accountATransport
                : accountBTransport,
        }),
    }));

    const client = await import('./activePluginCollectionClient');
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
        ...client,
        accountALifetime,
        accountATransport,
        accountBTransport,
        switchToAccountB: () => {
            accountACurrent = false;
            activeAccount = 'b';
        },
    };
}

describe('active Account Collection direct client', () => {
    it('keeps a resolved Account A client bound to Account A when global capture switches before its nested mutation', async () => {
        const harness = await loadCrossAccountLifetimeHarness();
        const resolved = await Reflect.apply(
            harness.createActivePluginCollectionClientForContractRef,
            undefined,
            [{
                ref: {
                    pluginId: contract.pluginId,
                    collectionId: contract.collectionId,
                    schemaVersion: contract.schemaVersion,
                    contractDigest: contract.contractDigest,
                },
                // The facade already captured this lifetime; this RED proves
                // nested canonical operations must retain it instead of
                // recapturing whichever Account becomes globally active.
                accountLifetime: harness.accountALifetime,
            }],
        );
        expect(resolved).toMatchObject({ status: 'ready' });
        if (typeof resolved !== 'object' || resolved === null) {
            throw new Error('Expected an Account A collection client.');
        }
        const activeClient = Reflect.get(resolved, 'client');
        if (typeof activeClient !== 'object' || activeClient === null) {
            throw new Error('Expected the resolved Account A client.');
        }
        const mutate = Reflect.get(activeClient, 'mutate');
        if (typeof mutate !== 'function') {
            throw new Error('Expected the resolved Account A mutation operation.');
        }

        harness.switchToAccountB();
        await expect(Reflect.apply(mutate, activeClient, [[{
            kind: 'put',
            expectedRevision: 'absent',
            value: {
                id: 'channel-1',
                status: 'enabled',
                title: 'Must not write Account B',
            },
        }]])).resolves.toEqual({
            status: 'unavailable',
            reason: 'account-scope-changed',
        });
        expect(harness.accountATransport).not.toHaveBeenCalledWith('/v1/plugins/data/mutate', expect.anything());
        expect(harness.accountBTransport).not.toHaveBeenCalledWith('/v1/plugins/data/mutate', expect.anything());
    });

    it('resolves an exact release-admitted contract through scoped Account authority before CAS', async () => {
        const harness = await loadClient({
            responseForDataPath: (path) => path === '/v1/plugins/data/contract'
                ? new Response(JSON.stringify({ contract }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(JSON.stringify({
                    status: 'updated',
                    results: [{ rowId: 'channel-1', revision: 2, deleted: false }],
                    changeCursor: 19,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });
        const resolved = await harness.createActivePluginCollectionClientForContractRef({
            ref: {
                pluginId: contract.pluginId,
                collectionId: contract.collectionId,
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            },
        });

        expect(resolved).toMatchObject({
            status: 'ready',
            contract: {
                pluginId: contract.pluginId,
                collectionId: contract.collectionId,
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            },
            client: expect.objectContaining({ mutate: expect.any(Function) }),
        });
        if (resolved.status !== 'ready') throw new Error('Expected an admitted collection client.');

        await expect(resolved.client.mutate([{
            kind: 'put',
            expectedRevision: 1,
            value: {
                id: 'channel-1',
                status: 'enabled',
                title: 'Offline CAS',
                privateNote: 'host-stamped contract only',
            },
        }])).resolves.toMatchObject({
            status: 'updated',
            results: [{ rowId: 'channel-1', revision: 2, deleted: false }],
        });

        const contractCall = harness.transport.mock.calls.find(([path]) => path === '/v1/plugins/data/contract');
        expect(contractCall).toBeDefined();
        expect(JSON.parse(String(contractCall?.[1]?.body))).toEqual({
            ref: {
                pluginId: contract.pluginId,
                collectionId: contract.collectionId,
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            },
        });
        const mutationCall = harness.transport.mock.calls.find(([path]) => path === '/v1/plugins/data/mutate');
        expect(mutationCall).toBeDefined();
        expect(JSON.parse(String(mutationCall?.[1]?.body))).toMatchObject({
            writerContext: {
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            },
        });
    });

    it('rejects a persisted scalar-root contract before creating a direct row client', async () => {
        const invalidContract = {
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            schemaVersion: contract.schemaVersion,
            contractDigest: contract.contractDigest,
            rowIdField: contract.rowIdField,
            schema: { type: 'string' },
            serverReadable: contract.serverReadable,
            indexes: contract.indexes,
            uiQueries: contract.uiQueries,
            relations: contract.relations,
            readableSchemaVersions: contract.readableSchemaVersions,
        };
        const harness = await loadClient({
            responseForDataPath: (path) => path === '/v1/plugins/data/contract'
                ? new Response(JSON.stringify({ contract: invalidContract }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(JSON.stringify({
                    status: 'updated',
                    results: [{ rowId: 'channel-1', revision: 2, deleted: false }],
                    changeCursor: 19,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });

        await expect(harness.createActivePluginCollectionClientForContractRef({
            ref: {
                pluginId: contract.pluginId,
                collectionId: contract.collectionId,
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            },
        })).resolves.toEqual({ status: 'unavailable', reason: 'response-invalid' });
    });

    it('queries and CAS-mutates one admitted collection through the scoped Account authority', async () => {
        const queryRow = {
            rowId: 'channel-1',
            revision: 1,
            content: { t: 'plain' as const, v: { pendingMachineReconciliation: true, privateNote: 'offline' } },
            projection: { status: 'enabled', title: 'Ops channel' },
        };
        const harness = await loadClient({
            responseForDataPath: (path) => path === '/v1/plugins/data/query'
                ? new Response(JSON.stringify({ rows: [queryRow], nextCursor: 'opaque-next', changeCursor: 18 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(JSON.stringify({
                    status: 'updated',
                    results: [{ rowId: 'channel-1', revision: 2, deleted: false }],
                    changeCursor: 19,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.query({
            indexId: 'by-status',
            prefix: ['enabled'],
            order: 'asc',
            limit: 20,
        })).resolves.toEqual({
            status: 'ready',
            rows: [{
                rowId: 'channel-1',
                revision: 1,
                value: {
                    id: 'channel-1',
                    status: 'enabled',
                    title: 'Ops channel',
                    pendingMachineReconciliation: true,
                    privateNote: 'offline',
                },
            }],
            nextCursor: 'opaque-next',
            changeCursor: 18,
        });

        await expect(collection.mutate([{
            kind: 'put',
            expectedRevision: 1,
            value: {
                id: 'channel-1',
                status: 'disabled',
                title: 'Ops channel',
                pendingMachineReconciliation: true,
                privateNote: 'saved while daemon was offline',
            },
        }])).resolves.toEqual({
            status: 'updated',
            results: [{ rowId: 'channel-1', revision: 2, deleted: false }],
            changeCursor: 19,
        });

        expect(harness.activeRequest).not.toHaveBeenCalled();
        expect(harness.captureAuthority).toHaveBeenCalledWith({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            activeRequest: expect.any(Function),
        });
        const queryCall = harness.transport.mock.calls.find(([path]) => path === '/v1/plugins/data/query');
        expect(queryCall).toBeDefined();
        expect(JSON.parse(String(queryCall?.[1]?.body))).toEqual({
            pluginId: 'example.channels',
            collectionId: 'channel-state',
            indexId: 'by-status',
            prefix: ['enabled'],
            order: 'asc',
            limit: 20,
        });
        const mutationCall = harness.transport.mock.calls.find(([path]) => path === '/v1/plugins/data/mutate');
        expect(mutationCall).toBeDefined();
        const mutation = JSON.parse(String(mutationCall?.[1]?.body));
        expect(mutation).toMatchObject({
            pluginId: 'example.channels',
            collectionId: 'channel-state',
            writerContext: {
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            },
            operations: [{
                kind: 'put',
                rowId: 'channel-1',
                expectedRevision: 1,
                projection: { status: 'disabled', title: 'Ops channel' },
                content: {
                    t: 'plain',
                    v: {
                        pendingMachineReconciliation: true,
                        privateNote: 'saved while daemon was offline',
                    },
                },
            }],
        });
        expect(new Headers(mutationCall?.[1]?.headers).get(
            ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
        )).toBe(String(ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION));
    });

    it('serializes a live-row batch assertion without giving the UI adapter a write path', async () => {
        const harness = await loadClient({
            responseForDataPath: () => new Response(JSON.stringify({
                status: 'updated',
                results: [{ rowId: 'channel-written', revision: 1, deleted: false }],
                changeCursor: 20,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.mutate([
            { kind: 'assert', rowId: 'channel-current', expectedRevision: 4 },
            {
                kind: 'put',
                expectedRevision: 'absent',
                value: {
                    id: 'channel-written',
                    status: 'enabled',
                    title: 'Writes only this row',
                    privateNote: 'leave assertion row unchanged',
                },
            },
        ])).resolves.toEqual({
            status: 'updated',
            results: [{ rowId: 'channel-written', revision: 1, deleted: false }],
            changeCursor: 20,
        });

        const mutationCall = harness.transport.mock.calls.find(([path]) => path === '/v1/plugins/data/mutate');
        expect(mutationCall).toBeDefined();
        const mutation = JSON.parse(String(mutationCall?.[1]?.body));
        expect(mutation.operations).toEqual([
            { kind: 'assert', rowId: 'channel-current', expectedRevision: 4 },
            {
                kind: 'put',
                rowId: 'channel-written',
                expectedRevision: 'absent',
                projection: { status: 'enabled', title: 'Writes only this row' },
                content: { t: 'plain', v: { privateNote: 'leave assertion row unchanged' } },
            },
        ]);
    });

    it('opens and seals only the current Account E2EE collection envelope', async () => {
        const encryptedRow = {
            rowId: 'channel-1',
            revision: 4,
            content: {
                t: 'encrypted' as const,
                c: sealPluginCollectionPrivatePayloadV1({
                    material: e2eeMaterial,
                    payload: { pendingMachineReconciliation: true, privateNote: 'encrypted' },
                    randomBytes: (length) => new Uint8Array(length).fill(3),
                }),
            },
            projection: { status: 'enabled', title: 'Ops channel' },
        };
        const harness = await loadClient({
            currentness: e2eeCurrentness,
            credentials: e2eeCredentials,
            responseForDataPath: (path) => path === '/v1/plugins/data/get'
                ? new Response(JSON.stringify({ row: encryptedRow }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(JSON.stringify({
                    status: 'updated',
                    results: [{ rowId: 'channel-1', revision: 5, deleted: false }],
                    changeCursor: 23,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.get('channel-1')).resolves.toEqual({
            status: 'ready',
            row: {
                rowId: 'channel-1',
                revision: 4,
                value: {
                    id: 'channel-1',
                    status: 'enabled',
                    title: 'Ops channel',
                    pendingMachineReconciliation: true,
                    privateNote: 'encrypted',
                },
            },
        });
        await expect(collection.mutate([{
            kind: 'put',
            expectedRevision: 4,
            value: {
                id: 'channel-1',
                status: 'disabled',
                title: 'Ops channel',
                privateNote: 'new encrypted private data',
            },
        }])).resolves.toMatchObject({ status: 'updated' });

        const mutationCall = harness.transport.mock.calls.find(([path]) => path === '/v1/plugins/data/mutate');
        const mutation = JSON.parse(String(mutationCall?.[1]?.body));
        expect(mutation.operations[0].content.t).toBe('encrypted');
        expect(openPluginCollectionPrivatePayloadV1({
            material: e2eeMaterial,
            ciphertext: mutation.operations[0].content.c,
        })).toEqual({ privateNote: 'new encrypted private data' });
        expect(mutation.operations[0].projection).toEqual({ status: 'disabled', title: 'Ops channel' });
    });

    it('refuses E2EE collection access when scoped credentials do not match current Account material', async () => {
        const otherMaterial = { type: 'legacy' as const, secret: new Uint8Array(32).fill(8) };
        const harness = await loadClient({
            currentness: {
                ...e2eeCurrentness,
                contentKeyFingerprint:
                    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                        createAccountScopedCryptoMaterialSnapshotV1({
                            accountEncryptionMode: 'e2ee',
                            material: otherMaterial,
                        }).contentPublicKeyFingerprint,
                    ),
            },
            credentials: e2eeCredentials,
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.get('channel-1')).resolves.toEqual({
            status: 'unavailable',
            reason: 'account-encryption-material-unavailable',
        });
        expect(harness.transport.mock.calls.map(([path]) => path)).toEqual([
            '/v1/account/encryption/currentness',
        ]);
    });

    it('returns the server conflict without retrying a rejected CAS', async () => {
        const harness = await loadClient({
            responseForDataPath: () => new Response(JSON.stringify({
                status: 'conflict',
                conflicts: [{ rowId: 'channel-1', revision: 5, deleted: false }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.mutate([{
            kind: 'delete',
            rowId: 'channel-1',
            expectedRevision: 4,
        }])).resolves.toEqual({
            status: 'conflict',
            conflicts: [{ rowId: 'channel-1', revision: 5, deleted: false }],
        });
        expect(harness.transport.mock.calls.filter(([path]) => path === '/v1/plugins/data/mutate')).toHaveLength(1);
    });

    it('returns a bounded ordinary-query continuation for a restricted relation delete', async () => {
        const harness = await loadClient({
            responseForDataPath: () => new Response(JSON.stringify({
                error: 'collection_relation_restricted',
                dependentCount: 1,
                continuation: {
                    pluginId: 'example.projects-tasks',
                    collectionId: 'tasks',
                    relationId: 'project',
                    target: { collectionId: 'projects', rowId: 'project-1' },
                    query: {
                        indexId: 'by-project',
                        prefix: ['project-1'],
                        order: 'asc',
                        limit: 200,
                    },
                },
            }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.mutate([{
            kind: 'delete',
            rowId: 'channel-1',
            expectedRevision: 4,
        }])).resolves.toEqual({
            status: 'rejected',
            code: 'collection_relation_restricted',
            relationRestriction: {
                dependentCount: 1,
                continuation: {
                    pluginId: 'example.projects-tasks',
                    collectionId: 'tasks',
                    relationId: 'project',
                    target: { collectionId: 'projects', rowId: 'project-1' },
                    query: {
                        indexId: 'by-project',
                        prefix: ['project-1'],
                        order: 'asc',
                        limit: 200,
                    },
                },
            },
        });
    });

    it('does not let a consumer select an undeclared collection index', async () => {
        const harness = await loadClient();
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.query({
            indexId: 'unadmitted-index',
            order: 'asc',
        })).resolves.toEqual({
            status: 'rejected',
            code: 'collection_query_invalid',
        });
        expect(harness.transport).not.toHaveBeenCalled();
    });

    it('fails closed when the current server no longer admits the bound writer contract', async () => {
        const harness = await loadClient({
            responseForDataPath: () => new Response(JSON.stringify({
                error: 'collection_writer_contract_unavailable',
            }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.mutate([{
            kind: 'delete',
            rowId: 'channel-1',
            expectedRevision: 4,
        }])).resolves.toEqual({
            status: 'unavailable',
            reason: 'writer-contract-unavailable',
        });
    });

    it('does not materialize a response that completed after Account scope retirement', async () => {
        const harness = await loadClient({
            retireDuringDataRequest: true,
            responseForDataPath: () => new Response(JSON.stringify({
                row: {
                    rowId: 'channel-1',
                    revision: 1,
                    content: { t: 'plain', v: {} },
                    projection: { status: 'enabled', title: 'Ops channel' },
                },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.get('channel-1')).resolves.toEqual({
            status: 'unavailable',
            reason: 'account-scope-changed',
        });
    });

    it('does not materialize a response after the active server generation advances', async () => {
        const harness = await loadClient({
            advanceServerGenerationDuringDataRequest: true,
            responseForDataPath: () => new Response(JSON.stringify({ row: null }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.get('channel-1')).resolves.toEqual({
            status: 'unavailable',
            reason: 'server-generation-changed',
        });
    });

    it('shares the AccountChange wakeup, retires it with Account scope, and fails closed before V2 requests', async () => {
        const harness = await loadClient({ serverProtocolVersion: 2 });
        const collection = harness.createActivePluginCollectionClient({ contract });
        const invalidated = vi.fn();
        const watch = collection.watch(invalidated);
        expect(watch.status).toBe('watching');
        if (watch.status !== 'watching') throw new Error('Expected active collection watch');

        await expect(collection.get('channel-1')).resolves.toEqual({
            status: 'unavailable',
            reason: 'server-protocol-too-old',
        });
        expect(harness.transport).not.toHaveBeenCalled();

        harness.publishActivePluginCollectionChanges([{
            cursor: 18,
            kind: 'pluginDomain',
            entityId: 'pluginDomain/example.channels/data-collection/channel-state',
            changedAt: 18,
            hint: {
                pluginDomain: 'dataCollection',
                pluginId: 'example.channels',
                collectionId: 'channel-state',
                contractDigest: contract.contractDigest,
                revision: 4,
                rowIds: ['channel-1'],
            },
        }]);
        expect(invalidated).toHaveBeenCalledTimes(1);
        harness.retireScope();
        harness.publishActivePluginCollectionChanges([{
            cursor: 19,
            kind: 'pluginDomain',
            entityId: 'pluginDomain/example.channels/data-collection/channel-state',
            changedAt: 19,
            hint: {
                pluginDomain: 'dataCollection',
                pluginId: 'example.channels',
                collectionId: 'channel-state',
                contractDigest: contract.contractDigest,
                revision: 5,
                full: true,
            },
        }]);
        expect(invalidated).toHaveBeenCalledTimes(1);
        watch.dispose();
    });
});
