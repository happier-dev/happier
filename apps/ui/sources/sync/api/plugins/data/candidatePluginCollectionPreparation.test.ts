import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    FeaturesResponseSchema,
    measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1,
    normalizePluginAccountCollectionContractV1,
    type PluginCollectionCandidatePreparationBindingV1,
    PluginCollectionCandidatePreparationStageRequestV1Schema,
    type PluginDataCollectionsCapabilities,
} from '@happier-dev/protocol';
import type { PluginAccountCollectionMigrationRuntimeProjection } from '@happier-dev/plugin-sdk';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const pluginId = 'example.tasks';

const sourceContract = normalizePluginAccountCollectionContractV1({
    pluginId,
    contribution: {
        id: 'tasks',
        schemaVersion: 1,
        schema: {
            type: 'object',
            properties: {
                id: { type: 'string', maxLength: 256 },
                status: { type: 'string', enum: ['open', 'closed'] },
                title: { type: 'string', maxLength: 256 },
            },
            required: ['id', 'status', 'title'],
            additionalProperties: false,
        },
        rowIdField: 'id',
        identityFields: [],
        serverReadable: ['id', 'status', 'title'],
        indexes: [],
        uiQueries: [],
        relations: [],
        migrations: [],
    },
});

const targetContract = normalizePluginAccountCollectionContractV1({
    pluginId,
    contribution: {
        id: 'tasks',
        schemaVersion: 2,
        schema: {
            type: 'object',
            properties: {
                id: { type: 'string', maxLength: 256 },
                status: { type: 'string', enum: ['open', 'closed'] },
                title: { type: 'string', maxLength: 256 },
                migrated: { type: 'boolean' },
            },
            required: ['id', 'status', 'title', 'migrated'],
            additionalProperties: false,
        },
        rowIdField: 'id',
        identityFields: [],
        serverReadable: ['id', 'status', 'title'],
        indexes: [],
        uiQueries: [],
        relations: [],
        readableSchemaVersions: [1],
        migrations: [{
            id: 'upgrade-v1-to-v2',
            fromSchemaVersion: 1,
            toSchemaVersion: 2,
        }],
    },
});

const binding: PluginCollectionCandidatePreparationBindingV1 = Object.freeze({
    source: Object.freeze({
        pluginId,
        collectionId: sourceContract.collectionId,
        schemaVersion: sourceContract.schemaVersion,
        contractDigest: sourceContract.contractDigest,
    }),
    target: Object.freeze({
        pluginId,
        collectionId: targetContract.collectionId,
        schemaVersion: targetContract.schemaVersion,
        contractDigest: targetContract.contractDigest,
    }),
    candidate: Object.freeze({
        releaseVersion: '2.0.0',
        artifactDigest: `sha256:${'a'.repeat(64)}`,
    }),
});

const sourceRow = Object.freeze({
    rowId: 'task-1',
    revision: 7,
    alreadyStaged: false,
    content: Object.freeze({ t: 'plain' as const, v: Object.freeze({}) }),
    projection: Object.freeze({
        id: 'task-1',
        status: 'open',
        title: 'Prepare before selecting',
    }),
});

const secondSourceRow = Object.freeze({
    rowId: 'task-2',
    revision: 8,
    alreadyStaged: false,
    content: Object.freeze({ t: 'plain' as const, v: Object.freeze({}) }),
    projection: Object.freeze({
        id: 'task-2',
        status: 'closed',
        title: 'Prepare the second row',
    }),
});

type PreparationHarnessOptions = Readonly<{
    sourcePage?: () => Promise<Response>;
    onMigrate?: () => void;
    stageResponse?: (init?: RequestInit) => Promise<Response> | Response;
    collectionLimits?: PluginDataCollectionsCapabilities;
}>;

function collectionFeatures(limits: PluginDataCollectionsCapabilities) {
    return {
        status: 'ready' as const,
        features: FeaturesResponseSchema.parse({
            features: {},
            capabilities: { pluginDataCollections: limits },
        }),
    };
}

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createLifetime(): Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    retire(): void;
}> {
    let current = true;
    const listeners = new Set<() => void>();
    return Object.freeze({
        lifetime: Object.freeze({
            scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
            isCurrent: () => current,
            onRetire: (listener: () => void) => {
                listeners.add(listener);
                return Object.freeze({ dispose: () => listeners.delete(listener) });
            },
        }),
        retire: () => {
            current = false;
            for (const listener of [...listeners]) listener();
        },
    });
}

