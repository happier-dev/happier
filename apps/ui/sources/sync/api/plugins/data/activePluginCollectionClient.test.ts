import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
    PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
    FeaturesResponseSchema,
    compilePluginJsonSchema,
    encodePluginCollectionLogicalValueV1,
    isValidPluginJsonSchemaValue,
    type NormalizedPluginAccountCollectionContractV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    measurePluginCollectionMutationRequestEncodedBytesV1,
    normalizePluginAccountCollectionContractV1,
    openPluginCollectionPrivatePayloadV1,
    PluginCollectionMutationRequestV1Schema,
    PluginAccountCollectionContributionV1Schema,
    sealPluginCollectionPrivatePayloadV1,
} from '@happier-dev/protocol';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit';
import { ConversationBindingV1Schema } from '@happier-dev/channels-protocol/v1';
import { createPluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';

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

const quotaContract = normalizePluginAccountCollectionContractV1({
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
        quota: { maxRows: 250, maxRowEncodedBytes: 32 * 1024 },
    },
});

const plainCurrentness = createPlainAccountEncryptionCurrentnessFixture({
    version: 7,
    updatedAt: 11,
});

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
    recipientEnvelopeReadiness: { status: 'available' as const },
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
            if (!options.responseForDataPath && path === '/v1/plugins/data/get') {
                return new Response(JSON.stringify({ row: null, absenceEpoch: 0 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
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
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
        captureServerRequestAuthorityForServerAccountScope: captureAuthority,
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
        accountLifetime: lifetime,
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

async function sessionLinksContractFixture() {
    const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-channels/manifest');
    const contribution = PLUGIN_MANIFEST.contributes?.accountCollections?.find((entry) => entry.id === 'channel-state');
    if (!contribution) throw new Error('Missing canonical Channels collection');
    const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels',
        contribution: PluginAccountCollectionContributionV1Schema.parse(contribution) });
    const ref = { pluginId: contract.pluginId, collectionId: contract.collectionId,
        schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
    const readAvailability = () => createPluginAccountAvailabilityReader({
        scope: { serverId: 'server-a', accountId: 'account-a' },
        snapshot: { availabilityCursor: 7, materializations: [], snapshots: [], intentReads: [{
            pluginId: contract.pluginId, response: { availabilityCursor: 7, packageAssets: [],
                hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                intent: { pluginId: contract.pluginId, desiredVersion: null, enabled: true, offlineUiHosting: 'enabled',
                    writableCollections: [ref], revision: 'intent-7' },
                release: null, uiArtifacts: [],
            },
        }] },
    });
    const validate = compilePluginJsonSchema(contract.schema);
    return { contract, readAvailability, row: (id: string, sessionId: string, number: number, encrypted: boolean) =>
        sessionLinkRow(contract, validate, id, sessionId, number, encrypted) };
}

function sessionLinkRow(contract: NormalizedPluginAccountCollectionContractV1,
    validate: ReturnType<typeof compilePluginJsonSchema>, id: string, sessionId: string, number: number, encrypted: boolean) {
    const binding = ConversationBindingV1Schema.parse({
        v: 1, id, connectionId: 'connection-1', createdAt: number, updatedAt: number,
        endpoint: { kind: 'githubPullRequest', audience: 'shared', id: `pr-${number}` },
        target: { kind: 'session', sessionId, pullRequestLink: { repository: 'acme/widgets', number },
            policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
        allowedPrincipalIds: ['principal-1'], allowBotSenders: false, inputMode: 'directMentionsOnly', inboundDebounceMs: 0,
        linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: false, deletionState: 'none',
    });
    const { v, id: rowId, connectionId, createdAt, updatedAt, ...payload } = binding;
    const encoded = encodePluginCollectionLogicalValueV1({ contract,
        isValidLogicalValue: (value) => isValidPluginJsonSchemaValue(validate, value),
        value: { id: rowId, 'record-kind': 'binding', v, 'connection-id': connectionId, 'binding-id': rowId,
            'created-at': createdAt, 'updated-at': updatedAt, payload },
        encryptionMode: encrypted ? 'e2ee' : 'plain', material: encrypted ? e2eeMaterial : null,
        randomBytes: (length) => new Uint8Array(length).fill(9),
    });
    if (encoded.status !== 'encoded') throw new Error(`Invalid canonical binding fixture: ${encoded.reason}`);
    return { rowId: encoded.rowId, revision: 1, projection: encoded.projection, content: encoded.content };
}

describe('Account session pull-request link reader', () => {
    it.each(['plain', 'e2ee'] as const)('reads qualified %s links through the real collection decoder across opaque pages', async (mode) => {
        const fixture = await sessionLinksContractFixture();
        const requests: Record<string, unknown>[] = [];
        const harness = await loadClient({
            ...(mode === 'e2ee' ? { currentness: e2eeCurrentness, credentials: e2eeCredentials } : {}),
            responseForDataPath: (path, init) => {
                if (path === '/v1/plugins/data/contract') return Response.json({ access: 'readOnly', contract: fixture.contract });
                const request = JSON.parse(String(init.body)) as Record<string, unknown>;
                requests.push(request);
                return request.cursor === 'opaque-next'
                    ? Response.json({ rows: [fixture.row('binding-1', 'session-1', 1, mode === 'e2ee')], changeCursor: 18 })
                    : Response.json({ rows: [fixture.row('binding-2', 'session-2', 2, mode === 'e2ee')], nextCursor: 'opaque-next', changeCursor: 18 });
            },
        });
        const { readActiveSessionPullRequestLinks } = await import('./sessionPullRequestLinks');
        await expect(readActiveSessionPullRequestLinks({ accountLifetime: harness.accountLifetime,
            readAvailability: fixture.readAvailability })).resolves.toEqual({ status: 'ready', scope: harness.accountLifetime.scope,
            sessions: [
                { sessionId: 'session-1', pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 1 }] },
                { sessionId: 'session-2', pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 2 }] },
            ],
        });
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({ indexId: 'by-kind', prefix: ['binding'], order: 'asc' });
        expect(requests[1]).toMatchObject({ cursor: 'opaque-next' });
        expect(harness.activeRequest).not.toHaveBeenCalled();
    });

    it('does not disclose links when E2EE material is absent or the captured Account retires', async () => {
        const fixture = await sessionLinksContractFixture();
        const harness = await loadClient({ currentness: e2eeCurrentness });
        const { readActiveSessionPullRequestLinks } = await import('./sessionPullRequestLinks');
        const input = { accountLifetime: harness.accountLifetime, readAvailability: fixture.readAvailability };
        await expect(readActiveSessionPullRequestLinks(input)).resolves.toEqual({ status: 'unavailable', reason: 'account-encryption-material-unavailable' });
        expect(harness.transport.mock.calls.map(([path]) => path)).not.toContain('/v1/plugins/data/query');
        harness.retireScope();
        await expect(readActiveSessionPullRequestLinks(input)).resolves.toEqual({ status: 'unavailable', reason: 'account-scope-changed' });
    });

    it('discards decoded pages when the Account retires during continuation', async () => {
        const fixture = await sessionLinksContractFixture();
        let retire: (() => void) | undefined;
        const harness = await loadClient({ responseForDataPath: (path, init) => {
            if (path === '/v1/plugins/data/contract') return Response.json({ access: 'readOnly', contract: fixture.contract });
            const request = JSON.parse(String(init.body)) as Record<string, unknown>;
            if (request.cursor === 'opaque-next') {
                retire?.();
                return Response.json({ rows: [], changeCursor: 18 });
            }
            return Response.json({ rows: [fixture.row('binding-1', 'session-1', 1, false)], nextCursor: 'opaque-next', changeCursor: 18 });
        } });
        retire = harness.retireScope;
        const { readActiveSessionPullRequestLinks } = await import('./sessionPullRequestLinks');
        await expect(readActiveSessionPullRequestLinks({ accountLifetime: harness.accountLifetime,
            readAvailability: fixture.readAvailability })).resolves.toEqual({ status: 'unavailable', reason: 'account-scope-changed' });
    });
});

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
            return new Response(JSON.stringify({ access: 'writable', contract }), {
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
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
        captureServerRequestAuthorityForServerAccountScope: async (input: Readonly<{
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
                ? new Response(JSON.stringify({ access: 'writable', contract }), {
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

    it('keeps a compatible retained contract read-only', async () => {
        const oldContract = { ...contract, schemaVersion: 1, contractDigest: 'B'.repeat(43) };
        const harness = await loadClient({
            responseForDataPath: (path) => path === '/v1/plugins/data/contract'
                ? new Response(JSON.stringify({ access: 'readOnly', contract: oldContract }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(JSON.stringify({ rows: [], changeCursor: 9 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
        });
        const resolved = await harness.createActivePluginCollectionClientForContractRef({
            ref: {
                pluginId: oldContract.pluginId,
                collectionId: oldContract.collectionId,
                schemaVersion: oldContract.schemaVersion,
                contractDigest: oldContract.contractDigest,
            },
        });
        expect(resolved).toMatchObject({ status: 'ready', access: 'readOnly' });
        if (resolved.status !== 'ready') throw new Error('Expected a read-only collection client.');

        await expect(resolved.client.query({ indexId: 'by-status', order: 'asc' }))
            .resolves.toMatchObject({ status: 'ready', rows: [] });
        await expect(resolved.client.mutate([{
            kind: 'put',
            expectedRevision: 'absent',
            value: { id: 'channel-old', status: 'enabled', title: 'No write' },
        }])).resolves.toEqual({ status: 'unavailable', reason: 'writer-contract-unavailable' });
        expect(harness.transport).not.toHaveBeenCalledWith('/v1/plugins/data/mutate', expect.anything());
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
                ? new Response(JSON.stringify({ access: 'writable', contract: invalidContract }), {
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
            readerContext: {
                pluginId: contract.pluginId,
                collectionId: contract.collectionId,
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            },
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
            responseForDataPath: (path) => path === '/v1/plugins/data/get'
                ? new Response(JSON.stringify({ row: null, absenceEpoch: 0 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(JSON.stringify({
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
                expectedAbsenceEpoch: 0,
                projection: { status: 'enabled', title: 'Writes only this row' },
                content: { t: 'plain', v: { privateNote: 'leave assertion row unchanged' } },
            },
        ]);
    });

    it('settles an exact forget conflict in one request instead of re-reading a hidden tombstone', async () => {
        let forgetCalls = 0;
        const harness = await loadClient({
            responseForDataPath: (path) => {
                // A newer tombstone never appears in a direct read, so a
                // freshness re-read cannot resolve a revision conflict. The
                // exact-revision answer is final.
                if (path === '/v1/plugins/data/forget') {
                    forgetCalls += 1;
                    return new Response(JSON.stringify({ status: 'conflict' }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                throw new Error(`Unexpected Collection path: ${path}`);
            },
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.forget('channel-1', 2)).resolves.toEqual({ status: 'conflict' });
        expect(forgetCalls).toBe(1);
        expect(JSON.parse(String(harness.transport.mock.calls.find(
            ([path]) => path === '/v1/plugins/data/forget',
        )?.[1]?.body))).toEqual({
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            writerContext: {
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            },
            rowId: 'channel-1',
            expectedRevision: 2,
        });
    });

    it('forgets consecutive exact rows of one Collection without a shared caller witness', async () => {
        const harness = await loadClient({
            responseForDataPath: (path) => {
                if (path === '/v1/plugins/data/forget') {
                    return new Response(JSON.stringify({ status: 'forgotten' }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                throw new Error(`Unexpected Collection path: ${path}`);
            },
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.forget('channel-1', 2)).resolves.toEqual({ status: 'forgotten' });
        await expect(collection.forget('channel-2', 5)).resolves.toEqual({ status: 'forgotten' });
        expect(harness.transport.mock.calls
            .filter(([path]) => path === '/v1/plugins/data/forget')
            .map(([, init]) => JSON.parse(String(init?.body)).expectedRevision)).toEqual([2, 5]);
    });

    it('keeps an absent-create epoch conflict a caller-visible mutation conflict', async () => {
        const harness = await loadClient({
            responseForDataPath: (path) => {
                if (path === '/v1/plugins/data/get') {
                    return new Response(JSON.stringify({ row: null, absenceEpoch: 9 }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                if (path === '/v1/plugins/data/mutate') {
                    return new Response(JSON.stringify({
                        status: 'conflict',
                        conflicts: [{ rowId: 'channel-stale', revision: null, deleted: false }],
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                throw new Error(`Unexpected Collection path: ${path}`);
            },
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.mutate([{
            kind: 'put',
            expectedRevision: 'absent',
            value: {
                id: 'channel-stale',
                status: 'enabled',
                title: 'Stale absence observation',
            },
        }])).resolves.toEqual({
            status: 'conflict',
            conflicts: [{ rowId: 'channel-stale', revision: null, deleted: false }],
        });
        const mutationCall = harness.transport.mock.calls.find(([path]) => path === '/v1/plugins/data/mutate');
        expect(mutationCall).toBeDefined();
        expect(JSON.parse(String(mutationCall?.[1]?.body)).operations).toEqual([
            expect.objectContaining({
                rowId: 'channel-stale',
                expectedRevision: 'absent',
                expectedAbsenceEpoch: 9,
            }),
        ]);
    });

    it('lets a caller retry a response-lost forget through the same idempotent request', async () => {
        let forgetAttempts = 0;
        const harness = await loadClient({
            responseForDataPath: (path) => {
                if (path === '/v1/plugins/data/forget') {
                    forgetAttempts += 1;
                    if (forgetAttempts === 1) throw new Error('response lost after committed forget');
                    return new Response(JSON.stringify({ status: 'forgotten' }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                throw new Error(`Unexpected Collection path: ${path}`);
            },
        });
        const collection = harness.createActivePluginCollectionClient({ contract });

        await expect(collection.forget('channel-retry', 4)).resolves.toMatchObject({
            status: 'unavailable',
        });
        await expect(collection.forget('channel-retry', 4)).resolves.toEqual({ status: 'forgotten' });
        const bodies = harness.transport.mock.calls
            .filter(([path]) => path === '/v1/plugins/data/forget')
            .map(([, init]) => JSON.parse(String(init?.body)));
        expect(bodies).toEqual([
            expect.objectContaining({ rowId: 'channel-retry', expectedRevision: 4 }),
            expect.objectContaining({ rowId: 'channel-retry', expectedRevision: 4 }),
        ]);
        expect(bodies.every((body) => !('expectedAbsenceEpoch' in body))).toBe(true);
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
            absenceEpoch: 0,
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
            responseForDataPath: (path) => path === '/v1/plugins/data/get'
                ? new Response(JSON.stringify({ row: null, absenceEpoch: 0 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(JSON.stringify({
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

    it.each(['plain', 'e2ee'] as const)('preserves exact issued mutation settlement after retirement on %s Accounts', async (mode) => {
        const harness = await loadClient({
            ...(mode === 'e2ee' ? { credentials: e2eeCredentials, currentness: e2eeCurrentness } : {}),
            retireDuringDataRequest: true,
        });
        await expect(harness.createActivePluginCollectionClient({ contract }).mutate([{
            kind: 'put',
            expectedRevision: 1,
            value: { id: 'channel-1', status: 'enabled', title: 'Changed title' },
        }])).resolves.toEqual({
            status: 'updated',
            results: [{ rowId: 'channel-1', revision: 2, deleted: false }],
            changeCursor: 19,
        });
    });

    it('does not issue a prepared mutation after caller cancellation', async () => {
        const harness = await loadClient();
        const cancellation = new AbortController();
        const options = { signal: cancellation.signal };
        const prepared = await harness.prepareCollectionOperation(options);
        if (prepared.status !== 'ready') throw new Error('Expected an admitted Account operation');
        try {
            cancellation.abort();
            await expect(harness.requestCollectionOperation({
                operation: prepared.operation, path: '/v1/plugins/data/mutate', kind: 'mutation', body: {}, options,
            })).resolves.toEqual({ status: 'unavailable', reason: 'operation-cancelled' });
            expect(harness.transport.mock.calls.some(([path]) => path === '/v1/plugins/data/mutate')).toBe(false);
        } finally {
            await prepared.operation.release();
        }
    });

    it.each(['lost', 'malformed', 'http-error'] as const)('reports an issued mutation with %s acknowledgement as outcome unknown', async (settlement) => {
        const harness = await loadClient({
            responseForDataPath: () => {
                if (settlement === 'lost') throw new Error('Response lost after commit');
                return new Response(JSON.stringify({}), { status: settlement === 'http-error' ? 500 : 200 });
            },
        });
        await expect(harness.createActivePluginCollectionClient({ contract }).mutate([{
            kind: 'delete', rowId: 'channel-1', expectedRevision: 1,
        }])).resolves.toEqual({ status: 'unavailable', reason: 'mutation-outcome-unknown' });
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
    it('reports the deployment-effective Collection limits a plugin UI must plan against', async () => {
        const harness = await loadClient();
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

        await expect(harness.createActivePluginCollectionClient({ contract }).limits()).resolves.toEqual({
            status: 'ready',
            limits: {
                maxRowEncodedBytes: 256 * 1024,
                maxRows: 5_000,
                maxCollectionEncodedBytes: 64 * 1024 * 1024,
                maxBatchBytes: 4 * 1024 * 1024,
                maxBatchRows: 40,
                maxAccountRows: 5_000,
                maxAccountBytes: 64 * 1024 * 1024,
                basis: 'deployment',
            },
        });
        expect(harness.transport).not.toHaveBeenCalled();
    });

    it('narrows the deployment Collection limits by the admitted contract quota', async () => {
        const harness = await loadClient();
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

        await expect(harness.createActivePluginCollectionClient({
            contract: quotaContract,
        }).limits()).resolves.toEqual({
            status: 'ready',
            limits: {
                maxRowEncodedBytes: 32 * 1024,
                maxRows: 250,
                maxCollectionEncodedBytes: 64 * 1024 * 1024,
                maxBatchBytes: 4 * 1024 * 1024,
                maxBatchRows: 40,
                maxAccountRows: 5_000,
                maxAccountBytes: 64 * 1024 * 1024,
                basis: 'deployment',
            },
        });
    });

    it('falls back to the shipped deployment policy when no capability is published', async () => {
        const harness = await loadClient();

        await expect(harness.createActivePluginCollectionClient({ contract }).limits()).resolves.toEqual({
            status: 'ready',
            limits: {
                ...PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
                maxRows: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountRows,
                maxCollectionEncodedBytes: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountBytes,
                basis: 'default',
            },
        });
    });

    it('reports the Collection limits unavailable once the captured Account scope retires', async () => {
        const harness = await loadClient();
        const collection = harness.createActivePluginCollectionClient({ contract });
        harness.retireScope();

        await expect(collection.limits()).resolves.toEqual({
            status: 'unavailable',
            reason: 'account-scope-changed',
        });
    });

    it('measures a candidate batch through the same sealed request the mutation sends', async () => {
        const harness = await loadClient({
            currentness: e2eeCurrentness,
            credentials: e2eeCredentials,
            responseForDataPath: (path) => path === '/v1/plugins/data/get'
                ? new Response(JSON.stringify({ row: null, absenceEpoch: 0 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(JSON.stringify({
                    status: 'updated',
                    results: [
                        { rowId: 'channel-1', revision: 1, deleted: false },
                        { rowId: 'channel-2', revision: 1, deleted: false },
                    ],
                    changeCursor: 21,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });
        const collection = harness.createActivePluginCollectionClient({ contract });
        const operations = [
            {
                kind: 'put' as const,
                expectedRevision: 'absent' as const,
                value: {
                    id: 'channel-1',
                    status: 'enabled' as const,
                    title: 'First',
                    privateNote: 'a'.repeat(8),
                },
            },
            {
                kind: 'put' as const,
                expectedRevision: 'absent' as const,
                value: {
                    id: 'channel-2',
                    status: 'enabled' as const,
                    title: 'Second',
                    privateNote: 'b'.repeat(250),
                },
            },
        ];

        const measured = await collection.measureBatch(operations);
        await collection.mutate(operations);

        expect(measured.status).toBe('ready');
        if (measured.status !== 'ready') return;
        expect(measured.measurement.operationEncodedBytes).toHaveLength(2);
        // The second row's private payload is far larger, and only a real seal
        // of the real E2EE envelope can show that on the wire.
        expect(measured.measurement.operationEncodedBytes[1]!).toBeGreaterThan(
            measured.measurement.operationEncodedBytes[0]! + 240,
        );
        const mutationCall = harness.transport.mock.calls.find(([path]) => path === '/v1/plugins/data/mutate');
        const sentRequest = PluginCollectionMutationRequestV1Schema.parse(
            JSON.parse(String(mutationCall?.[1]?.body)),
        );
        expect(
            measured.measurement.overheadEncodedBytes
            + measured.measurement.operationEncodedBytes.reduce((total, bytes) => total + bytes, 0)
            - 1,
        ).toBe(measurePluginCollectionMutationRequestEncodedBytesV1(sentRequest));
    });

    it('measures more candidate operations than one atomic batch may carry', async () => {
        const harness = await loadClient({
            currentness: e2eeCurrentness,
            credentials: e2eeCredentials,
            responseForDataPath: (path) => {
                if (path === '/v1/plugins/data/get') {
                    return new Response(JSON.stringify({ row: null, absenceEpoch: 0 }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                throw new Error('Measuring a candidate batch must not issue a mutation');
            },
        });
        const operations = Array.from({ length: 256 }, (_, index) => ({
            kind: 'put' as const,
            expectedRevision: 'absent' as const,
            value: {
                id: `channel-${String(index).padStart(3, '0')}`,
                status: 'enabled' as const,
                title: `Channel ${index}`,
                privateNote: 'n'.repeat(120),
            },
        }));

        const measured = await harness.createActivePluginCollectionClient({ contract })
            .measureBatch(operations);

        expect(measured.status).toBe('ready');
        if (measured.status !== 'ready') return;
        expect(measured.measurement.operationEncodedBytes).toHaveLength(256);
        expect(measured.measurement.operationEncodedBytes.every((bytes) => bytes > 0)).toBe(true);
        expect(measured.measurement.overheadEncodedBytes).toBeGreaterThan(0);
        expect(harness.transport.mock.calls.some(([path]) => path === '/v1/plugins/data/mutate')).toBe(false);
    });

    it('rejects measuring a batch the collection contract cannot encode', async () => {
        const harness = await loadClient();

        await expect(harness.createActivePluginCollectionClient({ contract }).measureBatch([{
            kind: 'put',
            expectedRevision: 'absent',
            value: { id: 'channel-1', status: 'unknown', title: 'Invalid status' },
        } as never])).resolves.toEqual({
            status: 'rejected',
            code: 'collection_mutation_invalid',
        });
    });
    it('carries the server quota incompatibility a batch planner must react to', async () => {
        const harness = await loadClient({
            responseForDataPath: (path) => path === '/v1/plugins/data/get'
                ? new Response(JSON.stringify({ row: null, absenceEpoch: 0 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(JSON.stringify({
                error: 'collection_quota_incompatible',
                dimension: 'maxBatchBytes',
                effectiveMaximum: 4 * 1024 * 1024,
            }), { status: 413, headers: { 'Content-Type': 'application/json' } }),
        });

        await expect(harness.createActivePluginCollectionClient({ contract }).mutate([{
            kind: 'put',
            expectedRevision: 'absent',
            value: { id: 'channel-1', status: 'enabled', title: 'Too large for one batch' },
        }])).resolves.toEqual({
            status: 'rejected',
            code: 'collection_quota_incompatible',
            quotaIncompatibility: {
                dimension: 'maxBatchBytes',
                effectiveMaximum: 4 * 1024 * 1024,
            },
        });
    });

    /**
     * Protocol admits strict JSON iteratively and deliberately carries no depth
     * quota, while this client still hands the body to the runtime's recursive
     * `JSON.stringify`. Where that serializer refuses a value, the request can
     * never succeed, so reporting it as `transport-unavailable` tells the caller
     * to retry a permanently failing write. The daemon host classifies the same
     * refusal as an invalid value, and the two realms must not disagree.
     *
     * The fixture is cyclic rather than deep on purpose. Only a recursive
     * serializer refuses a deep body, and the engine this suite runs on is
     * iterative — Node 26 serialized 1,000,000 nesting levels without
     * complaint — so a deep fixture would quietly turn this into a test that
     * cannot fail. A cycle is the one input every shipped engine refuses.
     */
    it('reports a body the runtime cannot serialize as a permanent failure, not a transport outage', async () => {
        const harness = await loadClient();
        const prepared = await harness.prepareCollectionOperation(undefined);
        if (prepared.status !== 'ready') throw new Error('Expected a prepared Account Data operation');

        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        try {
            await expect(harness.requestCollectionOperation({
                operation: prepared.operation,
                path: '/v1/plugins/data/mutate',
                body: cyclic,
            })).resolves.toEqual({
                status: 'unavailable',
                reason: 'request-not-serializable',
            });
            expect(harness.transport).not.toHaveBeenCalledWith(
                '/v1/plugins/data/mutate',
                expect.anything(),
            );
        } finally {
            await prepared.operation.release();
        }
    });
});
