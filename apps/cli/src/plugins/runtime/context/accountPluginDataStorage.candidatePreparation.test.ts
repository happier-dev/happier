import { describe, expect, it, vi } from 'vitest';
import {
    accountSettingsParse,
    FeaturesResponseSchema,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1,
    measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1,
    normalizePluginAccountCollectionContractV1,
    PluginCollectionCandidatePreparationStageRequestV1Schema,
    type PluginAccountCollectionContributionV1,
    type PluginDataCollectionsCapabilities,
} from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

import { createAccountPluginDataStorageHost } from './accountPluginDataStorage';

const pluginId = 'example.collection-migration';
const collectionId = 'tasks';
const credentials = {
    token: 'candidate-preparation-token',
    encryption: null,
} satisfies StoredCredentials;

const sourceContribution = {
    id: collectionId,
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 256 },
            title: { type: 'string', maxLength: 256 },
        },
        required: ['id', 'title'],
        additionalProperties: false,
    },
    rowIdField: 'id',
    serverReadable: ['id', 'title'],
    indexes: [],
    uiQueries: [],
    relations: [],
    identityFields: [],
    migrations: [],
} satisfies PluginAccountCollectionContributionV1;

const targetContribution = {
    id: collectionId,
    schemaVersion: 2,
    readableSchemaVersions: [1],
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
    serverReadable: ['id', 'title', 'status'],
    indexes: [],
    uiQueries: [],
    relations: [],
    identityFields: [],
    migrations: [{
        id: 'upgrade-v1-to-v2',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
    }],
} satisfies PluginAccountCollectionContributionV1;

const sourceContract = normalizePluginAccountCollectionContractV1({
    pluginId,
    contribution: sourceContribution,
});
const targetContract = normalizePluginAccountCollectionContractV1({
    pluginId,
    contribution: targetContribution,
});
const binding = Object.freeze({
    source: Object.freeze({
        pluginId,
        collectionId,
        schemaVersion: sourceContract.schemaVersion,
        contractDigest: sourceContract.contractDigest,
    }),
    target: Object.freeze({
        pluginId,
        collectionId,
        schemaVersion: targetContract.schemaVersion,
        contractDigest: targetContract.contractDigest,
    }),
    candidate: Object.freeze({
        releaseVersion: '2.0.0',
        artifactDigest: `sha256:${'c'.repeat(64)}`,
    }),
});

const currentEncryption = async () => Object.freeze({
    mode: 'plain' as const,
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
});

function sourceRow(rowId: string, revision: number, title: string, alreadyStaged: boolean) {
    return {
        rowId,
        revision,
        content: { t: 'plain' as const, v: {} },
        projection: { id: rowId, title },
        alreadyStaged,
    };
}

function collectionFeatures(
    limits: PluginDataCollectionsCapabilities,
): CliServerFeaturesSnapshot {
    return {
        status: 'ready',
        features: FeaturesResponseSchema.parse({
            features: {},
            capabilities: { pluginDataCollections: limits },
        }),
    };
}

function createCandidateHost(
    post: (url: string, body: unknown) => Promise<Readonly<{
        status: number;
        data: unknown;
    }>>,
    options: Readonly<{
        resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
    }> = {},
) {
    return createAccountPluginDataStorageHost({
        contracts: [targetContract],
        readCredentials: async () => credentials,
        isCurrentAccount: () => true,
        resolveAccountScopeKey: () => 'candidate-preparation-account',
        resolveBaseUrl: () => 'https://data.example.test',
        resolveAccountEncryptionCurrentness: currentEncryption,
        http: {
            get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
            post,
        },
        randomBytes: (length) => new Uint8Array(length).fill(7),
        resolveServerFeaturesSnapshot: options.resolveServerFeaturesSnapshot,
    });
}

