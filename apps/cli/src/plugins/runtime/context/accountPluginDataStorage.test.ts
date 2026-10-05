import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    FeaturesResponseSchema,
    PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
    PluginCollectionMutationRequestV1Schema,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    derivePluginCollectionIdentityTagV1,
    measurePluginCollectionMutationRequestEncodedBytesV1,
    normalizePluginAccountCollectionContractV1,
    openPluginAccountStoragePrivatePayloadV1,
    openPluginCollectionPrivatePayloadV1,
    PluginAccountStorageMutationRequestV1Schema,
    PluginManifestV2Schema,
    type AccountEncryptionCurrentnessResponse,
    type ParsedPluginManifestV2,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginAccountCollectionContributionV1,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import type { AccountKvTransaction } from '@happier-dev/plugin-sdk/storage';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';

import {
    createAccountPluginDataStorageHost,
    type PluginAccountCollectionWatchInvalidation,
} from './accountPluginDataStorage';

const PLUGIN_ID = 'example.tasks';
const COLLECTION_ID = 'tasks';
const ACCOUNT_SCOPE_KEY = 'account-scope-plugin-data-storage';
const collectionDefinition = {
    id: COLLECTION_ID,
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 256 },
            status: { type: 'string', enum: ['open', 'closed'] },
            privateNote: { type: 'string', maxLength: 256 },
        },
        required: ['id', 'status', 'privateNote'],
        additionalProperties: false,
    },
    rowIdField: 'id',
    serverReadable: ['status'],
    indexes: [{
        id: 'by-status',
        fields: [{ field: 'status', direction: 'asc' as const }],
    }],
    uiQueries: [],
    relations: [],
    identityFields: [],
} satisfies PluginAccountCollectionDefinition;
const contribution = {
    ...collectionDefinition,
    migrations: [],
} satisfies PluginAccountCollectionContributionV1;
const admitted = normalizePluginAccountCollectionContractV1({
    pluginId: PLUGIN_ID,
    contribution,
});
/**
 * The same collection, declaring both addressable fields as mode-derived
 * identities. `identityFields` is the contract's single authority for which
 * derivation domains exist.
 */
const identityCollectionDefinition = {
    ...collectionDefinition,
    identityFields: ['id', 'status'],
} satisfies PluginAccountCollectionDefinition;
const identityAdmitted = normalizePluginAccountCollectionContractV1({
    pluginId: PLUGIN_ID,
    contribution: { ...identityCollectionDefinition, migrations: [] },
});
/** Only the row-id field is mode-derived; `status` stays an ordinary index. */
const rowIdOnlyIdentityDefinition = {
    ...collectionDefinition,
    identityFields: ['id'],
} satisfies PluginAccountCollectionDefinition;
const rowIdOnlyIdentityAdmitted = normalizePluginAccountCollectionContractV1({
    pluginId: PLUGIN_ID,
    contribution: { ...rowIdOnlyIdentityDefinition, migrations: [] },
});
const plainCredentials = { token: 'plain-token', encryption: null } satisfies StoredCredentials;
const encryptedMachineKey = new Uint8Array(32).fill(7);
const encryptedCredentials = {
    token: 'encrypted-token',
    encryption: {
        type: 'dataKey' as const,
        publicKey: tweetnacl.box.keyPair.fromSecretKey(encryptedMachineKey).publicKey,
        machineKey: encryptedMachineKey,
    },
} satisfies StoredCredentials;

function currentnessFor(credentials: StoredCredentials) {
    if (!credentials.encryption) {
        return {
            mode: 'plain' as const,
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const },
        };
    }
    const material = credentials.encryption.type === 'legacy'
        ? { type: 'legacy' as const, secret: credentials.encryption.secret }
        : { type: 'dataKey' as const, machineKey: credentials.encryption.machineKey };
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
        accountEncryptionMode: 'e2ee',
        material,
        ...(credentials.encryption.type === 'dataKey'
            ? { dataKeyPublicKey: credentials.encryption.publicKey }
            : {}),
    });
    return {
        mode: 'e2ee' as const,
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            snapshot.contentPublicKeyFingerprint,
        ),
        updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'available' as const },
    };
}

type HttpCall = Readonly<{ url: string; body: unknown }>;

/**
 * This is the real Account-row HTTP boundary, not a substitute for Account-KV
 * logic: it retains one opaque row and performs only the server-owned row CAS.
 * The bound SDK owner must enforce the public per-key versions above it.
 */
function createAccountKvWireStore(initialRow?: unknown) {
    let revision: number | 'absent' = initialRow === undefined ? 'absent' : 0;
    let content: unknown = initialRow === undefined
        ? null
        : { t: 'plain' as const, v: initialRow };

    return Object.freeze({
        async get(): Promise<Readonly<{ status: number; data: unknown }>> {
            if (revision === 'absent') return { status: 200, data: { status: 'absent' } };
            if (content === null) return { status: 200, data: { status: 'deleted', revision } };
            return { status: 200, data: { status: 'present', revision, content } };
        },
        async post(_url: string, body: string): Promise<Readonly<{ status: number; data: unknown }>> {
            const request = PluginAccountStorageMutationRequestV1Schema.parse(JSON.parse(body));
            if (request.expectedRevision !== revision) {
                return {
                    status: 200,
                    data: { status: 'conflict', revision: revision === 'absent' ? 0 : revision },
                };
            }
            revision = revision === 'absent' ? 0 : revision + 1;
            content = request.content;
            return { status: 200, data: { status: 'updated', revision } };
        },
    });
}

function bindHost(params: Readonly<{
    contracts?: readonly NormalizedPluginAccountCollectionContractV1[];
    credentials?: StoredCredentials;
    get?: (url: string) => Promise<Readonly<{ status: number; data: unknown }>>;
    post: (url: string, body: string) => Promise<Readonly<{ status: number; data: unknown }>>;
    currentness?: (credentials: StoredCredentials) => AccountEncryptionCurrentnessResponse;
    isCurrentAccount?: () => boolean;
    subscribeChanges?: (
        subscription: Readonly<{
            accountScopeKey: string;
            pluginId: string;
            collectionId: string;
            contractDigest: string;
            startingCursor?: number;
        }>,
        listener: (hint: PluginAccountCollectionWatchInvalidation) => void,
    ) => () => void;
    randomBytes?: (length: number) => Uint8Array;
    resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
    signal?: AbortSignal;
    isOccurrenceCurrent?: () => boolean;
}>) {
    // Keep the test boundary forward-compatible while the host consumes this
    // optional daemon-cached capability. The production dependency remains
    // typed at its canonical host owner.
    const featureSnapshotDependency: Record<string, unknown> = params.resolveServerFeaturesSnapshot
        ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }
        : {};
    const host = createAccountPluginDataStorageHost({
        contracts: params.contracts ?? [admitted],
        readCredentials: async () => params.credentials ?? plainCredentials,
        isCurrentAccount: params.isCurrentAccount ?? (() => true),
        resolveAccountScopeKey: () => ACCOUNT_SCOPE_KEY,
        resolveBaseUrl: () => 'https://data.example.test',
        resolveAccountEncryptionCurrentness: async (credentials) => (
            params.currentness?.(credentials) ?? currentnessFor(credentials)
        ),
        http: {
            get: async (url) => params.get
                ? await params.get(url)
                : url.endsWith('/v1/plugins/data/get')
                    ? { status: 200, data: { row: null, absenceEpoch: 0 } }
                    : { status: 200, data: { mode: params.credentials?.encryption ? 'e2ee' : 'plain', updatedAt: 1 } },
            post: async (url, body) => url.endsWith('/v1/plugins/data/get')
                ? params.get
                    ? await params.get(url)
                    : { status: 200, data: { row: null, absenceEpoch: 0 } }
                : await params.post(url, body),
        },
        ...featureSnapshotDependency,
        ...(params.subscribeChanges ? { subscribeChanges: params.subscribeChanges } : {}),
        ...(params.randomBytes ? { randomBytes: params.randomBytes } : {}),
    });
    const controller = new AbortController();
    const account = host.bind({
        pluginId: PLUGIN_ID,
        occurrenceId: '1',
        signal: params.signal ?? controller.signal,
        isOccurrenceCurrent: params.isOccurrenceCurrent ?? (() => true),
    });
    if (!account) throw new Error('Expected Account Data host binding');
    return account;
}