async function loadPreparationHarness(options: PreparationHarnessOptions = {}) {
    vi.resetModules();
    const account = createLifetime();
    let candidateCurrent = true;
    const getCachedServerFeaturesSnapshot = vi.fn(() => options.collectionLimits
        ? collectionFeatures(options.collectionLimits)
        : null);
    const request = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
        if (path === '/v1/account/encryption/currentness') {
            return jsonResponse({
                mode: 'plain',
                version: 1,
                signingKeyFingerprint: null,
                contentKeyFingerprint: null,
                updatedAt: 1,
            });
        }
        if (path === '/v1/plugins/data/candidate-preparation/source-page') {
            return options.sourcePage
                ? await options.sourcePage()
                : jsonResponse({ rows: [sourceRow] });
        }
        if (path === '/v1/plugins/data/candidate-preparation/stage') {
            if (options.stageResponse) return await options.stageResponse(init);
            const body = JSON.parse(String(init?.body)) as { items: readonly unknown[] };
            return jsonResponse({ results: body.items.map(() => ({ status: 'staged' })) });
        }
        if (path === '/v1/plugins/data/candidate-preparation/retire') {
            return jsonResponse({ status: 'retired' });
        }
        throw new Error(`Unexpected request path: ${path}`);
    });

    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'server-a',
            serverUrl: 'https://server.example',
            generation: 4,
        }),
    }));
    vi.doMock('@/sync/api/capabilities/serverFeaturesClient', () => ({
        getCachedServerFeaturesSnapshot,
    }));
    vi.doMock('@/sync/api/session/apiSocket', () => ({ apiSocket: { request: vi.fn() } }));
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope', () => ({
        captureSessionRequestAuthorityForServerAccountScope: async () => ({
            scope: account.lifetime.scope,
            context: { token: 'account-token' },
            request,
        }),
    }));

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
    const preparation = await import('./candidatePluginCollectionPreparation');
    const migrate = vi.fn((value: Readonly<Record<string, unknown>>) => {
        options.onMigrate?.();
        return {
            ...value,
            migrated: true,
        };
    });
    const collectionMigrations: PluginAccountCollectionMigrationRuntimeProjection = Object.freeze({
        tasks: Object.freeze([Object.freeze({
            id: 'upgrade-v1-to-v2',
            fromSchemaVersion: 1,
            toSchemaVersion: 2,
            migrate,
        })]),
    });

    return Object.freeze({
        account,
        request,
        migrate,
        getCachedServerFeaturesSnapshot,
        collectionMigrations,
        setCandidateCurrent: (value: boolean) => { candidateCurrent = value; },
        operation: preparation.createActivePluginCollectionCandidatePreparation({
            candidate: Object.freeze({
                accountLifetime: account.lifetime,
                binding,
                sourceContract,
                targetContract,
                collectionMigrations,
                isCurrent: () => candidateCurrent,
            }),
        }),
    });
}

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('active Plugin Collection candidate preparation', () => {
    it('stages only target callback output bound to the exact candidate in one source-page batch', async () => {
        const harness = await loadPreparationHarness({
            sourcePage: async () => jsonResponse({ rows: [sourceRow, secondSourceRow] }),
        });

        await expect(harness.operation.prepare()).resolves.toEqual({ kind: 'prepared' });
        expect(harness.migrate).toHaveBeenCalledTimes(2);
        expect(harness.migrate).toHaveBeenNthCalledWith(1, {
            id: 'task-1',
            status: 'open',
            title: 'Prepare before selecting',
        });
        expect(harness.migrate).toHaveBeenNthCalledWith(2, {
            id: 'task-2',
            status: 'closed',
            title: 'Prepare the second row',
        });

        const stageCall = harness.request.mock.calls.find(([path]) => (
            path === '/v1/plugins/data/candidate-preparation/stage'
        ));
        expect(stageCall).toBeDefined();
        expect(JSON.parse(String(stageCall?.[1]?.body))).toEqual({
            binding,
            items: [
                {
                    source: { rowId: 'task-1', revision: 7 },
                    target: {
                        content: { t: 'plain', v: { migrated: true } },
                        projection: {
                            id: 'task-1',
                            status: 'open',
                            title: 'Prepare before selecting',
                        },
                    },
                },
                {
                    source: { rowId: 'task-2', revision: 8 },
                    target: {
                        content: { t: 'plain', v: { migrated: true } },
                        projection: {
                            id: 'task-2',
                            status: 'closed',
                            title: 'Prepare the second row',
                        },
                    },
                },
            ],
        });
        expect(harness.request.mock.calls.some(([path]) => (
            path === '/v1/plugins/data/contract'
        ))).toBe(false);
    });

    it('splits one source page at an advertised lower candidate-stage row cap', async () => {
        const maxBatchBytes = measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(
            PluginCollectionCandidatePreparationStageRequestV1Schema.parse({
                binding,
                items: [
                    {
                        source: { rowId: 'task-1', revision: 7 },
                        target: {
                            content: { t: 'plain' as const, v: { migrated: true } },
                            projection: {
                                id: 'task-1',
                                status: 'open',
                                title: 'Prepare before selecting',
                            },
                        },
                    },
                    {
                        source: { rowId: 'task-2', revision: 8 },
                        target: {
                            content: { t: 'plain' as const, v: { migrated: true } },
                            projection: {
                                id: 'task-2',
                                status: 'closed',
                                title: 'Prepare the second row',
                            },
                        },
                    },
                ],
            }),
        );
        const harness = await loadPreparationHarness({
            sourcePage: async () => jsonResponse({ rows: [sourceRow, secondSourceRow] }),
            collectionLimits: {
                maxRowEncodedBytes: maxBatchBytes,
                maxBatchBytes,
                maxBatchRows: 1,
                maxAccountRows: 100,
                maxAccountBytes: maxBatchBytes,
            },
        });

        await expect(harness.operation.prepare()).resolves.toEqual({ kind: 'prepared' });
        expect(harness.getCachedServerFeaturesSnapshot).toHaveBeenCalledWith({ serverId: 'server-a' });

        const stageBodies = harness.request.mock.calls
            .filter(([path]) => path === '/v1/plugins/data/candidate-preparation/stage')
            .map(([, init]) => JSON.parse(String(init?.body)));
        expect(stageBodies).toEqual([
            {
                binding,
                items: [{
                    source: { rowId: 'task-1', revision: 7 },
                    target: {
                        content: { t: 'plain', v: { migrated: true } },
                        projection: {
                            id: 'task-1',
                            status: 'open',
                            title: 'Prepare before selecting',
                        },
                    },
                }],
            },
            {
                binding,
                items: [{
                    source: { rowId: 'task-2', revision: 8 },
                    target: {
                        content: { t: 'plain', v: { migrated: true } },
                        projection: {
                            id: 'task-2',
                            status: 'closed',
                            title: 'Prepare the second row',
                        },
                    },
                }],
            },
        ]);
    });

    it('splits one source page at the advertised canonical candidate-stage byte cap', async () => {
        const firstItem = {
            source: { rowId: 'task-1', revision: 7 },
            target: {
                content: { t: 'plain' as const, v: { migrated: true } },
                projection: {
                    id: 'task-1',
                    status: 'open',
                    title: 'Prepare before selecting',
                },
            },
        };
        const secondItem = {
            source: { rowId: 'task-2', revision: 8 },
            target: {
                content: { t: 'plain' as const, v: { migrated: true } },
                projection: {
                    id: 'task-2',
                    status: 'closed',
                    title: 'Prepare the second row',
                },
            },
        };
        const maxBatchBytes = Math.max(
            measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(
                PluginCollectionCandidatePreparationStageRequestV1Schema.parse({ binding, items: [firstItem] }),
            ),
            measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(
                PluginCollectionCandidatePreparationStageRequestV1Schema.parse({ binding, items: [secondItem] }),
            ),
        );
        const harness = await loadPreparationHarness({
            sourcePage: async () => jsonResponse({ rows: [sourceRow, secondSourceRow] }),
            collectionLimits: {
                maxRowEncodedBytes: maxBatchBytes,
                maxBatchBytes,
                maxBatchRows: 100,
                maxAccountRows: 100,
                maxAccountBytes: maxBatchBytes,
            },
        });

        await expect(harness.operation.prepare()).resolves.toEqual({ kind: 'prepared' });

        const stageBodies = harness.request.mock.calls
            .filter(([path]) => path === '/v1/plugins/data/candidate-preparation/stage')
            .map(([, init]) => JSON.parse(String(init?.body)));
        expect(stageBodies).toHaveLength(2);
        expect(stageBodies.map((body) => body.items)).toEqual([
            [firstItem],
            [secondItem],
        ]);
    });

    it('maps a positional sourceChanged stage result to a retryable preparation outcome', async () => {
        const harness = await loadPreparationHarness({
            sourcePage: async () => jsonResponse({ rows: [sourceRow, secondSourceRow] }),
            stageResponse: () => jsonResponse({ results: [{ status: 'sourceChanged' }] }),
            collectionLimits: {
                maxRowEncodedBytes: 2048,
                maxBatchBytes: 4096,
                maxBatchRows: 1,
                maxAccountRows: 100,
                maxAccountBytes: 4096,
            },
        });

        await expect(harness.operation.prepare()).resolves.toEqual({
            kind: 'retryable',
            code: 'source_changed',
        });
        expect(harness.request.mock.calls.filter(([path]) => (
            path === '/v1/plugins/data/candidate-preparation/stage'
        ))).toHaveLength(1);
    });

    it('does not stage or report readiness after Account A retires during a late source-page response', async () => {
        let resolveSourcePage!: (response: Response) => void;
        const sourcePage = new Promise<Response>((resolve) => { resolveSourcePage = resolve; });
        const harness = await loadPreparationHarness({ sourcePage: async () => await sourcePage });

        const pending = harness.operation.prepare();
        await vi.waitFor(() => expect(harness.request).toHaveBeenCalledWith(
            '/v1/plugins/data/candidate-preparation/source-page',
            expect.anything(),
        ));
        harness.account.retire();
        resolveSourcePage(jsonResponse({ rows: [sourceRow] }));

        await expect(pending).resolves.toEqual({
            kind: 'unavailable',
            code: 'account-scope-changed',
        });
        expect(harness.migrate).not.toHaveBeenCalled();
        expect(harness.request.mock.calls.some(([path]) => (
            path === '/v1/plugins/data/candidate-preparation/stage'
        ))).toBe(false);
        await vi.waitFor(() => expect(harness.request).toHaveBeenCalledWith(
            '/v1/plugins/data/candidate-preparation/retire',
            expect.objectContaining({
                body: JSON.stringify({ binding }),
            }),
        ));
    });

    it('does not invoke candidate code or stage an exact source revision the server already staged', async () => {
        const harness = await loadPreparationHarness({
            sourcePage: async () => jsonResponse({
                rows: [{ ...sourceRow, alreadyStaged: true }],
            }),
        });

        await expect(harness.operation.prepare()).resolves.toEqual({ kind: 'prepared' });
        expect(harness.migrate).not.toHaveBeenCalled();
        expect(harness.request.mock.calls.some(([path]) => (
            path === '/v1/plugins/data/candidate-preparation/stage'
        ))).toBe(false);
    });

    it('does not stage a callback result after the exact candidate generation becomes stale', async () => {
        let setCandidateCurrent!: (value: boolean) => void;
        const harness = await loadPreparationHarness({
            onMigrate: () => setCandidateCurrent(false),
        });
        setCandidateCurrent = harness.setCandidateCurrent;

        await expect(harness.operation.prepare()).resolves.toEqual({
            kind: 'unavailable',
            code: 'candidate_generation_changed',
        });
        expect(harness.migrate).toHaveBeenCalledTimes(1);
        expect(harness.request.mock.calls.some(([path]) => (
            path === '/v1/plugins/data/candidate-preparation/stage'
        ))).toBe(false);
    });

    it('drains started preparation before retiring the exact binding through captured Account A authority', async () => {
        let resolveSourcePage!: (response: Response) => void;
        const sourcePage = new Promise<Response>((resolve) => { resolveSourcePage = resolve; });
        const harness = await loadPreparationHarness({ sourcePage: async () => await sourcePage });

        const pending = harness.operation.prepare();
        await vi.waitFor(() => expect(harness.request).toHaveBeenCalledWith(
            '/v1/plugins/data/candidate-preparation/source-page',
            expect.anything(),
        ));
        const retiring = harness.operation.retire();
        expect(harness.request.mock.calls.some(([path]) => (
            path === '/v1/plugins/data/candidate-preparation/retire'
        ))).toBe(false);
        resolveSourcePage(jsonResponse({ rows: [sourceRow] }));

        await expect(pending).resolves.toEqual({
            kind: 'unavailable',
            code: 'candidate_retired',
        });
        await expect(retiring).resolves.toEqual({ kind: 'retired' });
        expect(harness.migrate).not.toHaveBeenCalled();
        expect(harness.request.mock.calls.some(([path]) => (
            path === '/v1/plugins/data/candidate-preparation/stage'
        ))).toBe(false);
        const retireCall = harness.request.mock.calls.find(([path]) => (
            path === '/v1/plugins/data/candidate-preparation/retire'
        ));
        expect(JSON.parse(String(retireCall?.[1]?.body))).toEqual({ binding });
    });
});