function createCandidate(params: Readonly<{
    post: (url: string, body: unknown) => Promise<Readonly<{ status: number; data: unknown }>>;
    migrate: (value: Readonly<Record<string, JsonValue>>) => Readonly<Record<string, JsonValue>> | Promise<Readonly<Record<string, JsonValue>>>;
    signal?: AbortSignal;
    resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
}>) {
    const host = createCandidateHost(params.post, {
        resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot,
    });
    return host.createCollectionMigrationCandidate({
        binding,
        sourceContract,
        targetContract,
        declarations: [targetContribution],
        runtime: {
            [collectionId]: [{
                id: 'upgrade-v1-to-v2',
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
                migrate: params.migrate,
            }],
        },
        signal: params.signal ?? new AbortController().signal,
        isGenerationCurrent: () => true,
    });
}

describe('Account Data Collection candidate preparation', () => {
    it('retires an exact persisted candidate binding without requiring its target callback or generation', async () => {
        const post = vi.fn(async (url: string, body: unknown) => {
            expect(url).toBe(`https://data.example.test${PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1}`);
            expect(body).toEqual({ binding });
            return { status: 200, data: { status: 'retired' } };
        });
        const host = createCandidateHost(post);

        await expect(host.retireCollectionMigrationCandidate({
            binding,
            signal: new AbortController().signal,
            isCurrent: () => true,
        })).resolves.toBeUndefined();

        expect(post).toHaveBeenCalledOnce();
    });

    it('does not stage a candidate bound to retired Account A after A→B→A', async () => {
        const credentialsA = { token: 'candidate-preparation-account-a', encryption: null } satisfies StoredCredentials;
        const credentialsB = { token: 'candidate-preparation-account-b', encryption: null } satisfies StoredCredentials;
        const scopeA = resolveAccountSettingsScopeKey(credentialsA);
        const scopeB = resolveAccountSettingsScopeKey(credentialsB);
        const post = vi.fn(async () => {
            throw new Error('A retired candidate must not reach Account Data');
        });

        resetActiveAccountSettingsSnapshotForTests();
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });
            const host = createAccountPluginDataStorageHost({
                contracts: [targetContract],
                readCredentials: async () => credentialsA,
                resolveBaseUrl: () => 'https://data.example.test',
                resolveAccountEncryptionCurrentness: currentEncryption,
                http: {
                    get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
                    post,
                },
                randomBytes: (length) => new Uint8Array(length).fill(7),
            });
            const candidate = host.createCollectionMigrationCandidate({
                binding,
                sourceContract,
                targetContract,
                declarations: [targetContribution],
                runtime: {
                    [collectionId]: [{
                        id: 'upgrade-v1-to-v2',
                        fromSchemaVersion: 1,
                        toSchemaVersion: 2,
                        migrate: (value) => ({ ...value, status: 'open' }),
                    }],
                },
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: scopeB,
            });
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 2,
                loadedAtMs: 3,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });

            await expect(candidate.prepare()).rejects.toMatchObject({
                code: 'plugin_account_storage_unavailable',
            } satisfies Partial<PluginError>);
            expect(post).not.toHaveBeenCalled();
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('uses the one target-bound host operation, skips exact staged revisions, and batches only target material for a source page', async () => {
        const migrate = vi.fn((value: Readonly<Record<string, JsonValue>>) => ({
            ...value,
            status: 'open',
        }));
        const post = vi.fn(async (url: string, body: unknown) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                expect(body).toEqual({ binding, limit: 50 });
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-already-staged', 3, 'Already staged', true),
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: { results: [{ status: 'staged' }, { status: 'staged' }] },
                };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({ post, migrate });

        await expect(candidate.prepare()).resolves.toBeUndefined();

        expect(migrate).toHaveBeenCalledTimes(2);
        expect(migrate).toHaveBeenNthCalledWith(1, { id: 'task-current', title: 'Prepare me' });
        expect(migrate).toHaveBeenNthCalledWith(2, { id: 'task-next', title: 'Prepare this too' });
        const stageCall = post.mock.calls.find(([url]) => (
            String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)
        ));
        expect(stageCall?.[1]).toEqual({
            binding,
            items: [
                {
                    source: { rowId: 'task-current', revision: 4 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
                    },
                },
                {
                    source: { rowId: 'task-next', revision: 5 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
                    },
                },
            ],
        });
    });

    it('splits one source page at an advertised lower candidate-stage row cap', async () => {
        const maxBatchBytes = measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(
            PluginCollectionCandidatePreparationStageRequestV1Schema.parse({
                binding,
                items: [
                    {
                        source: { rowId: 'task-current', revision: 4 },
                        target: {
                            content: { t: 'plain' as const, v: {} },
                            projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
                        },
                    },
                    {
                        source: { rowId: 'task-next', revision: 5 },
                        target: {
                            content: { t: 'plain' as const, v: {} },
                            projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
                        },
                    },
                ],
            }),
        );
        const post = vi.fn(async (url: string, body: unknown) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                const request = body as { items: readonly unknown[] };
                return {
                    status: 200,
                    data: { results: request.items.map(() => ({ status: 'staged' })) },
                };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({
            post,
            migrate: (value) => ({ ...value, status: 'open' }),
            resolveServerFeaturesSnapshot: () => collectionFeatures({
                maxRowEncodedBytes: maxBatchBytes,
                maxBatchBytes,
                maxBatchRows: 1,
                maxAccountRows: 100,
                maxAccountBytes: maxBatchBytes,
            }),
        });

        await expect(candidate.prepare()).resolves.toBeUndefined();

        const stageBodies = post.mock.calls
            .filter(([url]) => String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1))
            .map(([, body]) => body);
        expect(stageBodies).toEqual([
            {
                binding,
                items: [{
                    source: { rowId: 'task-current', revision: 4 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
                    },
                }],
            },
            {
                binding,
                items: [{
                    source: { rowId: 'task-next', revision: 5 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
                    },
                }],
            },
        ]);
    });

    it('splits one source page at the advertised canonical candidate-stage byte cap', async () => {
        const firstItem = {
            source: { rowId: 'task-current', revision: 4 },
            target: {
                content: { t: 'plain' as const, v: {} },
                projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
            },
        };
        const secondItem = {
            source: { rowId: 'task-next', revision: 5 },
            target: {
                content: { t: 'plain' as const, v: {} },
                projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
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
        const post = vi.fn(async (url: string, body: unknown) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                const request = body as { items: readonly unknown[] };
                return {
                    status: 200,
                    data: { results: request.items.map(() => ({ status: 'staged' })) },
                };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({
            post,
            migrate: (value) => ({ ...value, status: 'open' }),
            resolveServerFeaturesSnapshot: () => collectionFeatures({
                maxRowEncodedBytes: maxBatchBytes,
                maxBatchBytes,
                maxBatchRows: 100,
                maxAccountRows: 100,
                maxAccountBytes: maxBatchBytes,
            }),
        });

        await expect(candidate.prepare()).resolves.toBeUndefined();

        const stageBodies = post.mock.calls
            .filter(([url]) => String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1))
            .map(([, body]) => body);
        expect(stageBodies).toHaveLength(2);
        expect(stageBodies.map((body) => (body as { items: readonly unknown[] }).items)).toEqual([
            [firstItem],
            [secondItem],
        ]);
    });

    it('does not replay a callback when the exact source-revision stage CAS reports sourceChanged', async () => {
        const migrate = vi.fn((value: Readonly<Record<string, JsonValue>>) => ({
            ...value,
            status: 'open',
        }));
        const sourcePage = vi.fn();
        const stage = vi.fn();
        const post = vi.fn(async (url: string, _body: unknown) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                sourcePage();
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                stage();
                return { status: 200, data: { results: [{ status: 'sourceChanged' }] } };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({
            post,
            migrate,
            resolveServerFeaturesSnapshot: () => collectionFeatures({
                maxRowEncodedBytes: 2048,
                maxBatchBytes: 4096,
                maxBatchRows: 1,
                maxAccountRows: 100,
                maxAccountBytes: 4096,
            }),
        });

        await expect(candidate.prepare()).rejects.toMatchObject({
            code: 'collection_candidate_preparation_source_changed',
        } satisfies Partial<PluginError>);

        expect(migrate).toHaveBeenCalledTimes(2);
        expect(sourcePage).toHaveBeenCalledOnce();
        expect(stage).toHaveBeenCalledOnce();
    });

    it('drains an aborted callback before retiring its exact binding and never stages its output', async () => {
        const pendingMigration = {
            release: null as ((value: Readonly<Record<string, JsonValue>>) => void) | null,
        };
        const migrate = vi.fn((value: Readonly<Record<string, JsonValue>>) => new Promise<Readonly<Record<string, JsonValue>>>((resolve) => {
            pendingMigration.release = () => resolve({ ...value, status: 'open' });
        }));
        const post = vi.fn(async (url: string, _body: unknown) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: { rows: [sourceRow('task-current', 4, 'Prepare me', false)] },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)) {
                return { status: 200, data: { status: 'retired' } };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                throw new Error('Cancelled candidate preparation must not stage callback output');
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({ post, migrate });
        const preparing = candidate.prepare();

        await vi.waitFor(() => expect(migrate).toHaveBeenCalledOnce());
        const retiring = candidate.retire();
        expect(post.mock.calls.some(([url]) => (
            String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)
        ))).toBe(false);
        if (!pendingMigration.release) throw new Error('Expected the migration callback to be pending');
        pendingMigration.release({ id: 'task-current', title: 'Prepare me' });

        await expect(preparing).rejects.toMatchObject({
            code: 'plugin_collection_cancelled',
        } satisfies Partial<PluginError>);
        await expect(retiring).resolves.toBeUndefined();
        expect(post.mock.calls.find(([url]) => (
            String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)
        ))?.[1]).toEqual({ binding });
    });

    it('uses the Account-A retirement authority captured before staging after active credentials switch to Account B', async () => {
        const accountA = {
            token: 'candidate-preparation-account-a',
            encryption: null,
        } satisfies StoredCredentials;
        const accountB = {
            token: 'candidate-preparation-account-b',
            encryption: null,
        } satisfies StoredCredentials;
        let activeCredentials: StoredCredentials = accountA;
        const post = vi.fn(async (
            url: string,
            _body: unknown,
            config: Readonly<Record<string, unknown>>,
        ) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: { rows: [sourceRow('task-current', 4, 'Prepare me', false)] },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                return { status: 200, data: { results: [{ status: 'staged' }] } };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)) {
                expect(config).toMatchObject({
                    headers: { Authorization: 'Bearer candidate-preparation-account-a' },
                });
                return { status: 200, data: { status: 'retired' } };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const host = createAccountPluginDataStorageHost({
            contracts: [targetContract],
            readCredentials: async () => activeCredentials,
            isCurrentAccount: (candidate) => candidate === activeCredentials,
            resolveAccountScopeKey: () => 'candidate-preparation-account',
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: currentEncryption,
            http: {
                get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
                post,
            },
            randomBytes: (length) => new Uint8Array(length).fill(7),
        });
        const candidate = host.createCollectionMigrationCandidate({
            binding,
            sourceContract,
            targetContract,
            declarations: [targetContribution],
            runtime: {
                [collectionId]: [{
                    id: 'upgrade-v1-to-v2',
                    fromSchemaVersion: 1,
                    toSchemaVersion: 2,
                    migrate: (value) => ({ ...value, status: 'open' }),
                }],
            },
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        await expect(candidate.prepare()).resolves.toBeUndefined();
        activeCredentials = accountB;

        await expect(candidate.retire()).resolves.toBeUndefined();
    });
});