describe('Account plugin Data storage host', () => {
    it('retains a static Collection binding without losing declaration or occurrence admission', async () => {
        const controller = new AbortController();
        const post = vi.fn(async () => ({ status: 200, data: { row: null, absenceEpoch: 0 } }));
        const account = bindHost({ signal: controller.signal, post });
        const collection = account.collection(collectionDefinition);
        // Polling callers repeatedly resolve the same readonly declaration. Its
        // bound schema/validator belong to this occurrence, not each wake.
        for (let wake = 0; wake < 10; wake++) {
            expect(account.collection(collectionDefinition)).toBe(collection);
        }
        const forged = { ...collectionDefinition, schemaVersion: 2 };
        await expect(account.collection(forged).get('task-1')).rejects.toMatchObject({ code: 'plugin_collection_undeclared' });
        await expect(collection.get('task-1')).resolves.toBeNull();
        controller.abort();
        await expect(account.collection(collectionDefinition).get('task-1')).rejects.toMatchObject({ code: 'plugin_collection_cancelled' });
        const next = bindHost({ post });
        expect(next.collection(collectionDefinition)).not.toBe(collection);
        await expect(next.collection(collectionDefinition).get('task-1')).resolves.toBeNull();
    });

    it.each([plainCredentials, encryptedCredentials])('settles issued Account KV writes without replay for $token', async (credentials) => {
        for (const settlement of ['cancelled', 'retired', 'accountChanged', 'lost', 'malformed', 'conflict'] as const) {
            const wire = createAccountKvWireStore();
            const controller = new AbortController();
            let generationCurrent = true;
            let accountCurrent = true;
            let callbackCount = 0;
            let writeCount = 0;
            const account = bindHost({
                credentials,
                signal: controller.signal,
                isOccurrenceCurrent: () => generationCurrent,
                isCurrentAccount: () => accountCurrent,
                get: wire.get,
                post: async (url, body) => {
                    writeCount += 1;
                    const response = settlement === 'conflict'
                        ? { status: 200, data: { status: 'conflict', revision: 3 } }
                        : await wire.post(url, body);
                    if (settlement === 'cancelled' || settlement === 'conflict') controller.abort();
                    if (settlement === 'retired') generationCurrent = false;
                    if (settlement === 'accountChanged') accountCurrent = false;
                    if (settlement === 'lost') throw new Error('Acknowledgement lost after commit');
                    if (settlement === 'malformed') return { status: 200, data: {} };
                    return response;
                },
            });
            const result = account.kv.transaction(async (transaction) => {
                callbackCount += 1;
                await transaction.set('endpoint', 'changed', { expectedVersion: 'absent' });
                return 'callback-result';
            });
            if (settlement === 'lost' || settlement === 'malformed') {
                await expect(result).rejects.toMatchObject({ code: 'plugin_account_storage_outcome_unknown', retryable: false });
            } else if (settlement === 'conflict') {
                await expect(result).rejects.toMatchObject({ code: 'plugin_account_kv_conflict' });
            } else {
                await expect(result).resolves.toBe('callback-result');
            }
            expect(callbackCount).toBe(1);
            expect(writeCount).toBe(1);
            const retained = await wire.get();
            expect(retained.data).toMatchObject(settlement === 'conflict'
                ? { status: 'absent' }
                : { status: 'present', revision: 0 });
        }
    });

    it('omits Account Data before Account-lifetime admission while retaining typed errors after a bound scope moves', async () => {
        let accountScopeKey: string | null = null;
        const host = createAccountPluginDataStorageHost({
            contracts: [admitted],
            readCredentials: async () => plainCredentials,
            isCurrentAccount: () => accountScopeKey === 'account-a',
            resolveAccountScopeKey: () => accountScopeKey,
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: async (credentials) => currentnessFor(credentials),
            http: {
                get: async () => {
                    throw new Error('Account Data must reject before a transport read');
                },
                post: async () => {
                    throw new Error('Account Data must reject before a transport write');
                },
            },
        });
        const controller = new AbortController();
        const binding = {
            pluginId: PLUGIN_ID,
            occurrenceId: '1',
            signal: controller.signal,
            isOccurrenceCurrent: () => true,
        } as const;

        expect(host.bind(binding)).toBeNull();

        accountScopeKey = 'account-a';
        const account = host.bind(binding);
        if (!account) throw new Error('Expected Account Data after Account-lifetime admission');

        accountScopeKey = null;
        await expect(account.kv.get('cursor')).rejects.toMatchObject({
            code: 'plugin_account_storage_unavailable',
        } satisfies Partial<PluginError>);
    });

    it('does not seal or mutate a Collection with stale local E2EE material', async () => {
        const post = vi.fn(async () => ({
            status: 200,
            data: {
                status: 'updated',
                results: [{ rowId: 'task-1', revision: 1, deleted: false }],
                changeCursor: 1,
            },
        }));
        const randomBytes = vi.fn((length: number) => new Uint8Array(length).fill(3));
        const account = bindHost({
            credentials: encryptedCredentials,
            currentness: () => ({
                ...currentnessFor(encryptedCredentials),
                contentKeyFingerprint: 'aemk1_stale-content-key',
            }),
            get: async (url) => {
                if (url.endsWith('/v1/account/encryption')) {
                    return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
                }
                throw new Error(`Unexpected Account Data GET: ${url}`);
            },
            post,
            randomBytes,
        });

        await expect(account.collection(collectionDefinition).put({
            id: 'task-1',
            status: 'open',
            privateNote: 'must not be sealed with a stale key',
        }, { expectedRevision: 'absent' })).rejects.toMatchObject({
            code: 'plugin_account_storage_unavailable',
        } satisfies Partial<PluginError>);
        expect(randomBytes).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it('does not seal or mutate Account KV with stale local E2EE material', async () => {
        const post = vi.fn(async () => ({
            status: 200,
            data: { status: 'updated', revision: 1 },
        }));
        const randomBytes = vi.fn((length: number) => new Uint8Array(length).fill(3));
        const account = bindHost({
            credentials: encryptedCredentials,
            currentness: () => ({
                ...currentnessFor(encryptedCredentials),
                contentKeyFingerprint: 'aemk1_stale-content-key',
            }),
            get: async (url) => {
                if (url.endsWith('/v1/account/encryption')) {
                    return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
                }
                if (url.includes('/v1/account/plugin-storage/')) {
                    return { status: 200, data: { status: 'absent' } };
                }
                throw new Error(`Unexpected Account Data GET: ${url}`);
            },
            post,
            randomBytes,
        });

        await expect(account.kv.set('cursor', { value: 'must not be sealed with a stale key' }, {
            expectedVersion: 'absent',
        })).rejects.toMatchObject({
            code: 'plugin_account_storage_unavailable',
        } satisfies Partial<PluginError>);
        expect(randomBytes).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it('rechecks E2EE currentness immediately before sealing an Account KV write', async () => {
        let currentnessRequests = 0;
        const post = vi.fn(async () => ({
            status: 200,
            data: { status: 'updated', revision: 1 },
        }));
        const randomBytes = vi.fn((length: number) => new Uint8Array(length).fill(3));
        const account = bindHost({
            credentials: encryptedCredentials,
            currentness: () => {
                currentnessRequests += 1;
                return currentnessRequests === 1
                    ? currentnessFor(encryptedCredentials)
                    : {
                        ...currentnessFor(encryptedCredentials),
                        contentKeyFingerprint: 'aemk1_stale-content-key',
                    };
            },
            get: async (url) => {
                if (url.includes('/v1/account/plugin-storage/')) {
                    return { status: 200, data: { status: 'absent' } };
                }
                throw new Error(`Unexpected Account Data GET: ${url}`);
            },
            post,
            randomBytes,
        });

        await expect(account.kv.set('cursor', { value: 'must be rechecked before sealing' }, {
            expectedVersion: 'absent',
        })).rejects.toMatchObject({
            code: 'plugin_account_storage_unavailable',
        } satisfies Partial<PluginError>);
        expect(currentnessRequests).toBe(2);
        expect(randomBytes).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it('keeps a plain Account keyless while writing a Collection', async () => {
        const post = vi.fn(async () => ({
            status: 200,
            data: {
                status: 'updated',
                results: [{ rowId: 'task-plain', revision: 1, deleted: false }],
                changeCursor: 1,
            },
        }));
        const account = bindHost({
            post,
        });

        await expect(account.collection(collectionDefinition).put({
            id: 'task-plain',
            status: 'open',
            privateNote: 'plain payload',
        }, { expectedRevision: 'absent' })).resolves.toMatchObject({
            rowId: 'task-plain',
            revision: 1,
        });
        expect(post).toHaveBeenCalledOnce();
    });

    it('writes Account KV when the current E2EE key fingerprint matches local material', async () => {
        const post = vi.fn(async () => ({
            status: 200,
            data: { status: 'updated', revision: 1 },
        }));
        const account = bindHost({
            credentials: encryptedCredentials,
            currentness: () => currentnessFor(encryptedCredentials),
            get: async (url) => {
                if (url.endsWith('/v1/account/encryption')) {
                    return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
                }
                if (url.includes('/v1/account/plugin-storage/')) {
                    return { status: 200, data: { status: 'absent' } };
                }
                throw new Error(`Unexpected Account Data GET: ${url}`);
            },
            post,
        });

        await expect(account.kv.set('cursor', { value: 'current key' }, {
            expectedVersion: 'absent',
        })).resolves.toEqual({ version: 0 });
        expect(post).toHaveBeenCalledOnce();
    });

    it('rejects an identity tag request for a field the collection contract does not declare', async () => {
        const calls: HttpCall[] = [];
        const account = bindHost({
            post: async (url, body) => {
                calls.push({ url, body: JSON.parse(body) });
                return { status: 200, data: { status: 'updated', results: [], changeCursor: 1 } };
            },
        });
        const collection = account.collection(collectionDefinition);

        await expect(collection.identityTag({ field: 'privateNote', components: ['scope', '42'] }))
            .rejects.toMatchObject({ code: 'plugin_collection_invalid_value' } satisfies Partial<PluginError>);
        expect(calls).toEqual([]);
    });

    it('rejects an identity tag request for an index field the contract does not declare as mode-derived identity', async () => {
        // `identityFields` is what the Account transition owner reads to decide
        // that a row cannot be relocated across a mode change. Minting a tag for
        // a field outside that declaration produces a mode-bound value the
        // transition owner cannot see, so the row is silently rekeyed past and
        // left at an address its plugin can no longer derive.
        const calls: HttpCall[] = [];
        const account = bindHost({
            contracts: [rowIdOnlyIdentityAdmitted],
            post: async (url, body) => {
                calls.push({ url, body: JSON.parse(body) });
                return { status: 200, data: { status: 'updated', results: [], changeCursor: 1 } };
            },
        });
        const collection = account.collection(rowIdOnlyIdentityDefinition);

        await expect(collection.identityTag({ field: 'status', components: ['scope', '42'] }))
            .rejects.toMatchObject({ code: 'plugin_collection_invalid_value' } satisfies Partial<PluginError>);
        await expect(collection.identityTag({ field: 'id', components: ['scope', '42'] }))
            .resolves.toEqual(expect.any(String));
        expect(calls).toEqual([]);
    });

    it('stamps the bound plugin and collection into every declared-field identity tag', async () => {
        const account = bindHost({
            contracts: [identityAdmitted],
            post: async () => ({ status: 200, data: {} }),
        });
        const collection = account.collection(identityCollectionDefinition);

        const rowIdTag = await collection.identityTag({ field: 'id', components: ['scope', '42'] });
        const indexTag = await collection.identityTag({ field: 'status', components: ['scope', '42'] });

        expect(rowIdTag).toBe(derivePluginCollectionIdentityTagV1({
            accountEncryptionMode: 'plain',
            material: null,
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            field: 'id',
            components: ['scope', '42'],
        }));
        expect(indexTag).not.toBe(rowIdTag);
        expect(rowIdTag).not.toBe(derivePluginCollectionIdentityTagV1({
            accountEncryptionMode: 'plain',
            material: null,
            pluginId: 'example.other',
            collectionId: COLLECTION_ID,
            field: 'id',
            components: ['scope', '42'],
        }));
    });

    it('derives the account-keyed identity tag arm on an E2EE Account', async () => {
        const account = bindHost({
            contracts: [identityAdmitted],
            credentials: encryptedCredentials,
            post: async () => ({ status: 200, data: {} }),
        });

        const tag = await account.collection(identityCollectionDefinition)
            .identityTag({ field: 'id', components: ['scope', '42'] });

        expect(tag).toBe(derivePluginCollectionIdentityTagV1({
            accountEncryptionMode: 'e2ee',
            material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            field: 'id',
            components: ['scope', '42'],
        }));
    });

    it('binds an executable migration definition to its exact static contract', async () => {
        const migratedDefinition = {
            ...collectionDefinition,
            schemaVersion: 2,
            readableSchemaVersions: [1],
            migrations: [{
                id: 'upgrade-v1-to-v2',
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
                migrate: (value) => value,
            }],
        } satisfies PluginAccountCollectionDefinition;
        const migratedContribution = {
            ...contribution,
            schemaVersion: 2,
            readableSchemaVersions: [1],
            migrations: [{
                id: 'upgrade-v1-to-v2',
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
            }],
        } satisfies PluginAccountCollectionContributionV1;
        const migratedContract = normalizePluginAccountCollectionContractV1({
            pluginId: PLUGIN_ID,
            contribution: migratedContribution,
        });
        const calls: HttpCall[] = [];
        const account = bindHost({
            contracts: [migratedContract],
            post: async (url, body) => {
                calls.push({ url, body: JSON.parse(body) });
                return {
                    status: 200,
                    data: {
                        status: 'updated',
                        results: [{ rowId: 'task-1', revision: 4, deleted: false }],
                        changeCursor: 12,
                    },
                };
            },
        });

        await expect(account.collection(migratedDefinition).put({
            id: 'task-1',
            status: 'open',
            privateNote: 'migrated',
        }, { expectedRevision: 'absent' })).resolves.toMatchObject({
            rowId: 'task-1',
            revision: 4,
        });
        expect(calls).toEqual([expect.objectContaining({
            url: 'https://data.example.test/v1/plugins/data/mutate',
            body: expect.objectContaining({
                writerContext: {
                    schemaVersion: migratedContract.schemaVersion,
                    contractDigest: migratedContract.contractDigest,
                },
            }),
        })]);
    });

    it('rejects an unadmitted declaration and stamps the admitted identity, writer context, and logical split', async () => {
        const calls: HttpCall[] = [];
        const account = bindHost({
            post: async (url, body) => {
                calls.push({ url, body: JSON.parse(body) });
                return {
                    status: 200,
                    data: {
                        status: 'updated',
                        results: [{ rowId: 'task-1', revision: 4, deleted: false }],
                        changeCursor: 12,
                    },
                };
            },
        });
        const forged = {
            ...collectionDefinition,
            schemaVersion: 2,
        } satisfies PluginAccountCollectionDefinition;

        await expect(account.collection(forged).get('task-1')).rejects.toMatchObject({
            code: 'plugin_collection_undeclared',
        } satisfies Partial<PluginError>);
        expect(calls).toEqual([]);

        await expect(account.collection(collectionDefinition).put({
            id: 'task-1',
            status: 'open',
            privateNote: 'keep private',
        }, { expectedRevision: 'absent' })).resolves.toEqual({
            rowId: 'task-1',
            revision: 4,
            value: {
                id: 'task-1',
                status: 'open',
                privateNote: 'keep private',
            },
        });

        expect(calls).toEqual([{
            url: 'https://data.example.test/v1/plugins/data/mutate',
            body: {
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                writerContext: {
                    schemaVersion: admitted.schemaVersion,
                    contractDigest: admitted.contractDigest,
                },
                operations: [{
                    kind: 'put',
                    rowId: 'task-1',
                    expectedRevision: 'absent',
                    expectedAbsenceEpoch: 0,
                    content: { t: 'plain', v: { privateNote: 'keep private' } },
                    projection: { status: 'open' },
                }],
            },
        }]);
    });

    describe('release-less Account declaration claim', () => {
        const CLAIM_URL = 'https://data.example.test/v1/plugins/availability/collection-writers/claim';
        const declaredManifest = PluginManifestV2Schema.parse({
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: '1.4.0',
            displayName: 'Tasks',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: { accountCollections: [contribution] },
        });

        function claimingHost(params: Readonly<{
            contracts?: readonly NormalizedPluginAccountCollectionContractV1[];
            resolveReleaseLessDeclaration?: (pluginId: string) => ParsedPluginManifestV2 | null;
            scopeKey: () => string;
            post: (url: string, body: string) => Promise<Readonly<{ status: number; data: unknown }>>;
        }>) {
            const host = createAccountPluginDataStorageHost({
                contracts: params.contracts ?? [admitted],
                readCredentials: async () => plainCredentials,
                isCurrentAccount: () => true,
                resolveAccountScopeKey: params.scopeKey,
                resolveBaseUrl: () => 'https://data.example.test',
                resolveAccountEncryptionCurrentness: async (credentials) => currentnessFor(credentials),
                ...(params.resolveReleaseLessDeclaration
                    ? { resolveReleaseLessDeclaration: params.resolveReleaseLessDeclaration }
                    : {}),
                http: {
                    get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
                    post: params.post,
                },
            });
            return () => {
                const account = host.bind({
                    pluginId: PLUGIN_ID,
                    occurrenceId: '1',
                    signal: new AbortController().signal,
                    isOccurrenceCurrent: () => true,
                });
                if (!account) throw new Error('Expected Account Data host binding');
                return account;
            };
        }

        function recordingPost(
            calls: string[],
            claimResponse = { status: 200, data: {} as unknown },
            manifest: ParsedPluginManifestV2 = declaredManifest,
        ) {
            return async (url: string, body: string) => {
                calls.push(url);
                if (url === CLAIM_URL) {
                    // The claim carries exactly the admitted manifest; the
                    // server derives Collections and the declaration from it.
                    expect(JSON.parse(body)).toEqual({ manifest: JSON.parse(JSON.stringify(manifest)) });
                    return claimResponse;
                }
                return { status: 200, data: { row: null, absenceEpoch: 0 } };
            };
        }

        it('claims a daemon-selected plugin declaration once per Account before its first Collection operation', async () => {
            const calls: string[] = [];
            let scopeKey = 'account-a';
            const bind = claimingHost({
                resolveReleaseLessDeclaration: (pluginId) => (pluginId === PLUGIN_ID ? declaredManifest : null),
                scopeKey: () => scopeKey,
                post: recordingPost(calls),
            });

            const account = bind();
            await account.collection(collectionDefinition).get('task-1');
            await bind().collection(collectionDefinition).get('task-2');
            expect(calls.filter((url) => url === CLAIM_URL)).toHaveLength(1);
            expect(calls.indexOf(CLAIM_URL)).toBeLessThan(
                calls.indexOf('https://data.example.test/v1/plugins/data/get'),
            );

            scopeKey = 'account-b';
            await bind().collection(collectionDefinition).get('task-3');
            expect(calls.filter((url) => url === CLAIM_URL)).toHaveLength(2);
        });

        it('claims at activation for a plugin whose only Account declarations are webhooks or Events', async () => {
            const eventOnlyManifest = PluginManifestV2Schema.parse({
                ...declaredManifest,
                contributes: {
                    events: [{
                        id: 'message-received',
                        kind: 'event',
                        title: 'Message received',
                        payloadSchema: { type: 'object', additionalProperties: false },
                    }],
                },
            });
            const calls: string[] = [];
            const bind = claimingHost({
                contracts: [],
                resolveReleaseLessDeclaration: () => eventOnlyManifest,
                scopeKey: () => 'account-a',
                post: recordingPost(calls, { status: 200, data: {} }, eventOnlyManifest),
            });

            bind();
            await vi.waitFor(() => expect(calls).toEqual([CLAIM_URL]));
        });

        it('retries a failed claim on the next operation without failing the operation itself', async () => {
            const calls: string[] = [];
            let failClaim = true;
            const bind = claimingHost({
                resolveReleaseLessDeclaration: () => declaredManifest,
                scopeKey: () => 'account-a',
                post: async (url, body) => {
                    if (url === CLAIM_URL && failClaim) {
                        calls.push(url);
                        failClaim = false;
                        return { status: 503, data: {} };
                    }
                    return await recordingPost(calls)(url, body);
                },
            });

            const collection = bind().collection(collectionDefinition);
            await expect(collection.get('task-1')).resolves.toBeNull();
            await collection.get('task-2');
            await collection.get('task-3');
            expect(calls.filter((url) => url === CLAIM_URL)).toHaveLength(2);
        });

        it('never claims for a managed portable plugin', async () => {
            const calls: string[] = [];
            const bind = claimingHost({
                resolveReleaseLessDeclaration: () => null,
                scopeKey: () => 'account-a',
                post: recordingPost(calls),
            });

            await bind().collection(collectionDefinition).get('task-1');
            expect(calls).not.toContain(CLAIM_URL);
        });
    });

    it('observes Collection absence immediately before an absent create and stamps that exact epoch', async () => {
        const calls: HttpCall[] = [];
        const account = bindHost({
            get: async (url) => url.endsWith('/v1/plugins/data/get')
                ? { status: 200, data: { row: null, absenceEpoch: 17 } }
                : { status: 200, data: { mode: 'plain', updatedAt: 1 } },
            post: async (url, body) => {
                calls.push({ url, body: JSON.parse(body) });
                return {
                    status: 200,
                    data: {
                        status: 'updated',
                        results: [{ rowId: 'task-epoch', revision: 1, deleted: false }],
                        changeCursor: 1,
                    },
                };
            },
        });

        await expect(account.collection(collectionDefinition).put({
            id: 'task-epoch',
            status: 'open',
            privateNote: 'new row',
        }, { expectedRevision: 'absent' })).resolves.toMatchObject({
            rowId: 'task-epoch',
            revision: 1,
        });

        expect(calls).toEqual([{
            url: 'https://data.example.test/v1/plugins/data/mutate',
            body: expect.objectContaining({
                operations: [expect.objectContaining({
                    rowId: 'task-epoch',
                    expectedRevision: 'absent',
                    expectedAbsenceEpoch: 17,
                })],
            }),
        }]);
    });

    it('replays a response-lost exact forget as the same single idempotent request', async () => {
        let forgetAttempts = 0;
        const calls: HttpCall[] = [];
        const account = bindHost({
            get: async (url) => {
                if (url.endsWith('/v1/plugins/data/get')) {
                    throw new Error('Retention forget read Collection currentness');
                }
                return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            },
            post: async (url, body) => {
                calls.push({ url, body: JSON.parse(body) });
                if (!url.endsWith('/v1/plugins/data/forget')) {
                    throw new Error(`Unexpected Collection mutation: ${url}`);
                }
                forgetAttempts += 1;
                // The server committed the exact delete but the response did
                // not reach this client. A later exact retry must use the
                // server's idempotent historical-identity result, never write.
                if (forgetAttempts === 1) throw new Error('response lost after commit');
                return { status: 200, data: { status: 'forgotten' } };
            },
        });
        const collection = account.collection(collectionDefinition);

        await expect(collection.forget('task-retained', { expectedRevision: 4 })).rejects.toMatchObject({
            code: 'plugin_collection_outcome_unknown',
            retryable: false,
        } satisfies Partial<PluginError>);
        await expect(collection.forget('task-retained', { expectedRevision: 4 })).resolves.toEqual({
            rowId: 'task-retained',
            forgotten: true,
        });
        expect(calls.map(({ body }) => body)).toEqual([
            {
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                writerContext: expect.any(Object),
                rowId: 'task-retained',
                expectedRevision: 4,
            },
            {
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                writerContext: expect.any(Object),
                rowId: 'task-retained',
                expectedRevision: 4,
            },
        ]);
    });

    it('reports one exact-revision forget conflict rather than re-reading a row a direct read cannot show', async () => {
        const post = vi.fn(async () => ({ status: 200, data: { status: 'conflict' } }));
        const account = bindHost({
            // A newer tombstone is invisible to the direct reader, so a
            // freshness read can never resolve this conflict: retrying it would
            // never terminate. The exact-revision answer is final.
            get: async (url) => {
                if (url.endsWith('/v1/plugins/data/get')) {
                    throw new Error('Retention forget read Collection currentness');
                }
                return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            },
            post,
        });

        await expect(account.collection(collectionDefinition).forget('task-recreated', {
            expectedRevision: 4,
        })).rejects.toMatchObject({
            code: 'plugin_collection_conflict',
        } satisfies Partial<PluginError>);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('atomically retires an exact live row through the Collection owner', async () => {
        const post = vi.fn(async () => ({ status: 200, data: { status: 'forgotten' } }));
        const bindRetentionHost = () => bindHost({
            get: async (url) => {
                if (url.endsWith('/v1/plugins/data/get')) {
                    throw new Error('Retention forget read Collection currentness');
                }
                return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            },
            post,
        });

        await expect(bindRetentionHost().collection(collectionDefinition).forget('task-live', {
            expectedRevision: 4,
        })).resolves.toEqual({ rowId: 'task-live', forgotten: true });
        expect(post).toHaveBeenCalledTimes(1);

        await expect(bindRetentionHost().collection(collectionDefinition).forget('task-deleted', {
            expectedRevision: 4,
        })).resolves.toEqual({ rowId: 'task-deleted', forgotten: true });
    });

    it('propagates cancellation before a Collection forget can read or mutate', async () => {
        const get = vi.fn(async () => ({ status: 200, data: { row: null, absenceEpoch: 0 } }));
        const post = vi.fn(async () => ({ status: 200, data: { status: 'forgotten' } }));
        const account = bindHost({ get, post });
        const controller = new AbortController();
        controller.abort();

        await expect(account.collection(collectionDefinition).forget('task-cancelled', {
            expectedRevision: 4,
            signal: controller.signal,
        })).rejects.toMatchObject({
            code: 'plugin_collection_cancelled',
        } satisfies Partial<PluginError>);
        expect(get).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it('serializes a live-row batch assertion without turning it into a write', async () => {
        const calls: HttpCall[] = [];
        const account = bindHost({
            post: async (url, body) => {
                calls.push({ url, body: JSON.parse(body) });
                return {
                    status: 200,
                    data: {
                        status: 'updated',
                        results: [{ rowId: 'task-written', revision: 1, deleted: false }],
                        changeCursor: 13,
                    },
                };
            },
        });

        await expect(account.collection(collectionDefinition).batch([
            { kind: 'assert', rowId: 'task-current', expectedRevision: 3 },
            {
                kind: 'put',
                value: { id: 'task-written', status: 'open', privateNote: 'write only this row' },
                expectedRevision: 'absent',
            },
        ])).resolves.toEqual({
            status: 'updated',
            results: [{ rowId: 'task-written', revision: 1, deleted: false }],
            changeCursor: 13,
        });

        expect(calls).toEqual([{
            url: 'https://data.example.test/v1/plugins/data/mutate',
            body: {
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                writerContext: {
                    schemaVersion: admitted.schemaVersion,
                    contractDigest: admitted.contractDigest,
                },
                operations: [
                    { kind: 'assert', rowId: 'task-current', expectedRevision: 3 },
                    {
                        kind: 'put',
                        rowId: 'task-written',
                        expectedRevision: 'absent',
                        expectedAbsenceEpoch: 0,
                        content: { t: 'plain', v: { privateNote: 'write only this row' } },
                        projection: { status: 'open' },
                    },
                ],
            },
        }]);
    });

    it('uses the dedicated Collection cipher domain and only wakes the matching admitted collection', async () => {
        const changeSubscription: {
            listener: ((hint: PluginAccountCollectionWatchInvalidation) => void) | null;
        } = { listener: null };
        const post = vi.fn(async (_url: string, _body: string) => ({
            status: 200,
            data: {
                status: 'updated',
                results: [{ rowId: 'task-2', revision: 1, deleted: false }],
                changeCursor: 13,
            },
        }));
        const account = bindHost({
            credentials: encryptedCredentials,
            post,
            randomBytes: (length) => new Uint8Array(length).fill(3),
            subscribeChanges(_subscription, listener) {
                changeSubscription.listener = listener;
                return () => { changeSubscription.listener = null; };
            },
        });
        const collection = account.collection(collectionDefinition);
        const invalidations: unknown[] = [];
        const watcher = collection.watch({ kind: 'collection' }, (invalidation) => invalidations.push(invalidation));

        await collection.put({
            id: 'task-2',
            status: 'closed',
            privateNote: 'encrypted private field',
        }, { expectedRevision: 'absent' });

        const request = JSON.parse(post.mock.calls[0]?.[1] ?? 'null') as Readonly<{ operations: readonly Readonly<{
            content: Readonly<{ t: string; c?: string }>;
        }>[] }>;
        const ciphertext = request.operations[0]?.content.c;
        expect(ciphertext).toEqual(expect.any(String));
        expect(openPluginCollectionPrivatePayloadV1({
            material: { type: 'dataKey', machineKey: encryptedCredentials.encryption.machineKey },
            ciphertext: ciphertext!,
        })).toEqual({ privateNote: 'encrypted private field' });

        const emitChange = changeSubscription.listener;
        if (!emitChange) throw new Error('Expected AccountChange subscription');
        emitChange({
            accountScopeKey: ACCOUNT_SCOPE_KEY,
            kind: 'collection',
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            contractDigest: admitted.contractDigest,
            changeCursor: 17,
        });
        emitChange({
            accountScopeKey: ACCOUNT_SCOPE_KEY,
            kind: 'collection',
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            contractDigest: 'A'.repeat(43),
            changeCursor: 18,
        });
        emitChange({ accountScopeKey: ACCOUNT_SCOPE_KEY, kind: 'reset', changeCursor: 19 });
        watcher.dispose();

        expect(invalidations).toEqual([
            { kind: 'changed', changeCursor: 17 },
            { kind: 'reset', changeCursor: 19 },
        ]);
    });

    it('preserves only the bounded relation-resolution continuation on a restricted delete', async () => {
        const account = bindHost({
            post: async () => ({
                status: 409,
                data: {
                    error: 'collection_relation_restricted',
                    dependentCount: 1,
                    continuation: {
                        pluginId: PLUGIN_ID,
                        collectionId: COLLECTION_ID,
                        relationId: 'project',
                        target: { collectionId: 'projects', rowId: 'project-1' },
                        query: {
                            indexId: 'by-status',
                            prefix: ['project-1'],
                            order: 'asc',
                            limit: 200,
                        },
                    },
                },
            }),
        });

        await expect(account.collection(collectionDefinition).delete('task-1', {
            expectedRevision: 1,
        })).rejects.toMatchObject({
            code: 'collection_relation_restricted',
            details: {
                dependentCount: 1,
                continuation: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    relationId: 'project',
                    target: { collectionId: 'projects', rowId: 'project-1' },
                    query: {
                        indexId: 'by-status',
                        prefix: ['project-1'],
                        order: 'asc',
                        limit: 200,
                    },
                },
            },
        } satisfies Partial<PluginError>);
    });

    it('rejects a known-over-limit Collection batch before issuing its mutation request', async () => {
        const post = vi.fn(async () => ({
            status: 200,
            data: {
                status: 'updated',
                results: [
                    { rowId: 'task-1', revision: 1, deleted: false },
                    { rowId: 'task-2', revision: 1, deleted: false },
                ],
                changeCursor: 1,
            },
        }));
        const account = bindHost({
            post,
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {},
                    capabilities: {
                        pluginDataCollections: {
                            maxRowEncodedBytes: 512 * 1024,
                            maxBatchBytes: 1024 * 1024,
                            maxBatchRows: 1,
                            maxAccountRows: 100,
                            maxAccountBytes: 2 * 1024 * 1024,
                        },
                    },
                }),
            }),
        });

        await expect(account.collection(collectionDefinition).batch([
            {
                kind: 'put',
                value: { id: 'task-1', status: 'open', privateNote: 'first private note' },
                expectedRevision: 'absent',
            },
            {
                kind: 'put',
                value: { id: 'task-2', status: 'open', privateNote: 'second private note' },
                expectedRevision: 'absent',
            },
        ])).rejects.toMatchObject({
            code: 'collection_quota_incompatible',
            details: { dimension: 'maxBatchRows', effectiveMaximum: 1 },
        } satisfies Partial<PluginError>);
        expect(post).not.toHaveBeenCalled();
    });

    it('uses the parsed mutation request bytes for known batch-byte preflight', async () => {
        const post = vi.fn(async () => ({
            status: 200,
            data: {
                status: 'updated',
                results: [{ rowId: 'task-1', revision: 1, deleted: false }],
                changeCursor: 1,
            },
        }));
        const account = bindHost({
            post,
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {},
                    capabilities: {
                        pluginDataCollections: {
                            maxRowEncodedBytes: 1,
                            maxBatchBytes: 1,
                            maxBatchRows: 100,
                            maxAccountRows: 100,
                            maxAccountBytes: 1,
                        },
                    },
                }),
            }),
        });

        await expect(account.collection(collectionDefinition).put({
            id: 'task-1',
            status: 'open',
            privateNote: 'private',
        }, { expectedRevision: 'absent' })).rejects.toMatchObject({
            code: 'collection_quota_incompatible',
            details: { dimension: 'maxBatchBytes', effectiveMaximum: 1 },
        } satisfies Partial<PluginError>);
        expect(post).not.toHaveBeenCalled();
    });

    it('reports the deployment-effective Collection limits a plugin must plan against', async () => {
        const account = bindHost({
            post: async () => {
                throw new Error('Reading Collection limits must not issue a request');
            },
            resolveServerFeaturesSnapshot: () => ({
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
            }),
        });

        await expect(account.collection(collectionDefinition).limits()).resolves.toEqual({
            maxRowEncodedBytes: 256 * 1024,
            maxRows: 5_000,
            maxCollectionEncodedBytes: 64 * 1024 * 1024,
            maxBatchBytes: 4 * 1024 * 1024,
            maxBatchRows: 40,
            maxAccountRows: 5_000,
            maxAccountBytes: 64 * 1024 * 1024,
            basis: 'deployment',
        });
    });

    it('narrows the deployment Collection limits by the admitted contract quota', async () => {
        const quotaAdmitted = normalizePluginAccountCollectionContractV1({
            pluginId: PLUGIN_ID,
            contribution: {
                ...contribution,
                quota: { maxRows: 250, maxRowEncodedBytes: 32 * 1024 },
            },
        });
        const account = bindHost({
            contracts: [quotaAdmitted],
            post: async () => {
                throw new Error('Reading Collection limits must not issue a request');
            },
            resolveServerFeaturesSnapshot: () => ({
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
            }),
        });

        await expect(account.collection({
            ...collectionDefinition,
            quota: { maxRows: 250, maxRowEncodedBytes: 32 * 1024 },
        }).limits()).resolves.toMatchObject({
            maxRowEncodedBytes: 32 * 1024,
            maxRows: 250,
            maxAccountRows: 5_000,
            maxBatchRows: 40,
            basis: 'deployment',
        });
    });

    it('falls back to the shipped deployment policy when no capability is published', async () => {
        const account = bindHost({
            post: async () => {
                throw new Error('Reading Collection limits must not issue a request');
            },
            resolveServerFeaturesSnapshot: () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
        });

        await expect(account.collection(collectionDefinition).limits()).resolves.toEqual({
            ...PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
            maxRows: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountRows,
            maxCollectionEncodedBytes: PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1.maxAccountBytes,
            basis: 'default',
        });
    });

    it('measures a candidate batch through the same sealed request the mutation sends', async () => {
        const sentRequests: unknown[] = [];
        const account = bindHost({
            credentials: encryptedCredentials,
            post: async (_url, body) => {
                sentRequests.push(JSON.parse(body));
                return {
                    status: 200,
                    data: {
                        status: 'updated',
                        results: [
                            { rowId: 'task-1', revision: 1, deleted: false },
                            { rowId: 'task-2', revision: 1, deleted: false },
                        ],
                        changeCursor: 1,
                    },
                };
            },
        });
        const collection = account.collection(collectionDefinition);
        const operations = [
            {
                kind: 'put' as const,
                value: { id: 'task-1', status: 'open' as const, privateNote: 'a'.repeat(8) },
                expectedRevision: 'absent' as const,
            },
            {
                kind: 'put' as const,
                value: { id: 'task-2', status: 'open' as const, privateNote: 'b'.repeat(250) },
                expectedRevision: 'absent' as const,
            },
        ];

        const measurement = await collection.measureBatch(operations);
        await collection.batch(operations);

        expect(measurement.operationEncodedBytes).toHaveLength(2);
        // The second row's private payload is far larger, and only a real seal
        // of the real envelope can show that on the wire.
        expect(measurement.operationEncodedBytes[1]!).toBeGreaterThan(
            measurement.operationEncodedBytes[0]! + 240,
        );
        const sentRequest = PluginCollectionMutationRequestV1Schema.parse(sentRequests[0]);
        expect(
            measurement.overheadEncodedBytes
            + measurement.operationEncodedBytes.reduce((total, bytes) => total + bytes, 0)
            - 1,
        ).toBe(measurePluginCollectionMutationRequestEncodedBytesV1(sentRequest));
    });

    it('measures more candidate operations than one atomic batch may carry', async () => {
        const account = bindHost({
            credentials: encryptedCredentials,
            post: async () => {
                throw new Error('Measuring a candidate batch must not issue a request');
            },
        });
        const operations = Array.from({ length: 256 }, (_, index) => ({
            kind: 'put' as const,
            value: {
                id: `task-${String(index).padStart(3, '0')}`,
                status: 'open' as const,
                privateNote: 'n'.repeat(120),
            },
            expectedRevision: 'absent' as const,
        }));

        const measurement = await account.collection(collectionDefinition).measureBatch(operations);

        expect(measurement.operationEncodedBytes).toHaveLength(256);
        expect(measurement.operationEncodedBytes.every((bytes) => bytes > 0)).toBe(true);
        expect(measurement.overheadEncodedBytes).toBeGreaterThan(0);
    });

    it('continues sending a Collection batch when no known server capability can reject it', async () => {
        const post = vi.fn(async () => ({
            status: 200,
            data: {
                status: 'updated',
                results: [
                    { rowId: 'task-1', revision: 1, deleted: false },
                    { rowId: 'task-2', revision: 1, deleted: false },
                ],
                changeCursor: 1,
            },
        }));
        const account = bindHost({
            post,
            resolveServerFeaturesSnapshot: () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
        });

        await expect(account.collection(collectionDefinition).batch([
            {
                kind: 'put',
                value: { id: 'task-1', status: 'open', privateNote: 'first private note' },
                expectedRevision: 'absent',
            },
            {
                kind: 'put',
                value: { id: 'task-2', status: 'open', privateNote: 'second private note' },
                expectedRevision: 'absent',
            },
        ])).resolves.toMatchObject({ status: 'updated' });
        expect(post).toHaveBeenCalledOnce();
    });

    it('preserves typed Collection quota errors from the server', async () => {
        const account = bindHost({
            post: async () => ({
                status: 409,
                data: {
                    error: 'collection_quota_incompatible',
                    dimension: 'maxAccountBytes',
                    effectiveMaximum: 1024,
                },
            }),
        });

        await expect(account.collection(collectionDefinition).put({
            id: 'task-1',
            status: 'open',
            privateNote: 'keep private',
        }, { expectedRevision: 'absent' })).rejects.toMatchObject({
            code: 'collection_quota_incompatible',
            details: { dimension: 'maxAccountBytes', effectiveMaximum: 1024 },
        } satisfies Partial<PluginError>);
    });

    it('keeps per-key conditional versions independent of a newer whole Account row', async () => {
        const wire = createAccountKvWireStore({
            v: 1,
            values: {
                first: { version: 0, value: 'initial-first' },
                other: { version: 0, value: 'initial-other' },
            },
        });
        const firstReader = bindHost({ get: wire.get, post: wire.post });
        const secondReader = bindHost({ get: wire.get, post: wire.post });

        await expect(firstReader.kv.get('first')).resolves.toEqual({
            version: 0,
            value: 'initial-first',
        });
        await expect(secondReader.kv.get('first')).resolves.toEqual({
            version: 0,
            value: 'initial-first',
        });

        await expect(firstReader.kv.set('other', 'newer-other', {
            expectedVersion: 0,
        })).resolves.toEqual({ version: 1 });
        await expect(secondReader.kv.set('first', 'newer-first', {
            expectedVersion: 0,
        })).resolves.toEqual({ version: 1 });
        await expect(firstReader.kv.set('first', 'stale-first', {
            expectedVersion: 0,
        })).rejects.toMatchObject({
            code: 'plugin_account_kv_conflict',
        } satisfies Partial<PluginError>);
        await expect(firstReader.kv.get('first')).resolves.toEqual({
            version: 1,
            value: 'newer-first',
        });
    });

    /**
     * The Account row is the unit of contention. A concurrent writer that
     * touched only a disjoint logical key still conflicts the physical CAS, and
     * the daemon reports that typed conflict instead of re-reading and writing
     * a second time behind the author's back.
     */
    it('reports a typed conflict from one write when only a disjoint aggregate-row key changed', async () => {
        let reads = 0;
        const writes: unknown[] = [];
        const account = bindHost({
            get: async () => {
                reads += 1;
                return {
                    status: 200,
                    data: {
                        status: 'present' as const,
                        revision: 4,
                        content: {
                            t: 'plain' as const,
                            v: {
                                v: 1 as const,
                                values: {
                                    other: { version: 0, value: 'before' },
                                },
                            },
                        },
                    },
                };
            },
            post: async (_url, body) => {
                const request = PluginAccountStorageMutationRequestV1Schema.parse(JSON.parse(body));
                writes.push(request);
                return {
                    status: 200,
                    data: { status: 'conflict' as const, revision: 5 },
                };
            },
        });

        await expect(account.kv.set('target', 'mine', {
            expectedVersion: 'absent',
        })).rejects.toMatchObject({
            code: 'plugin_account_kv_conflict',
        } satisfies Partial<PluginError>);

        expect(writes).toEqual([
            {
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
            },
        ]);
        expect(reads).toBe(1);
    });

    it('never replays a daemon transaction callback whose derived write lost the row CAS', async () => {
        let reads = 0;
        const post = vi.fn(async () => ({
            status: 200,
            data: { status: 'conflict' as const, revision: 2 },
        }));
        const account = bindHost({
            get: async () => {
                reads += 1;
                return {
                    status: 200,
                    data: {
                        status: 'present' as const,
                        revision: reads,
                        content: {
                            t: 'plain' as const,
                            v: {
                                v: 1 as const,
                                values: {
                                    source: {
                                        version: reads - 1,
                                        value: reads + 1,
                                    },
                                },
                            },
                        },
                    },
                };
            },
            post,
        });
        const callback = vi.fn(async (transaction: AccountKvTransaction) => {
            const source = await transaction.get<number>('source');
            await transaction.set(
                'derived',
                (source && 'value' in source ? source.value : 0) * 2,
                { expectedVersion: 'absent' },
            );
        });

        await expect(account.kv.transaction(callback)).rejects.toMatchObject({
            code: 'plugin_account_kv_conflict',
        } satisfies Partial<PluginError>);
        expect(callback).toHaveBeenCalledOnce();
        expect(post).toHaveBeenCalledOnce();
        expect(reads).toBe(1);
    });

    /**
     * A service write from inside the callback is a real separate mutation, so
     * it advances the physical row the enclosing transaction already sampled.
     * The transaction therefore loses its one CAS and reports a typed conflict
     * rather than being silently rebased on top of the author's own write.
     */
    it('treats a service write from an Account KV callback as a separate mutation that conflicts the enclosing transaction', async () => {
        const wire = createAccountKvWireStore();
        const account = bindHost({ get: wire.get, post: wire.post });

        await expect(account.kv.transaction(async (transaction) => {
            await transaction.set('transaction-write', 1, { expectedVersion: 'absent' });
            await expect(account.kv.transaction(async (nested) => await nested.set(
                'nested-transaction-write',
                4,
                { expectedVersion: 'absent' },
            ))).rejects.toMatchObject({ code: 'plugin_account_kv_invalid' });
            await expect(account.kv.set(
                'callback-service-write',
                2,
                { expectedVersion: 'absent' },
            )).resolves.toEqual({ version: 0 });
        })).rejects.toMatchObject({
            code: 'plugin_account_kv_conflict',
        } satisfies Partial<PluginError>);

        await expect(account.kv.get('callback-service-write')).resolves.toEqual({
            version: 0,
            value: 2,
        });
        await expect(account.kv.get('transaction-write')).resolves.toBeNull();
        await expect(account.kv.get('nested-transaction-write')).resolves.toBeNull();
    });

    it('honors cancellation supplied to one daemon transaction method before writing', async () => {
        const post = vi.fn(async () => ({
            status: 200,
            data: { status: 'updated' as const, revision: 0 },
        }));
        const account = bindHost({
            get: async () => ({ status: 200, data: { status: 'absent' as const } }),
            post,
        });
        const cancellation = new AbortController();
        cancellation.abort();

        await expect(account.kv.transaction(async (transaction) => await transaction.set(
            'cancelled',
            true,
            { expectedVersion: 'absent', signal: cancellation.signal },
        ))).rejects.toMatchObject({ code: 'plugin_collection_cancelled' });
        expect(post).not.toHaveBeenCalled();
    });

    it('keeps an inner daemon transaction signal active through the physical commit', async () => {
        const post = vi.fn(async () => ({
            status: 200,
            data: { status: 'updated' as const, revision: 0 },
        }));
        const account = bindHost({
            get: async () => ({ status: 200, data: { status: 'absent' as const } }),
            post,
        });
        const cancellation = new AbortController();

        await expect(account.kv.transaction(async (transaction) => {
            await transaction.set('cancelled', true, {
                expectedVersion: 'absent',
                signal: cancellation.signal,
            });
            cancellation.abort();
        })).rejects.toMatchObject({ code: 'plugin_collection_cancelled' });
        expect(post).not.toHaveBeenCalled();
    });

    it('preserves the exact conflict after the single daemon CAS settles despite cancellation', async () => {
        const cancellation = new AbortController();
        const get = vi.fn(async () => ({
            status: 200,
            data: { status: 'absent' as const },
        }));
        const post = vi.fn(async () => {
            cancellation.abort();
            return {
                status: 200,
                data: { status: 'conflict' as const, revision: 0 },
            };
        });
        const account = bindHost({ get, post, signal: cancellation.signal });

        await expect(account.kv.set('target', 'mine', {
            expectedVersion: 'absent',
        })).rejects.toMatchObject({ code: 'plugin_account_kv_conflict' });

        expect(post).toHaveBeenCalledOnce();
        expect(get).toHaveBeenCalledOnce();
    });

    it('retains and exposes deletion versions so stale absence cannot resurrect a key', async () => {
        const wire = createAccountKvWireStore({
            v: 1,
            values: {
                checkpoint: { version: 0, value: { offset: 1 } },
            },
        });
        const account = bindHost({ get: wire.get, post: wire.post });

        await expect(account.kv.delete('checkpoint', { expectedVersion: 0 })).resolves.toEqual({
            version: 1,
            deleted: true,
        });
        await expect(account.kv.get('checkpoint')).resolves.toEqual({
            version: 1,
            deleted: true,
        });
        await expect(account.kv.list()).resolves.toEqual({
            items: [{ key: 'checkpoint', version: 1, deleted: true }],
        });
        // The rule itself lives in the Protocol row owner, whose own error class
        // already carries this `code`. Asserting the name too is what proves the
        // daemon translated it into the author-facing `PluginError` the canonical
        // recognizer accepts — without it this assertion passes unchanged when the
        // translation is removed and a raw internal error reaches the plugin.
        await expect(account.kv.set('checkpoint', { offset: 2 }, {
            expectedVersion: 'absent',
        })).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_account_kv_conflict',
        } satisfies Partial<PluginError>);
        await expect(account.kv.set('checkpoint', { offset: 2 }, {
            expectedVersion: 1,
        })).resolves.toEqual({ version: 2 });
        await expect(account.kv.get('checkpoint')).resolves.toEqual({
            version: 2,
            value: { offset: 2 },
        });
    });

    it('binds Account-KV pagination to the row revision and reports a stale cursor', async () => {
        const wire = createAccountKvWireStore({
            v: 1,
            values: {
                alpha: { version: 0, value: 'a' },
                beta: { version: 0, value: 'b' },
                gamma: { version: 0, value: 'g' },
            },
        });
        const account = bindHost({ get: wire.get, post: wire.post });
        const concurrentWriter = bindHost({ get: wire.get, post: wire.post });

        const firstPage = await account.kv.list({ limit: 1 });
        expect(firstPage).toEqual({
            items: [{ key: 'alpha', version: 0, value: 'a' }],
            nextCursor: expect.any(String),
        });
        await concurrentWriter.kv.set('gamma', 'g2', { expectedVersion: 0 });
        await expect(account.kv.list({ cursor: firstPage.nextCursor })).rejects.toMatchObject({
            code: 'plugin_account_kv_cursor_stale',
        } satisfies Partial<PluginError>);
    });

    it('runs Account KV callbacks once against one CAS snapshot and seals E2EE rows in the KV-only domain', async () => {
        let revision: number | 'absent' = 'absent';
        let content: unknown = null;
        const post = vi.fn(async (url: string, body: string) => {
            if (url.endsWith('/v1/account/encryption')) {
                return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
            }
            const request = JSON.parse(body) as Readonly<{ expectedRevision: number | 'absent'; content: Readonly<{ t: string; c?: string }> | null }>;
            if (request.expectedRevision !== revision) {
                return { status: 200, data: { status: 'conflict', revision: revision === 'absent' ? 0 : revision } };
            }
            revision = revision === 'absent' ? 0 : revision + 1;
            content = request.content;
            return { status: 200, data: { status: 'updated', revision } };
        });
        const account = bindHost({
            credentials: encryptedCredentials,
            get: async (url) => {
                if (url.endsWith('/v1/account/encryption')) {
                    return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
                }
                return revision === 'absent'
                    ? { status: 200, data: { status: 'absent' } }
                    : { status: 200, data: { status: 'present', revision, content } };
            },
            post,
            randomBytes: (length) => new Uint8Array(length).fill(4),
        });
        const callback = vi.fn(async (transaction: AccountKvTransaction) => {
            await transaction.set('first', { enabled: true }, { expectedVersion: 'absent' });
            expect(await transaction.get('first')).toEqual({ version: 0, value: { enabled: true } });
            await transaction.set('second', ['value'], { expectedVersion: 'absent' });
            await transaction.set('projects/one', { id: 'project-1' }, { expectedVersion: 'absent' });
            await transaction.set('projects/two', { id: 'project-2' }, { expectedVersion: 'absent' });
            await transaction.set('tasks/one', { id: 'task-1' }, { expectedVersion: 'absent' });
            return 'committed';
        });

        await expect(account.kv.transaction(callback)).resolves.toBe('committed');
        expect(callback).toHaveBeenCalledOnce();
        const persisted = JSON.parse(
            post.mock.calls.find(([url]) => String(url).includes('/plugin-storage/'))?.[1] ?? 'null',
        ) as Readonly<{
            content: Readonly<{ t: string; c?: string }>;
        }>;
        expect(persisted.content.t).toBe('encrypted');
        expect(openPluginCollectionPrivatePayloadV1({
            material: { type: 'dataKey', machineKey: encryptedCredentials.encryption.machineKey },
            ciphertext: persisted.content.c!,
        })).toBeNull();
        expect(openPluginAccountStoragePrivatePayloadV1({
            material: { type: 'dataKey', machineKey: encryptedCredentials.encryption.machineKey },
            ciphertext: persisted.content.c!,
        })).toEqual({
            v: 1,
            values: {
                first: { version: 0, value: { enabled: true } },
                second: { version: 0, value: ['value'] },
                'projects/one': { version: 0, value: { id: 'project-1' } },
                'projects/two': { version: 0, value: { id: 'project-2' } },
                'tasks/one': { version: 0, value: { id: 'task-1' } },
            },
        });
        await expect(account.kv.get('first')).resolves.toEqual({ version: 0, value: { enabled: true } });
        await expect(account.kv.list({ limit: 1 })).resolves.toEqual({
            items: [{ key: 'first', version: 0, value: { enabled: true } }],
            nextCursor: expect.any(String),
        });
        const projects = await account.kv.list({ prefix: 'projects/', limit: 1 });
        expect(projects).toEqual({
            items: [{ key: 'projects/one', version: 0, value: { id: 'project-1' } }],
            nextCursor: expect.any(String),
        });
        await expect(account.kv.list({
            prefix: 'projects/',
            cursor: projects.nextCursor,
        })).resolves.toEqual({
            items: [{ key: 'projects/two', version: 0, value: { id: 'project-2' } }],
        });
        await expect(account.kv.list({
            prefix: 'tasks/',
            cursor: projects.nextCursor,
        })).rejects.toMatchObject({
            code: 'plugin_account_kv_invalid',
        } satisfies Partial<PluginError>);
    });

    it('does not replay a transaction callback when a touched key changed during the row CAS', async () => {
        let reads = 0;
        const post = vi.fn(async (_url: string, _body: string) => ({
            status: 200,
            data: { status: 'conflict' as const, revision: 0 },
        }));
        const account = bindHost({
            get: async () => {
                reads += 1;
                return reads === 1
                    ? { status: 200, data: { status: 'absent' as const } }
                    : {
                        status: 200,
                        data: {
                            status: 'present' as const,
                            revision: 0,
                            content: {
                                t: 'plain' as const,
                                v: {
                                    v: 1 as const,
                                    values: {
                                        checkpoint: { version: 0, value: { attempt: 'external' } },
                                    },
                                },
                            },
                        },
                    };
            },
            post,
        });
        const callback = vi.fn(async (transaction: AccountKvTransaction) => {
            await transaction.set('checkpoint', { attempt: 1 }, { expectedVersion: 'absent' });
            return 'settled';
        });

        await expect(account.kv.transaction(callback)).rejects.toMatchObject({
            code: 'plugin_account_kv_conflict',
        } satisfies Partial<PluginError>);
        expect(callback).toHaveBeenCalledOnce();
        expect(post).toHaveBeenCalledOnce();
        expect(reads).toBe(1);
    });

    /**
     * Protocol's strict-JSON admission is iterative and deliberately carries no
     * depth quota, but the request still has to be serialized, and on the
     * recursive `JSON.stringify` builds this daemon ships on that serializer can
     * refuse an admitted value. Only the operation that runs the serializer can
     * say a refusal came from it: the host therefore encodes its own request
     * body and classifies that refusal there.
     *
     * Everything the transport can throw is a different fact. `RangeError` is
     * not a transport-versus-serializer discriminator — a response larger than
     * the engine's maximum string length raises `RangeError: Invalid string
     * length` out of the very same call — so a client that reads `RangeError`
     * off the whole request tells a caller its data is permanently bad and takes
     * a recoverable outage off the retry path.
     */
    it('classifies a transport RangeError after an issued Collection mutation as an unknown outcome', async () => {
        const bodies: unknown[] = [];
        const account = bindHost({
            post: async (_url, body) => {
                bodies.push(body);
                throw new RangeError('Invalid string length');
            },
        });

        await expect(account.collection(collectionDefinition).put({
            id: 'task-1',
            status: 'open',
            privateNote: 'keep private',
        }, { expectedRevision: 'absent' })).rejects.toMatchObject({
            code: 'plugin_collection_outcome_unknown',
            retryable: false,
        } satisfies Partial<PluginError>);
        // The host, not the transport, encoded the body — which is what makes a
        // serializer refusal identifiable without capturing transport failures.
        expect(bodies).toHaveLength(1);
        expect(typeof bodies[0]).toBe('string');
        expect(JSON.parse(bodies[0] as string)).toMatchObject({
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
        });
    });

    it('classifies a transport RangeError after an issued Account KV write as an unknown outcome', async () => {
        const account = bindHost({
            get: async () => ({ status: 200, data: { status: 'absent' } }),
            post: async () => {
                throw new RangeError('Invalid string length');
            },
        });

        await expect(account.kv.set('deep', { nested: true }, { expectedVersion: 'absent' }))
            .rejects.toMatchObject({
                code: 'plugin_account_storage_outcome_unknown',
                retryable: false,
            } satisfies Partial<PluginError>);
    });
});
