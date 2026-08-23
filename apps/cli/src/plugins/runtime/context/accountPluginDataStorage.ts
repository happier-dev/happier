import axios from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    derivePluginCollectionIdentityTagV1,
    PluginAccountKvRowError,
    assertPluginAccountKvExpectedVersionV1,
    clonePluginAccountKvRowV1,
    createEmptyPluginAccountKvRowV1,
    deletePluginAccountKvEntryV1,
    listPluginAccountKvEntriesV1,
    normalizePluginAccountKvLogicalKeyV1,
    projectPluginAccountKvEntryV1,
    readPluginAccountKvEntryV1,
    setPluginAccountKvEntryV1,
    type PluginAccountStorageEntryV1,
    PluginAccountStorageMutationRequestV1Schema,
    PluginAccountStorageMutationResponseV1Schema,
    PluginAccountStorageReadResponseV1Schema,
    PluginAccountStorageRowV1Schema,
    PluginAccountStorageUnavailableV1Schema,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_GET_HTTP_PATH_V1,
    PLUGIN_COLLECTION_LIMITS_V1,
    PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
    PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
    PluginAccountCollectionContributionV1Schema,
    PluginCollectionCandidatePreparationBindingV1Schema,
    PluginCollectionCandidatePreparationErrorV1Schema,
    PluginCollectionCandidatePreparationRetireRequestV1Schema,
    PluginCollectionCandidatePreparationRetireResultV1Schema,
    PluginCollectionCandidatePreparationSourcePageRequestV1Schema,
    PluginCollectionCandidatePreparationSourcePageResultV1Schema,
    PluginCollectionCandidatePreparationStageRequestV1Schema,
    PluginCollectionCandidatePreparationStageResultV1Schema,
    PluginCollectionContentEnvelopeV1Schema,
    PluginCollectionGetRequestV1Schema,
    PluginCollectionGetResultV1Schema,
    PluginCollectionMutationErrorV1Schema,
    PluginCollectionMutationRequestV1Schema,
    PluginCollectionMutationResultV1Schema,
    PluginCollectionPrivatePayloadV1Schema,
    PluginCollectionProjectionV1Schema,
    PluginCollectionQueryRequestV1Schema,
    PluginCollectionQueryResultV1Schema,
    PluginCollectionReadErrorV1Schema,
    PluginCollectionRowIdV1Schema,
    compilePluginJsonSchema,
    assertPluginAccountStorageEnvelopeForModeV1,
    isValidPluginJsonSchemaValue,
    measurePluginCollectionMutationRequestDecompositionV1,
    measurePluginCollectionMutationRequestEncodedBytesV1,
    normalizePluginAccountCollectionContractV1,
    openPluginCollectionPrivatePayloadV1,
    resolveEffectivePluginCollectionLimitsV1,
    openPluginAccountStoragePrivatePayloadV1,
    normalizeStrictJsonValue,
    sealPluginAccountStoragePrivatePayloadV1,
    sealPluginCollectionPrivatePayloadV1,
    splitPluginCollectionCandidatePreparationStageRequestsForKnownLimitsV1,
    type AccountEncryptionCurrentnessResponse,
    type AccountScopedCryptoMaterial,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginAccountCollectionContributionV1,
    type PluginCollectionCandidatePreparationBindingV1,
    type PluginCollectionContractRefV1,
    type PluginDataCollectionsCapabilities,
    type PluginCollectionContentEnvelopeV1,
    type PluginCollectionMutationOperationV1,
    type PluginCollectionMutationRequestV1,
    type PluginCollectionMutationResultV1,
    type PluginCollectionProjectionV1,
    type PluginCollectionRowV1,
    type PluginAccountStorageRowV1,
} from '@happier-dev/protocol';
import {
    isPluginError,
    normalizePluginAccountCollectionMigrationRuntimeProjection,
    projectPluginAccountCollectionDeclaration,
    PluginError,
    type JsonValue,
    type PluginAccountCollectionMigrationRuntimeProjection,
} from '@happier-dev/plugin-sdk';
import type {
    PluginAccountCollectionDefinition,
    PluginAccountCollectionForDefinition,
    PluginAccountCollectionIndexes,
    PluginAccountCollectionValue,
    PluginCollectionInvalidation,
    PluginCollectionMutation,
    PluginCollectionQuery,
    PluginCollectionRow,
    PluginCollectionWatchQuery,
} from '@happier-dev/plugin-sdk/collections';
import type {
    AccountKvEntry,
    AccountKvListItem,
    AccountKvService,
    AccountKvTransaction,
    PluginAccountStorageScope,
} from '@happier-dev/plugin-sdk/storage';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readStoredCredentials, type Credentials, type StoredCredentials } from '@/persistence';
import {
    getActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { requireAccountSettingsEncryptionCredentials } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { resolveAccountSettingsHttpBaseUrl } from '@/settings/accountSettings/resolveAccountSettingsHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

import type { StablePluginAccountStorageHost } from './storage';
import {
    subscribePluginAccountCollectionWatchInvalidation,
    type PluginAccountCollectionWatchInvalidation,
    type PluginAccountCollectionWatchSubscription,
} from './pluginAccountSettingsChangeBroker';

export type { PluginAccountCollectionWatchInvalidation } from './pluginAccountSettingsChangeBroker';

export type AccountPluginDataHttpClient = Readonly<{
    get(url: string, config: Readonly<Record<string, unknown>>): Promise<Readonly<{
        status: number;
        data: unknown;
    }>>;
    post(url: string, body: unknown, config: Readonly<Record<string, unknown>>): Promise<Readonly<{
        status: number;
        data: unknown;
    }>>;
}>;

/**
 * Process-owned dependencies for the canonical Account Data host. The
 * collection contract census remains supplied by each resolved runtime
 * registry; callers can only replace the authenticated Account/system port.
 */
export type AccountPluginDataStorageHostDependencies = Readonly<{
    readCredentials?: () => Promise<StoredCredentials | null>;
    isCurrentAccount?: (credentials: StoredCredentials) => boolean;
    resolveAccountScopeKey?: () => string | null;
    http?: AccountPluginDataHttpClient;
    resolveBaseUrl?: () => string;
    /** Delegates to the canonical Account currentness producer; it owns no local mode or key state. */
    resolveAccountEncryptionCurrentness?: (
        credentials: StoredCredentials,
        signal?: AbortSignal,
    ) => Promise<AccountEncryptionCurrentnessResponse>;
    randomBytes?: (length: number) => Uint8Array;
    /**
     * Optional read-only daemon cache. Collection mutation admission never
     * fetches features: absent, old, or unavailable snapshots remain
     * server-authoritative.
     */
    resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
    subscribeChanges?: (
        subscription: PluginAccountCollectionWatchSubscription,
        listener: (hint: PluginAccountCollectionWatchInvalidation) => void,
    ) => () => void;
}>;

type BoundAccountDataLifecycle = Readonly<{
    pluginId: string;
    signal: AbortSignal;
    isGenerationCurrent(): boolean | Promise<boolean>;
    /** Captured from the canonical active-Account publication owner at admission. */
    accountLifetimeToken: number;
}>;

type BoundCollection = Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    validate: ReturnType<typeof compilePluginJsonSchema>;
}>;

/**
 * Host-private capability for one exact target artifact. The Protocol binding
 * and SDK callback projection are the only cross-host contracts; this handle
 * neither selects Availability nor exposes a second readiness owner.
 */
export type CollectionMigrationCandidateHandle = Readonly<{
    prepare(): Promise<void>;
    /** Aborts local work, drains it, then asks Data to retire this exact stage set. */
    retire(): Promise<void>;
}>;

export type AccountPluginDataStorageHost = StablePluginAccountStorageHost & Readonly<{
    /**
     * Retires a durable stage that was already prepared. This deliberately
     * requires only the current Account/request authority: the target module
     * may no longer be executable when cleanup runs.
     */
    retireCollectionMigrationCandidate(input: Readonly<{
        binding: PluginCollectionCandidatePreparationBindingV1;
        signal: AbortSignal;
        isCurrent(): boolean | Promise<boolean>;
    }>): Promise<void>;
    createCollectionMigrationCandidate(input: Readonly<{
        binding: PluginCollectionCandidatePreparationBindingV1;
        /** Exact incumbent release contract, supplied by the Account release owner. */
        sourceContract: NormalizedPluginAccountCollectionContractV1;
        /** Exact prospective artifact contract, supplied by the target artifact owner. */
        targetContract: NormalizedPluginAccountCollectionContractV1;
        declarations: readonly PluginAccountCollectionContributionV1[];
        runtime: PluginAccountCollectionMigrationRuntimeProjection;
        signal: AbortSignal;
        isGenerationCurrent(): boolean | Promise<boolean>;
    }>): CollectionMigrationCandidateHandle;
}>;

const ACCOUNT_DATA_UNAVAILABLE_CODE = 'plugin_account_storage_unavailable';
const COLLECTION_UNDECLARED_CODE = 'plugin_collection_undeclared';
const COLLECTION_INVALID_VALUE_CODE = 'plugin_collection_invalid_value';
const COLLECTION_PROTOCOL_INVALID_CODE = 'plugin_collection_protocol_invalid';
const COLLECTION_CONFLICT_CODE = 'plugin_collection_conflict';
const COLLECTION_CANCELLED_CODE = 'plugin_collection_cancelled';
const GENERATION_STALE_CODE = 'plugin_generation_stale';
const ACCOUNT_KV_CONFLICT_CODE = 'plugin_account_kv_conflict';
const ACCOUNT_KV_INVALID_CODE = 'plugin_account_kv_invalid';

type CandidatePreparationStageRequest = ReturnType<
    typeof PluginCollectionCandidatePreparationStageRequestV1Schema.parse
>;
type CandidatePreparationStageItem = CandidatePreparationStageRequest['items'][number];

const accountKvTransactionContext = new AsyncLocalStorage<ReadonlySet<object>>();

function dataError(
    code: string,
    message: string,
    retryable = false,
    details?: JsonValue,
): PluginError {
    return new PluginError({
        code,
        message,
        ...(retryable ? { retryable: true } : {}),
        ...(details === undefined ? {} : { details }),
    });
}

function createUnavailableAccountCollection<
    TDefinition extends PluginAccountCollectionDefinition,
>(code: string): PluginAccountCollectionForDefinition<TDefinition> {
    const unavailable = (): never => {
        throw new PluginError({
            code,
            message: 'Account plugin collection is not declared for this Account Data binding',
        });
    };
    const unavailableAsync = <T>(): Promise<T> => Promise.reject(new PluginError({
        code,
        message: 'Account plugin collection is not declared for this Account Data binding',
    }));
    return Object.freeze({
        identityTag: unavailableAsync,
        get: unavailableAsync,
        put: unavailableAsync,
        delete: unavailableAsync,
        query: unavailableAsync,
        batch: unavailableAsync,
        limits: unavailableAsync,
        measureBatch: unavailableAsync,
        watch: unavailable,
    }) as PluginAccountCollectionForDefinition<TDefinition>;
}

function collectionContractMatchesRef(
    contract: NormalizedPluginAccountCollectionContractV1,
    ref: PluginCollectionContractRefV1,
): boolean {
    return contract.pluginId === ref.pluginId
        && contract.collectionId === ref.collectionId
        && contract.schemaVersion === ref.schemaVersion
        && contract.contractDigest === ref.contractDigest;
}

function parseCandidatePreparationError(value: unknown): PluginError | null {
    const parsed = PluginCollectionCandidatePreparationErrorV1Schema.safeParse(value);
    if (!parsed.success) return null;
    const details = parsed.data.error === 'collection_quota_incompatible'
        ? normalizeStrictJsonValue({
            dimension: parsed.data.dimension,
            effectiveMaximum: parsed.data.effectiveMaximum,
        })
        : undefined;
    return dataError(
        parsed.data.error,
        `Account Collection candidate preparation was rejected: ${parsed.data.error}`,
        false,
        details,
    );
}

function resolveCandidateMigrationChain(input: Readonly<{
    sourceSchemaVersion: number;
    targetSchemaVersion: number;
    migrations: PluginAccountCollectionMigrationRuntimeProjection[string];
}>): readonly PluginAccountCollectionMigrationRuntimeProjection[string][number][] {
    if (input.sourceSchemaVersion > input.targetSchemaVersion) {
        throw dataError(
            COLLECTION_INVALID_VALUE_CODE,
            'Collection candidate migration cannot target an older schema version',
        );
    }
    const chain: PluginAccountCollectionMigrationRuntimeProjection[string][number][] = [];
    let version = input.sourceSchemaVersion;
    while (version < input.targetSchemaVersion) {
        const next = input.migrations.filter((migration) => (
            migration.fromSchemaVersion === version
            && migration.toSchemaVersion > version
            && migration.toSchemaVersion <= input.targetSchemaVersion
        ));
        if (next.length !== 1) {
            throw dataError(
                COLLECTION_INVALID_VALUE_CODE,
                'Collection candidate migration callbacks do not form one exact source-to-target chain',
            );
        }
        const migration = next[0]!;
        chain.push(migration);
        version = migration.toSchemaVersion;
    }
    return Object.freeze(chain);
}

function resolveMaterial(credentials: Credentials): AccountScopedCryptoMaterial {
    return credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: credentials.encryption.secret }
        : { type: 'dataKey', machineKey: credentials.encryption.machineKey };
}

function requestConfig(credentials: StoredCredentials, signal: AbortSignal): Readonly<Record<string, unknown>> {
    return {
        headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            Authorization: `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
        timeout: 15_000,
        validateStatus: () => true,
        signal,
    };
}

function composeOperationSignal(lifetimeSignal: AbortSignal, operationSignal?: AbortSignal): AbortSignal {
    if (!operationSignal || operationSignal === lifetimeSignal) return lifetimeSignal;
    return AbortSignal.any([lifetimeSignal, operationSignal]);
}

function checkBoundCurrent(
    lifecycle: BoundAccountDataLifecycle,
    operationSignal?: AbortSignal,
): void | Promise<void> {
    if (lifecycle.signal.aborted || operationSignal?.aborted) {
        throw dataError(COLLECTION_CANCELLED_CODE, 'Plugin Account Collection operation was cancelled');
    }
    if (getActiveAccountSettingsSnapshotLifetimeToken() !== lifecycle.accountLifetimeToken) {
        throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account Data is unavailable for the current Account');
    }
    const current = lifecycle.isGenerationCurrent();
    if (typeof current === 'boolean') {
        if (!current) {
            throw dataError(GENERATION_STALE_CODE, 'Plugin Account Collection invocation generation is stale');
        }
        return;
    }
    return current.then((isCurrent) => {
        if (lifecycle.signal.aborted || operationSignal?.aborted) {
            throw dataError(COLLECTION_CANCELLED_CODE, 'Plugin Account Collection operation was cancelled');
        }
        if (getActiveAccountSettingsSnapshotLifetimeToken() !== lifecycle.accountLifetimeToken) {
            throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account Data is unavailable for the current Account');
        }
        if (!isCurrent) {
            throw dataError(GENERATION_STALE_CODE, 'Plugin Account Collection invocation generation is stale');
        }
    });
}

async function assertBoundCurrent(lifecycle: BoundAccountDataLifecycle, operationSignal?: AbortSignal): Promise<void> {
    await checkBoundCurrent(lifecycle, operationSignal);
}

function asJsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, JsonValue>>
        : null;
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function createJsonRecord(): Record<string, JsonValue> {
    return Object.create(null) as Record<string, JsonValue>;
}

function setJsonRecordValue(record: Record<string, JsonValue>, key: string, value: JsonValue): void {
    Object.defineProperty(record, key, {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
    });
}

/**
 * Account KV logical-key semantics live in the Protocol owner so the daemon and
 * the direct Plugin UI client cannot drift. The daemon keeps only the
 * translation into its own `PluginError` vocabulary.
 */
function inAccountKvRowAlgebra<T>(operation: () => T): T {
    try {
        return operation();
    } catch (error) {
        if (error instanceof PluginAccountKvRowError) {
            throw dataError(error.code, error.message);
        }
        throw error;
    }
}

function normalizeAccountKvKey(key: string): string {
    return inAccountKvRowAlgebra(() => normalizePluginAccountKvLogicalKeyV1(key));
}

function createEmptyAccountKvRow(): PluginAccountStorageRowV1 {
    return createEmptyPluginAccountKvRowV1();
}

function cloneAccountKvRow(row: PluginAccountStorageRowV1): PluginAccountStorageRowV1 {
    return clonePluginAccountKvRowV1(row);
}

function accountKvEntryAt(
    row: PluginAccountStorageRowV1,
    key: string,
): PluginAccountStorageEntryV1 | undefined {
    return readPluginAccountKvEntryV1(row, key);
}

function toAccountKvEntry<TValue extends JsonValue = JsonValue>(
    entry: PluginAccountStorageEntryV1,
): AccountKvEntry<TValue> {
    return inAccountKvRowAlgebra(() => projectPluginAccountKvEntryV1<TValue>(entry));
}

function assertAccountKvExpectedVersion(
    row: PluginAccountStorageRowV1,
    key: string,
    expectedVersion: number | 'absent',
): PluginAccountStorageEntryV1 | undefined {
    return inAccountKvRowAlgebra(
        () => assertPluginAccountKvExpectedVersionV1(row, key, expectedVersion),
    );
}

function setAccountKvEntry(
    row: PluginAccountStorageRowV1,
    key: string,
    value: JsonValue,
    previous: PluginAccountStorageEntryV1 | undefined,
): number {
    return inAccountKvRowAlgebra(() => setPluginAccountKvEntryV1(row, key, value, previous));
}

function deleteAccountKvEntry(
    row: PluginAccountStorageRowV1,
    key: string,
    previous: PluginAccountStorageEntryV1,
): number {
    return inAccountKvRowAlgebra(() => deletePluginAccountKvEntryV1(row, key, previous));
}

function parseCollectionError(value: unknown, kind: 'read' | 'mutation'): PluginError | null {
    const parsed = kind === 'read'
        ? PluginCollectionReadErrorV1Schema.safeParse(value)
        : PluginCollectionMutationErrorV1Schema.safeParse(value);
    if (!parsed.success) return null;
    const details = parsed.data.error === 'collection_relation_restricted'
        ? normalizeStrictJsonValue({
            dependentCount: parsed.data.dependentCount,
            continuation: parsed.data.continuation,
        })
        : parsed.data.error === 'collection_quota_incompatible'
            ? normalizeStrictJsonValue({
                dimension: parsed.data.dimension,
                effectiveMaximum: parsed.data.effectiveMaximum,
            })
            : undefined;
    return dataError(
        parsed.data.error,
        `Account Collection server rejected the operation: ${parsed.data.error}`,
        false,
        details,
    );
}

function ensureExactProjection(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    rowId: string;
    projection: PluginCollectionProjectionV1;
}>): PluginCollectionProjectionV1 {
    const fields = Object.keys(input.projection);
    const expected = new Set(input.contract.serverReadable);
    if (fields.length !== expected.size || fields.some((field) => !expected.has(field))) {
        throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection projection does not match its admitted server-readable fields');
    }
    for (const field of input.contract.serverReadable) {
        if (!hasOwn(input.projection, field)) {
            throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection projection omitted an admitted field');
        }
        if (field === input.contract.rowIdField && input.projection[field] !== input.rowId) {
            throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection projection row identity does not match the row');
        }
    }
    return input.projection;
}

function splitLogicalPut(input: Readonly<{
    collection: BoundCollection;
    value: PluginAccountCollectionValue<PluginAccountCollectionDefinition>;
    encryptionMode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
    randomBytes: (length: number) => Uint8Array;
}>): Extract<PluginCollectionMutationOperationV1, { kind: 'put' }> {
    const value = asJsonObject(input.value);
    if (!value || !isValidPluginJsonSchemaValue(input.collection.validate, value)) {
        throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection value does not satisfy its admitted schema');
    }
    const rowIdCandidate = value[input.collection.contract.rowIdField];
    if (typeof rowIdCandidate !== 'string') {
        throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection row identity must be a string');
    }
    let rowId: string;
    try {
        rowId = PluginCollectionRowIdV1Schema.parse(rowIdCandidate);
    } catch {
        throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection row identity is invalid');
    }

    const projection = createJsonRecord();
    for (const field of input.collection.contract.serverReadable) {
        const projected = hasOwn(value, field) ? value[field]! : null;
        setJsonRecordValue(projection, field, projected);
    }
    let parsedProjection: PluginCollectionProjectionV1;
    try {
        parsedProjection = PluginCollectionProjectionV1Schema.parse(projection);
    } catch {
        throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection server-readable projection is invalid');
    }
    ensureExactProjection({ contract: input.collection.contract, rowId, projection: parsedProjection });

    const privatePayload = createJsonRecord();
    const reserved = new Set([
        input.collection.contract.rowIdField,
        ...input.collection.contract.serverReadable,
    ]);
    for (const [field, fieldValue] of Object.entries(value)) {
        if (!reserved.has(field)) setJsonRecordValue(privatePayload, field, fieldValue);
    }
    let content: PluginCollectionContentEnvelopeV1;
    try {
        content = input.encryptionMode === 'plain'
            ? PluginCollectionContentEnvelopeV1Schema.parse({ t: 'plain', v: privatePayload })
            : PluginCollectionContentEnvelopeV1Schema.parse({
                t: 'encrypted',
                c: sealPluginCollectionPrivatePayloadV1({
                    material: input.material ?? (() => { throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account encryption material is unavailable'); })(),
                    payload: PluginCollectionPrivatePayloadV1Schema.parse(privatePayload),
                    randomBytes: input.randomBytes,
                }),
            });
    } catch (error) {
        if (isPluginError(error)) throw error;
        throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection private payload is invalid');
    }
    return {
        kind: 'put',
        rowId,
        expectedRevision: 'absent',
        content,
        projection: parsedProjection,
    };
}

function mergeLogicalRow<TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition>>(input: Readonly<{
    collection: BoundCollection;
    row: PluginCollectionRowV1;
    encryptionMode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
}>): PluginCollectionRow<TValue> {
    let privatePayload: Record<string, JsonValue> | null;
    if (input.encryptionMode === 'plain') {
        privatePayload = input.row.content.t === 'plain' ? input.row.content.v : null;
    } else {
        privatePayload = input.row.content.t === 'encrypted' && input.material
            ? openPluginCollectionPrivatePayloadV1({ material: input.material, ciphertext: input.row.content.c })
            : null;
    }
    if (!privatePayload) {
        throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection content does not match the current Account encryption mode');
    }
    const projection = ensureExactProjection({
        contract: input.collection.contract,
        rowId: input.row.rowId,
        projection: input.row.projection,
    });
    const logical = createJsonRecord();
    const reserved = new Set([
        input.collection.contract.rowIdField,
        ...input.collection.contract.serverReadable,
    ]);
    for (const [field, value] of Object.entries(privatePayload)) {
        if (reserved.has(field)) {
            throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection private payload overlaps an admitted projection field');
        }
        setJsonRecordValue(logical, field, value);
    }
    for (const field of input.collection.contract.serverReadable) {
        const value = projection[field];
        // The Data transport uses null for an absent optional scalar column.
        // Reconstructing that sentinel as a logical field would turn absence
        // into an invalid explicit null for ordinary non-nullable properties.
        if (value !== null) setJsonRecordValue(logical, field, value!);
    }
    if (!hasOwn(logical, input.collection.contract.rowIdField)) {
        setJsonRecordValue(logical, input.collection.contract.rowIdField, input.row.rowId);
    }
    if (!isLogicalCollectionValue<TValue>(input.collection.validate, logical)) {
        throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection row does not satisfy its admitted schema');
    }
    return Object.freeze({ rowId: input.row.rowId, revision: input.row.revision, value: logical });
}

function isLogicalCollectionValue<TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition>>(
    validate: ReturnType<typeof compilePluginJsonSchema>,
    value: Readonly<Record<string, JsonValue>>,
): value is TValue {
    return isValidPluginJsonSchemaValue(validate, value);
}

/**
 * The one direct Account Data client. It consumes the already-normalized
 * Collection contribution projection, stamps writer authority itself, and
 * owns the bounded Account-KV snapshot/CAS adapter through its distinct
 * Protocol envelope contract.
 */
export function createAccountPluginDataStorageHost(params: Readonly<{
    contracts: readonly NormalizedPluginAccountCollectionContractV1[];
    randomBytes?: (length: number) => Uint8Array;
    subscribeChanges?: (
        subscription: PluginAccountCollectionWatchSubscription,
        listener: (hint: PluginAccountCollectionWatchInvalidation) => void,
    ) => () => void;
} & AccountPluginDataStorageHostDependencies>): AccountPluginDataStorageHost {
    const contractsByPluginAndCollection = new Map<string, NormalizedPluginAccountCollectionContractV1>();
    for (const contract of params.contracts) {
        contractsByPluginAndCollection.set(`${contract.pluginId}\u0000${contract.collectionId}`, contract);
    }
    const readCredentials = params.readCredentials ?? readStoredCredentials;
    const http: AccountPluginDataHttpClient = params.http ?? axios;
    const resolveBaseUrl = params.resolveBaseUrl ?? resolveAccountSettingsHttpBaseUrl;
    const resolveAccountEncryptionCurrentness = params.resolveAccountEncryptionCurrentness
        ?? (async (credentials: StoredCredentials, signal?: AbortSignal) => (
            await fetchAccountEncryptionCurrentness({
                token: credentials.token,
                serverBaseUrl: resolveBaseUrl(),
                ...(signal ? { signal } : {}),
            })
        ));
    const isCurrentAccount = params.isCurrentAccount ?? ((credentials: StoredCredentials): boolean => {
        const active = getActiveAccountSettingsSnapshot();
        return Boolean(active && (!active.scopeKey || active.scopeKey === resolveAccountSettingsScopeKey(credentials)));
    });
    const resolveAccountScopeKey = params.resolveAccountScopeKey ?? (() => (
        getActiveAccountSettingsSnapshot()?.scopeKey ?? null
    ));
    const currentAccountScopeKey = (): string | null => {
        try {
            const scopeKey = resolveAccountScopeKey();
            return typeof scopeKey === 'string' && scopeKey.length > 0 ? scopeKey : null;
        } catch {
            return null;
        }
    };
    const randomBytes = params.randomBytes ?? ((length: number) => new Uint8Array(nodeRandomBytes(length)));
    const resolveServerFeaturesSnapshot = params.resolveServerFeaturesSnapshot;
    const subscribeChanges = params.subscribeChanges ?? subscribePluginAccountCollectionWatchInvalidation;

    const readKnownCollectionLimits = (): PluginDataCollectionsCapabilities | undefined => {
        try {
            const featureSnapshot = resolveServerFeaturesSnapshot?.();
            return featureSnapshot?.status === 'ready'
                ? featureSnapshot.features.capabilities.pluginDataCollections
                : undefined;
        } catch {
            return undefined;
        }
    };

    const createBoundRequestContext = (lifecycle: BoundAccountDataLifecycle) => {
        const assertCurrentAccount = async (
            credentials: StoredCredentials,
            operationSignal?: AbortSignal,
        ): Promise<void> => {
            await assertBoundCurrent(lifecycle, operationSignal);
            let current = false;
            try {
                current = isCurrentAccount(credentials);
            } catch {
                current = false;
            }
            if (!current) {
                throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account Data is unavailable for the current Account');
            }
        };
        const signalFor = (operationSignal?: AbortSignal): AbortSignal => (
            composeOperationSignal(lifecycle.signal, operationSignal)
        );
        const currentCredentials = async (operationSignal?: AbortSignal): Promise<StoredCredentials> => {
            await assertBoundCurrent(lifecycle, operationSignal);
            const current = await readCredentials();
            await assertBoundCurrent(lifecycle, operationSignal);
            if (!current) {
                throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account Data requires current Account credentials');
            }
            await assertCurrentAccount(current, operationSignal);
            return current;
        };
        const currentEncryption = async (
            current: StoredCredentials,
            operationSignal?: AbortSignal,
        ): Promise<Readonly<{
            mode: 'plain' | 'e2ee';
            material: AccountScopedCryptoMaterial | null;
        }>> => {
            const signal = signalFor(operationSignal);
            try {
                const currentness = await resolveAccountEncryptionCurrentness(current, signal);
                await assertCurrentAccount(current, operationSignal);
                if (currentness.mode === 'plain') {
                    return Object.freeze({ mode: 'plain', material: null });
                }
                let material: AccountScopedCryptoMaterial;
                let contentPublicKeyFingerprint: string;
                try {
                    const encryptionCredentials = requireAccountSettingsEncryptionCredentials(current);
                    const encryption = encryptionCredentials.encryption;
                    const localMaterial = resolveMaterial(encryptionCredentials);
                    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
                        accountEncryptionMode: 'e2ee',
                        material: localMaterial,
                        ...(encryption.type === 'dataKey'
                            ? { dataKeyPublicKey: encryption.publicKey }
                            : {}),
                    });
                    material = snapshot.material;
                    contentPublicKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                        snapshot.contentPublicKeyFingerprint,
                    );
                } catch {
                    throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account encryption material is unavailable');
                }
                if (
                    currentness.contentKeyFingerprint === null
                    || currentness.contentKeyFingerprint !== contentPublicKeyFingerprint
                ) {
                    throw dataError(
                        ACCOUNT_DATA_UNAVAILABLE_CODE,
                        'Account encryption material does not match current Account state',
                    );
                }
                return Object.freeze({ mode: 'e2ee', material });
            } catch (error) {
                await assertBoundCurrent(lifecycle, operationSignal);
                if (isPluginError(error)) throw error;
                throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account encryption currentness request failed', true);
            }
        };
        const post = async (input: Readonly<{
            path: string;
            body: unknown;
            credentials: StoredCredentials;
            operationSignal?: AbortSignal;
            parseError: (value: unknown) => PluginError | null;
            unavailableMessage: string;
        }>): Promise<unknown> => {
            const signal = signalFor(input.operationSignal);
            try {
                const response = await http.post(
                    `${resolveBaseUrl()}${input.path}`,
                    input.body,
                    requestConfig(input.credentials, signal),
                );
                await assertCurrentAccount(input.credentials, input.operationSignal);
                if (response.status >= 200 && response.status < 300) return response.data;
                throw input.parseError(response.data)
                    ?? dataError(
                        ACCOUNT_DATA_UNAVAILABLE_CODE,
                        input.unavailableMessage,
                        response.status >= 500,
                    );
            } catch (error) {
                await assertBoundCurrent(lifecycle, input.operationSignal);
                if (isPluginError(error)) throw error;
                throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, `${input.unavailableMessage} failed`, true);
            }
        };
        const request = async (input: Readonly<{
            path: string;
            body: unknown;
            kind: 'read' | 'mutation';
            credentials: StoredCredentials;
            operationSignal?: AbortSignal;
        }>): Promise<unknown> => await post({
            path: input.path,
            body: input.body,
            credentials: input.credentials,
            ...(input.operationSignal ? { operationSignal: input.operationSignal } : {}),
            parseError: (value) => parseCollectionError(value, input.kind),
            unavailableMessage: 'Account Collection transport is unavailable',
        });
        return Object.freeze({
            assertCurrentAccount,
            signalFor,
            currentCredentials,
            currentEncryption,
            post,
            request,
        });
    };

    return Object.freeze({
        async retireCollectionMigrationCandidate(input): Promise<void> {
            let binding: PluginCollectionCandidatePreparationBindingV1;
            try {
                binding = PluginCollectionCandidatePreparationBindingV1Schema.parse(input.binding);
            } catch {
                throw dataError(
                    'collection_candidate_preparation_invalid',
                    'Collection candidate retirement binding is invalid',
                );
            }

            const lifecycle: BoundAccountDataLifecycle = {
                pluginId: binding.target.pluginId,
                signal: input.signal,
                isGenerationCurrent: input.isCurrent,
                accountLifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
            };
            const requestContext = createBoundRequestContext(lifecycle);
            const credentials = await requestContext.currentCredentials();
            let requestBody: ReturnType<typeof PluginCollectionCandidatePreparationRetireRequestV1Schema.parse>;
            try {
                requestBody = PluginCollectionCandidatePreparationRetireRequestV1Schema.parse({ binding });
            } catch {
                throw dataError(
                    'collection_candidate_preparation_invalid',
                    'Collection candidate retirement request is invalid',
                );
            }
            const response = await requestContext.post({
                path: PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1,
                body: requestBody,
                credentials,
                parseError: parseCandidatePreparationError,
                unavailableMessage: 'Collection candidate retirement is unavailable',
            });
            const parsed = PluginCollectionCandidatePreparationRetireResultV1Schema.safeParse(response);
            if (!parsed.success) {
                throw dataError(
                    COLLECTION_PROTOCOL_INVALID_CODE,
                    'Collection candidate retirement response is invalid',
                );
            }
        },
        createCollectionMigrationCandidate(input): CollectionMigrationCandidateHandle {
            let binding: PluginCollectionCandidatePreparationBindingV1;
            try {
                binding = PluginCollectionCandidatePreparationBindingV1Schema.parse(input.binding);
            } catch {
                throw dataError(
                    'collection_candidate_preparation_invalid',
                    'Collection candidate preparation binding is invalid',
                );
            }

            const admittedTargetContract = contractsByPluginAndCollection.get(
                `${binding.target.pluginId}\u0000${binding.target.collectionId}`,
            );
            if (
                !collectionContractMatchesRef(input.sourceContract, binding.source)
                || !collectionContractMatchesRef(input.targetContract, binding.target)
                || !admittedTargetContract
                || !collectionContractMatchesRef(admittedTargetContract, binding.target)
                || admittedTargetContract.contractDigest !== input.targetContract.contractDigest
            ) {
                throw dataError(
                    'collection_candidate_preparation_contract_mismatch',
                    'Collection candidate contracts do not match their exact binding',
                );
            }
            const sourceContract = input.sourceContract;
            const targetContract = input.targetContract;

            const targetDeclarations = input.declarations.filter((declaration) => (
                declaration.id === binding.target.collectionId
            ));
            if (targetDeclarations.length !== 1) {
                throw dataError(
                    'collection_candidate_preparation_invalid',
                    'Collection candidate target declaration is not unique',
                );
            }
            const parsedTargetDeclaration = PluginAccountCollectionContributionV1Schema.safeParse(targetDeclarations[0]);
            if (!parsedTargetDeclaration.success) {
                throw dataError(
                    'collection_candidate_preparation_invalid',
                    'Collection candidate target declaration is invalid',
                );
            }
            let declaredTargetContract: NormalizedPluginAccountCollectionContractV1;
            try {
                declaredTargetContract = normalizePluginAccountCollectionContractV1({
                    pluginId: binding.target.pluginId,
                    contribution: parsedTargetDeclaration.data,
                });
            } catch {
                throw dataError(
                    'collection_candidate_preparation_invalid',
                    'Collection candidate target declaration could not be normalized',
                );
            }
            if (
                !collectionContractMatchesRef(declaredTargetContract, binding.target)
                || declaredTargetContract.contractDigest !== targetContract.contractDigest
            ) {
                throw dataError(
                    'collection_candidate_preparation_contract_mismatch',
                    'Collection candidate target declaration does not match its admitted contract',
                );
            }

            let runtime: PluginAccountCollectionMigrationRuntimeProjection;
            try {
                runtime = normalizePluginAccountCollectionMigrationRuntimeProjection(
                    input.runtime,
                    input.declarations,
                );
            } catch {
                throw dataError(
                    'collection_candidate_preparation_invalid',
                    'Collection candidate migration callbacks do not match the target declarations',
                );
            }
            const targetMigrations = runtime[binding.target.collectionId];
            if (!targetMigrations) {
                throw dataError(
                    'collection_candidate_preparation_invalid',
                    'Collection candidate target migration callbacks are unavailable',
                );
            }

            let sourceValidate: ReturnType<typeof compilePluginJsonSchema>;
            let targetValidate: ReturnType<typeof compilePluginJsonSchema>;
            try {
                sourceValidate = compilePluginJsonSchema(sourceContract.schema);
                targetValidate = compilePluginJsonSchema(targetContract.schema);
            } catch {
                throw dataError(
                    'collection_candidate_preparation_invalid',
                    'Collection candidate contract schema is invalid',
                );
            }
            const source: BoundCollection = Object.freeze({ contract: sourceContract, validate: sourceValidate });
            const target: BoundCollection = Object.freeze({ contract: targetContract, validate: targetValidate });
            const abort = new AbortController();
            const lifecycle: BoundAccountDataLifecycle = {
                pluginId: binding.target.pluginId,
                signal: composeOperationSignal(input.signal, abort.signal),
                isGenerationCurrent: input.isGenerationCurrent,
                accountLifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
            };
            const requestContext = createBoundRequestContext(lifecycle);
            // This is deliberately not a general Account request port. It is
            // captured only after ordinary current-Account admission, closes
            // over one exact retire request, and is released on its one use
            // so an A→B transition can clean A stages without issuing B work.
            let postExactRetire: (() => Promise<void>) | null = null;
            const captureExactRetire = (credentials: StoredCredentials): void => {
                if (postExactRetire) return;
                let requestBody: ReturnType<typeof PluginCollectionCandidatePreparationRetireRequestV1Schema.parse>;
                let baseUrl: string;
                try {
                    requestBody = PluginCollectionCandidatePreparationRetireRequestV1Schema.parse({ binding });
                    baseUrl = resolveBaseUrl();
                } catch {
                    throw dataError(
                        'collection_candidate_preparation_invalid',
                        'Collection candidate retirement authority could not be captured',
                    );
                }
                let retainedCredentials: StoredCredentials | null = credentials;
                let retainedBaseUrl: string | null = baseUrl;
                postExactRetire = async (): Promise<void> => {
                    try {
                        const exactCredentials = retainedCredentials;
                        const exactBaseUrl = retainedBaseUrl;
                        if (!exactCredentials || !exactBaseUrl) {
                            throw dataError(
                                'collection_candidate_preparation_invalid',
                                'Collection candidate retirement authority was already released',
                            );
                        }
                        const response = await http.post(
                            `${exactBaseUrl}${PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1}`,
                            requestBody,
                            requestConfig(exactCredentials, new AbortController().signal),
                        );
                        if (response.status < 200 || response.status >= 300) {
                            throw parseCandidatePreparationError(response.data)
                                ?? dataError(
                                    ACCOUNT_DATA_UNAVAILABLE_CODE,
                                    'Collection candidate retirement is unavailable',
                                    response.status >= 500,
                                );
                        }
                        const parsed = PluginCollectionCandidatePreparationRetireResultV1Schema.safeParse(response.data);
                        if (!parsed.success) {
                            throw dataError(
                                COLLECTION_PROTOCOL_INVALID_CODE,
                                'Collection candidate retirement response is invalid',
                            );
                        }
                    } catch (error) {
                        if (isPluginError(error)) throw error;
                        throw dataError(
                            ACCOUNT_DATA_UNAVAILABLE_CODE,
                            'Collection candidate retirement request failed',
                            true,
                        );
                    } finally {
                        retainedCredentials = null;
                        retainedBaseUrl = null;
                    }
                };
            };

            const prepareCandidate = async (): Promise<void> => {
                const chain = resolveCandidateMigrationChain({
                    sourceSchemaVersion: source.contract.schemaVersion,
                    targetSchemaVersion: target.contract.schemaVersion,
                    migrations: targetMigrations,
                });
                let cursor: string | undefined;
                for (;;) {
                    await assertBoundCurrent(lifecycle);
                    const credentials = await requestContext.currentCredentials();
                    captureExactRetire(credentials);
                    let requestBody: ReturnType<typeof PluginCollectionCandidatePreparationSourcePageRequestV1Schema.parse>;
                    try {
                        requestBody = PluginCollectionCandidatePreparationSourcePageRequestV1Schema.parse({
                            binding,
                            ...(cursor === undefined ? {} : { cursor }),
                            limit: 50,
                        });
                    } catch {
                        throw dataError(
                            'collection_candidate_preparation_invalid',
                            'Collection candidate source page request is invalid',
                        );
                    }
                    const response = await requestContext.post({
                        path: PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1,
                        body: requestBody,
                        credentials,
                        parseError: parseCandidatePreparationError,
                        unavailableMessage: 'Collection candidate source page is unavailable',
                    });
                    const parsed = PluginCollectionCandidatePreparationSourcePageResultV1Schema.safeParse(response);
                    if (!parsed.success) {
                        throw dataError(
                            COLLECTION_PROTOCOL_INVALID_CODE,
                            'Collection candidate source page response is invalid',
                        );
                    }
                    const stageItems: CandidatePreparationStageItem[] = [];
                    for (const sourceRow of parsed.data.rows) {
                        await assertBoundCurrent(lifecycle);
                        if (sourceRow.alreadyStaged) continue;

                        const sourceCredentials = await requestContext.currentCredentials();
                        const sourceEncryption = await requestContext.currentEncryption(sourceCredentials);
                        const logical = mergeLogicalRow<PluginAccountCollectionValue<PluginAccountCollectionDefinition>>({
                            collection: source,
                            row: sourceRow,
                            encryptionMode: sourceEncryption.mode,
                            material: sourceEncryption.material,
                        });
                        let targetValue = logical.value;
                        for (const migration of chain) {
                            await assertBoundCurrent(lifecycle);
                            targetValue = await migration.migrate(targetValue);
                            await assertBoundCurrent(lifecycle);
                        }

                        const targetCredentials = await requestContext.currentCredentials();
                        const targetEncryption = await requestContext.currentEncryption(targetCredentials);
                        const targetOperation = splitLogicalPut({
                            collection: target,
                            value: targetValue,
                            encryptionMode: targetEncryption.mode,
                            material: targetEncryption.material,
                            randomBytes,
                        });
                        if (targetOperation.rowId !== sourceRow.rowId) {
                            throw dataError(
                                'collection_candidate_preparation_invalid',
                                'Collection candidate migration changed a row identity',
                            );
                        }
                        stageItems.push({
                            source: {
                                rowId: sourceRow.rowId,
                                revision: sourceRow.revision,
                            },
                            target: {
                                content: targetOperation.content,
                                projection: targetOperation.projection,
                            },
                        });
                    }
                    if (stageItems.length > 0) {
                        await assertBoundCurrent(lifecycle);
                        let stageRequests: readonly CandidatePreparationStageRequest[];
                        try {
                            const collectionLimits = readKnownCollectionLimits();
                            stageRequests = collectionLimits
                                ? splitPluginCollectionCandidatePreparationStageRequestsForKnownLimitsV1({
                                    binding,
                                    items: stageItems,
                                    limits: collectionLimits,
                                })
                                : [PluginCollectionCandidatePreparationStageRequestV1Schema.parse({
                                    binding,
                                    items: stageItems,
                                })];
                        } catch {
                            throw dataError(
                                'collection_candidate_preparation_invalid',
                                'Collection candidate target stage is invalid',
                            );
                        }
                        for (const stageRequest of stageRequests) {
                            const stageCredentials = await requestContext.currentCredentials();
                            await assertBoundCurrent(lifecycle);
                            const stageResponse = await requestContext.post({
                                path: PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1,
                                body: stageRequest,
                                credentials: stageCredentials,
                                parseError: parseCandidatePreparationError,
                                unavailableMessage: 'Collection candidate stage is unavailable',
                            });
                            await assertBoundCurrent(lifecycle);
                            const stageResult = PluginCollectionCandidatePreparationStageResultV1Schema.safeParse(stageResponse);
                            if (!stageResult.success || stageResult.data.results.length !== stageRequest.items.length) {
                                throw dataError(
                                    COLLECTION_PROTOCOL_INVALID_CODE,
                                    'Collection candidate stage response is invalid',
                                );
                            }
                            if (stageResult.data.results.some((result) => result.status === 'sourceChanged')) {
                                throw dataError(
                                    'collection_candidate_preparation_source_changed',
                                    'Collection candidate source changed before its target stage could be recorded',
                                );
                            }
                        }
                    }
                    cursor = parsed.data.nextCursor;
                    if (cursor === undefined) return;
                }
            };

            let activePreparation: Promise<void> | null = null;
            let retirement: Promise<void> | null = null;
            const prepare = (): Promise<void> => {
                if (activePreparation) return activePreparation;
                const operation = prepareCandidate();
                activePreparation = operation;
                const clearActivePreparation = (): void => {
                    if (activePreparation === operation) activePreparation = null;
                };
                void operation.then(clearActivePreparation, clearActivePreparation);
                return operation;
            };
            const retire = (): Promise<void> => {
                if (retirement) return retirement;
                abort.abort();
                const draining = activePreparation;
                const capturedPostExactRetire = postExactRetire;
                // Drop the only retained A authority before awaiting the
                // drain. The closure remains reachable only by this one
                // retirement operation and accepts no caller-controlled data.
                postExactRetire = null;
                retirement = (async () => {
                    try {
                        await draining;
                    } catch {
                        // The exact retire endpoint owns the durable cleanup;
                        // cancellation/staleness is expected while draining.
                    }
                    await capturedPostExactRetire?.();
                })();
                return retirement;
            };
            return Object.freeze({ prepare, retire });
        },
        bind(binding): PluginAccountStorageScope | null {
            // Account Data is not an ambient fallback service. Activation only
            // vends it while the canonical Account lifetime is already known;
            // after that admission, each operation retains its typed
            // currentness and mode checks as the Account can move.
            if (binding.signal.aborted || currentAccountScopeKey() === null) {
                return null;
            }
            const lifecycle: BoundAccountDataLifecycle = {
                pluginId: binding.pluginId,
                signal: binding.signal,
                isGenerationCurrent: binding.isGenerationCurrent,
                accountLifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
            };
            const kvScopeIdentity = Object.freeze({});
            const latestQueryCursorByCollectionKey = new Map<string, Readonly<{
                accountScopeKey: string;
                changeCursor: number;
            }>>();

            const collectionQueryCursorKey = (
                contract: NormalizedPluginAccountCollectionContractV1,
            ): string => `${contract.pluginId}\u0000${contract.collectionId}\u0000${contract.contractDigest}`;

            const recordCollectionQueryCursor = (
                contract: NormalizedPluginAccountCollectionContractV1,
                accountScopeKey: string,
                changeCursor: number,
            ): void => {
                const key = collectionQueryCursorKey(contract);
                const previous = latestQueryCursorByCollectionKey.get(key);
                if (
                    previous === undefined
                    || previous.accountScopeKey !== accountScopeKey
                    || changeCursor > previous.changeCursor
                ) {
                    latestQueryCursorByCollectionKey.set(key, Object.freeze({ accountScopeKey, changeCursor }));
                }
            };

            const {
                assertCurrentAccount,
                signalFor,
                currentCredentials,
                currentEncryption,
                request,
            } = createBoundRequestContext(lifecycle);

            type AccountKvSnapshot = Readonly<{
                row: PluginAccountStorageRowV1;
                expectedRevision: number | 'absent';
                credentials: StoredCredentials;
                mode: 'plain' | 'e2ee';
                material: AccountScopedCryptoMaterial | null;
            }>;

            const accountKvUrl = (): string => (
                `${resolveBaseUrl()}/v1/account/plugin-storage/${encodeURIComponent(lifecycle.pluginId)}`
            );

            const readAccountKvSnapshot = async (operationSignal?: AbortSignal): Promise<AccountKvSnapshot> => {
                const credentials = await currentCredentials(operationSignal);
                const encryption = await currentEncryption(credentials, operationSignal);
                const signal = signalFor(operationSignal);
                let response: Readonly<{ status: number; data: unknown }>;
                try {
                    response = await http.get(accountKvUrl(), requestConfig(credentials, signal));
                    await assertCurrentAccount(credentials, operationSignal);
                } catch (error) {
                    await assertBoundCurrent(lifecycle, operationSignal);
                    if (isPluginError(error)) throw error;
                    throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account KV read request failed', true);
                }
                if (response.status < 200 || response.status >= 300) {
                    const unavailable = PluginAccountStorageUnavailableV1Schema.safeParse(response.data);
                    throw unavailable.success
                        ? dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account KV is unavailable on this server')
                        : dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account KV read is unavailable', response.status >= 500);
                }
                const parsed = PluginAccountStorageReadResponseV1Schema.safeParse(response.data);
                if (!parsed.success) {
                    throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Account KV read response is invalid');
                }
                if (parsed.data.status === 'absent') {
                    return Object.freeze({
                        row: createEmptyAccountKvRow(),
                        expectedRevision: 'absent' as const,
                        credentials,
                        mode: encryption.mode,
                        material: encryption.material,
                    });
                }
                if (parsed.data.status === 'deleted') {
                    return Object.freeze({
                        row: createEmptyAccountKvRow(),
                        expectedRevision: parsed.data.revision,
                        credentials,
                        mode: encryption.mode,
                        material: encryption.material,
                    });
                }
                let row: PluginAccountStorageRowV1 | null = null;
                try {
                    const envelope = assertPluginAccountStorageEnvelopeForModeV1(parsed.data.content, encryption.mode);
                    row = envelope.t === 'plain'
                        ? envelope.v
                        : encryption.material
                            ? openPluginAccountStoragePrivatePayloadV1({ material: encryption.material, ciphertext: envelope.c })
                            : null;
                } catch {
                    row = null;
                }
                if (!row) {
                    throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Account KV content does not match the current Account mode');
                }
                return Object.freeze({
                    row,
                    expectedRevision: parsed.data.revision,
                    credentials,
                    mode: encryption.mode,
                    material: encryption.material,
                });
            };

            const writeAccountKvSnapshot = async (input: Readonly<{
                snapshot: AccountKvSnapshot;
                row: PluginAccountStorageRowV1;
                operationSignal?: AbortSignal;
            }>): Promise<void> => {
                const encryption = await currentEncryption(input.snapshot.credentials, input.operationSignal);
                await assertCurrentAccount(input.snapshot.credentials, input.operationSignal);
                let content: unknown;
                try {
                    content = Object.keys(input.row.values).length === 0
                        ? null
                        : encryption.mode === 'plain'
                            ? { t: 'plain' as const, v: PluginAccountStorageRowV1Schema.parse(input.row) }
                            : {
                                t: 'encrypted' as const,
                                c: sealPluginAccountStoragePrivatePayloadV1({
                                    material: encryption.material ?? (() => {
                                        throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account encryption material is unavailable');
                                    })(),
                                    payload: PluginAccountStorageRowV1Schema.parse(input.row),
                                    randomBytes,
                                }),
                            };
                } catch (error) {
                    if (isPluginError(error)) throw error;
                    throw dataError(ACCOUNT_KV_INVALID_CODE, 'Account KV row exceeds its published bounds');
                }
                let body: ReturnType<typeof PluginAccountStorageMutationRequestV1Schema.parse>;
                try {
                    body = PluginAccountStorageMutationRequestV1Schema.parse({
                        expectedRevision: input.snapshot.expectedRevision,
                        content,
                    });
                } catch {
                    throw dataError(ACCOUNT_KV_INVALID_CODE, 'Account KV mutation does not satisfy the wire contract');
                }
                const signal = signalFor(input.operationSignal);
                let response: Readonly<{ status: number; data: unknown }>;
                try {
                    response = await http.post(accountKvUrl(), body, requestConfig(input.snapshot.credentials, signal));
                    await assertCurrentAccount(input.snapshot.credentials, input.operationSignal);
                } catch (error) {
                    await assertBoundCurrent(lifecycle, input.operationSignal);
                    if (isPluginError(error)) throw error;
                    throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account KV write request failed', true);
                }
                if (response.status < 200 || response.status >= 300) {
                    const unavailable = PluginAccountStorageUnavailableV1Schema.safeParse(response.data);
                    throw unavailable.success
                        ? dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account KV is unavailable on this server')
                        : dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account KV write is unavailable', response.status >= 500);
                }
                const parsed = PluginAccountStorageMutationResponseV1Schema.safeParse(response.data);
                if (!parsed.success) {
                    throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Account KV mutation response is invalid');
                }
                if (parsed.data.status === 'conflict') {
                    throw dataError(ACCOUNT_KV_CONFLICT_CODE, 'Account KV changed before the conditional write completed');
                }
                await assertCurrentAccount(input.snapshot.credentials, input.operationSignal);
            };

            const createAccountKvScope = (): AccountKvService => {
                const assertKvMutationNotReentrant = (): void => {
                    if (accountKvTransactionContext.getStore()?.has(kvScopeIdentity)) {
                        throw dataError(ACCOUNT_KV_INVALID_CODE, 'Account KV mutations must use the active transaction handle');
                    }
                };
                const assertKvTransactionNotNested = (): void => {
                    if ((accountKvTransactionContext.getStore()?.size ?? 0) > 0) {
                        throw dataError(ACCOUNT_KV_INVALID_CODE, 'Nested Account KV transactions are unavailable');
                    }
                };
                const mutate = async <T>(
                    operation: (transaction: AccountKvTransaction) => Promise<T>,
                    operationSignal?: AbortSignal,
                ): Promise<T> => {
                    await assertBoundCurrent(lifecycle, operationSignal);
                    const snapshot = await readAccountKvSnapshot(operationSignal);
                    const row = cloneAccountKvRow(snapshot.row);
                    let active = true;
                    let mutated = false;
                    const assertTransactionActive = async (signal?: AbortSignal): Promise<void> => {
                        if (!active) {
                            throw dataError(ACCOUNT_KV_INVALID_CODE, 'Account KV transaction handle is no longer active');
                        }
                        await assertBoundCurrent(lifecycle, signal ?? operationSignal);
                    };
                    const transaction: AccountKvTransaction = Object.freeze({
                        async get<TValue extends JsonValue = JsonValue>(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                            await assertTransactionActive(options?.signal);
                            const entry = accountKvEntryAt(row, normalizeAccountKvKey(key));
                            return entry ? toAccountKvEntry<TValue>(entry) : null;
                        },
                        async set(key: string, value: JsonValue, options: Readonly<{
                            expectedVersion: number | 'absent';
                            signal?: AbortSignal;
                        }>) {
                            await assertTransactionActive(options?.signal);
                            const normalizedKey = normalizeAccountKvKey(key);
                            const previous = assertAccountKvExpectedVersion(
                                row,
                                normalizedKey,
                                options.expectedVersion,
                            );
                            const version = setAccountKvEntry(row, normalizedKey, value, previous);
                            mutated = true;
                            return Object.freeze({ version });
                        },
                        async delete(key: string, options: Readonly<{
                            expectedVersion: number;
                            signal?: AbortSignal;
                        }>) {
                            await assertTransactionActive(options?.signal);
                            const normalizedKey = normalizeAccountKvKey(key);
                            const previous = assertAccountKvExpectedVersion(
                                row,
                                normalizedKey,
                                options.expectedVersion,
                            );
                            if (!previous) {
                                throw dataError(ACCOUNT_KV_CONFLICT_CODE, 'Account KV key is absent');
                            }
                            const version = deleteAccountKvEntry(row, normalizedKey, previous);
                            mutated = true;
                            return Object.freeze({ version, deleted: true as const });
                        },
                    });
                    try {
                        const result = await accountKvTransactionContext.run(
                            new Set([kvScopeIdentity]),
                            async () => await operation(transaction),
                        );
                        await assertBoundCurrent(lifecycle, operationSignal);
                        if (mutated) {
                            await writeAccountKvSnapshot({ snapshot, row, operationSignal });
                        }
                        await assertBoundCurrent(lifecycle, operationSignal);
                        return result;
                    } finally {
                        active = false;
                    }
                };

                return Object.freeze({
                    async get<TValue extends JsonValue = JsonValue>(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                        await assertBoundCurrent(lifecycle, options?.signal);
                        const snapshot = await readAccountKvSnapshot(options?.signal);
                        const entry = accountKvEntryAt(snapshot.row, normalizeAccountKvKey(key));
                        return entry ? toAccountKvEntry<TValue>(entry) : null;
                    },
                    async set(key: string, value: JsonValue, options: Readonly<{
                        expectedVersion: number | 'absent';
                        signal?: AbortSignal;
                    }>) {
                        assertKvMutationNotReentrant();
                        return await mutate(
                            async (transaction) => await transaction.set(key, value, options),
                            options.signal,
                        );
                    },
                    async delete(key: string, options: Readonly<{
                        expectedVersion: number;
                        signal?: AbortSignal;
                    }>) {
                        assertKvMutationNotReentrant();
                        return await mutate(
                            async (transaction) => await transaction.delete(key, options),
                            options.signal,
                        );
                    },
                    async list(options: Readonly<{
                        cursor?: string;
                        limit?: number;
                        prefix?: string;
                        signal?: AbortSignal;
                    }> = {}) {
                        await assertBoundCurrent(lifecycle, options.signal);
                        // Validate the request shape before spending a read, then
                        // page through the Protocol row owner so the daemon and the
                        // direct Plugin UI client cannot disagree about ordering,
                        // cursor identity, or tombstone visibility.
                        inAccountKvRowAlgebra(() => listPluginAccountKvEntriesV1({
                            row: createEmptyAccountKvRow(),
                            revision: -1,
                            ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
                            ...(options.limit === undefined ? {} : { limit: options.limit }),
                        }));
                        const snapshot = await readAccountKvSnapshot(options.signal);
                        return inAccountKvRowAlgebra(() => listPluginAccountKvEntriesV1({
                            row: snapshot.row,
                            revision: snapshot.expectedRevision === 'absent' ? -1 : snapshot.expectedRevision,
                            ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
                            ...(options.limit === undefined ? {} : { limit: options.limit }),
                            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
                        })) as Readonly<{
                            items: readonly AccountKvListItem[];
                            nextCursor?: string;
                        }>;
                    },
                    async transaction<T>(operation: (transaction: AccountKvTransaction) => Promise<T>, options?: Readonly<{ signal?: AbortSignal }>) {
                        assertKvTransactionNotNested();
                        return await mutate(operation, options?.signal);
                    },
                });
            };

            const bindDeclaredCollection = <TDefinition extends PluginAccountCollectionDefinition>(
                definition: TDefinition,
            ): PluginAccountCollectionForDefinition<TDefinition> => {
                let requested: NormalizedPluginAccountCollectionContractV1 | null = null;
                try {
                    const parsed = PluginAccountCollectionContributionV1Schema.safeParse(
                        projectPluginAccountCollectionDeclaration(definition.id, definition),
                    );
                    requested = parsed.success
                        ? normalizePluginAccountCollectionContractV1({
                            pluginId: lifecycle.pluginId,
                            contribution: parsed.data,
                        })
                        : null;
                } catch {
                    requested = null;
                }
                const admitted = requested
                    ? contractsByPluginAndCollection.get(`${lifecycle.pluginId}\u0000${requested.collectionId}`)
                    : null;
                if (!admitted || admitted.contractDigest !== requested?.contractDigest) {
                    return createUnavailableAccountCollection<TDefinition>(COLLECTION_UNDECLARED_CODE);
                }
                let validate: ReturnType<typeof compilePluginJsonSchema>;
                try {
                    validate = compilePluginJsonSchema(admitted.schema);
                } catch {
                    return createUnavailableAccountCollection<TDefinition>(COLLECTION_UNDECLARED_CODE);
                }
                const collection: BoundCollection = Object.freeze({ contract: admitted, validate });

                /**
                 * The one place a plugin's logical mutations become wire
                 * operations. `measureBatch` and `batch` share it so a plugin
                 * that sizes its own batches measures exactly the bytes the
                 * mutation will send, private envelope and projection included.
                 */
                const sealMutationRequest = async (
                    operations: readonly PluginCollectionMutation<PluginAccountCollectionValue<PluginAccountCollectionDefinition>>[],
                    operationSignal?: AbortSignal,
                ): Promise<Readonly<{
                    credentials: StoredCredentials;
                    request: PluginCollectionMutationRequestV1;
                }>> => {
                    const credentials = await currentCredentials(operationSignal);
                    const encryption = await currentEncryption(credentials, operationSignal);
                    let wireOperations: PluginCollectionMutationOperationV1[];
                    try {
                        wireOperations = operations.map((operation) => {
                            if (operation.kind === 'delete') {
                                return {
                                    kind: 'delete' as const,
                                    rowId: PluginCollectionRowIdV1Schema.parse(operation.rowId),
                                    expectedRevision: operation.expectedRevision,
                                };
                            }
                            if (operation.kind === 'assert') {
                                return {
                                    kind: 'assert' as const,
                                    rowId: PluginCollectionRowIdV1Schema.parse(operation.rowId),
                                    expectedRevision: operation.expectedRevision,
                                };
                            }
                            const put = splitLogicalPut({
                                collection,
                                value: operation.value,
                                encryptionMode: encryption.mode,
                                material: encryption.material,
                                randomBytes,
                            });
                            return { ...put, expectedRevision: operation.expectedRevision };
                        });
                    } catch (error) {
                        if (isPluginError(error)) throw error;
                        throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection batch is invalid');
                    }
                    try {
                        return Object.freeze({
                            credentials,
                            request: PluginCollectionMutationRequestV1Schema.parse({
                                pluginId: lifecycle.pluginId,
                                collectionId: collection.contract.collectionId,
                                writerContext: {
                                    schemaVersion: collection.contract.schemaVersion,
                                    contractDigest: collection.contract.contractDigest,
                                },
                                operations: wireOperations,
                            }),
                        });
                    } catch {
                        throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection mutation does not satisfy the wire contract');
                    }
                };

                const mutate = async (
                    operations: readonly PluginCollectionMutation<PluginAccountCollectionValue<PluginAccountCollectionDefinition>>[],
                    operationSignal?: AbortSignal,
                ): Promise<PluginCollectionMutationResultV1> => {
                    await assertBoundCurrent(lifecycle, operationSignal);
                    if (operations.length === 0 || operations.length > 100) {
                        throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection batch must contain between one and one hundred operations');
                    }
                    const sealed = await sealMutationRequest(operations, operationSignal);
                    const { credentials, request: requestBody } = sealed;
                    // This is intentionally advisory and cache-only. The
                    // server remains the sole owner of row, collection, and
                    // Account aggregate enforcement, while a known current
                    // capability can reject an otherwise-certain batch before
                    // its transport side effect.
                    const collectionLimits = readKnownCollectionLimits();
                    if (collectionLimits) {
                        const encodedBytes = measurePluginCollectionMutationRequestEncodedBytesV1(requestBody);
                        const incompatibility = requestBody.operations.length > collectionLimits.maxBatchRows
                            ? {
                                dimension: 'maxBatchRows' as const,
                                effectiveMaximum: collectionLimits.maxBatchRows,
                            }
                            : encodedBytes > collectionLimits.maxBatchBytes
                                ? {
                                    dimension: 'maxBatchBytes' as const,
                                    effectiveMaximum: collectionLimits.maxBatchBytes,
                                }
                                : null;
                        if (incompatibility) {
                            throw dataError(
                                'collection_quota_incompatible',
                                'Collection batch exceeds the known server deployment limit',
                                false,
                                incompatibility,
                            );
                        }
                    }
                    const response = await request({
                        path: PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
                        body: requestBody,
                        kind: 'mutation',
                        credentials,
                        operationSignal,
                    });
                    const parsed = PluginCollectionMutationResultV1Schema.safeParse(response);
                    if (!parsed.success) {
                        throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection mutation response is invalid');
                    }
                    await assertCurrentAccount(credentials, operationSignal);
                    return parsed.data;
                };

                const materialize = (
                    row: PluginCollectionRowV1,
                    mode: 'plain' | 'e2ee',
                    material: AccountScopedCryptoMaterial | null,
                ): PluginCollectionRow<PluginAccountCollectionValue<TDefinition>> => mergeLogicalRow<PluginAccountCollectionValue<TDefinition>>({
                    collection,
                    row,
                    encryptionMode: mode,
                    material,
                });

                // `identityFields` is the contract's single declaration of
                // which fields hold a mode-derived identity, and it is what the
                // Account encryption-transition owner reads to refuse a
                // transition it cannot relocate. Admitting the wider
                // row-id-plus-index set here would let a plugin mint a
                // mode-bound value the transition owner cannot see, which is
                // then silently rekeyed past and stranded at an address the
                // plugin can no longer derive.
                const declaredIdentityFields = new Set<string>(
                    collection.contract.identityFields,
                );

                const bound: PluginAccountCollectionForDefinition<TDefinition> = Object.freeze({
                    async identityTag(
                        request: Readonly<{ field: string; components: readonly string[] }>,
                        options?: Readonly<{ signal?: AbortSignal }>,
                    ) {
                        // The admitted contract, not the caller, decides which
                        // purposes exist: an undeclared field is an undeclared
                        // derivation domain and is rejected rather than stamped
                        // through.
                        if (!declaredIdentityFields.has(request.field)) {
                            throw dataError(
                                COLLECTION_INVALID_VALUE_CODE,
                                'Collection identity tag names a field the admitted contract does not declare',
                            );
                        }
                        const credentials = await currentCredentials(options?.signal);
                        const encryption = await currentEncryption(credentials, options?.signal);
                        await assertCurrentAccount(credentials, options?.signal);
                        return derivePluginCollectionIdentityTagV1({
                            accountEncryptionMode: encryption.mode,
                            material: encryption.material,
                            pluginId: lifecycle.pluginId,
                            collectionId: collection.contract.collectionId,
                            field: request.field,
                            components: request.components,
                        });
                    },
                    async get(rowId: string, options?: Readonly<{ signal?: AbortSignal }>) {
                        const credentials = await currentCredentials(options?.signal);
                        const encryption = await currentEncryption(credentials, options?.signal);
                        let requestBody: ReturnType<typeof PluginCollectionGetRequestV1Schema.parse>;
                        try {
                            requestBody = PluginCollectionGetRequestV1Schema.parse({
                                pluginId: lifecycle.pluginId,
                                collectionId: collection.contract.collectionId,
                                rowId,
                            });
                        } catch {
                            throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection row identity is invalid');
                        }
                        const response = await request({
                            path: PLUGIN_COLLECTION_GET_HTTP_PATH_V1,
                            body: requestBody,
                            kind: 'read',
                            credentials,
                            operationSignal: options?.signal,
                        });
                        const parsed = PluginCollectionGetResultV1Schema.safeParse(response);
                        if (!parsed.success) {
                            throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection read response is invalid');
                        }
                        await assertCurrentAccount(credentials, options?.signal);
                        return parsed.data.row
                            ? materialize(parsed.data.row, encryption.mode, encryption.material)
                            : null;
                    },
                    async put(
                        value: PluginAccountCollectionValue<TDefinition>,
                        options: Readonly<{ expectedRevision: number | 'absent'; signal?: AbortSignal }>,
                    ) {
                        const result = await mutate([{
                            kind: 'put',
                            value,
                            expectedRevision: options.expectedRevision,
                        }], options.signal);
                        if (result.status === 'conflict') {
                            throw dataError(COLLECTION_CONFLICT_CODE, 'Collection mutation conflicted with a newer row revision');
                        }
                        const entry = result.results[0];
                        if (!entry || entry.deleted) {
                            throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection mutation response omitted its updated row');
                        }
                        const logical = splitLogicalPut({
                            collection,
                            value,
                            encryptionMode: 'plain',
                            material: null,
                            randomBytes,
                        });
                        if (entry.rowId !== logical.rowId) {
                            throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection mutation response changed the row identity');
                        }
                        const projection = logical.projection;
                        const row = mergeLogicalRow<PluginAccountCollectionValue<TDefinition>>({
                            collection,
                            row: {
                                rowId: entry.rowId,
                                revision: entry.revision,
                                content: { t: 'plain', v: logical.content.t === 'plain' ? logical.content.v : {} },
                                projection,
                            },
                            encryptionMode: 'plain',
                            material: null,
                        });
                        return row;
                    },
                    async delete(rowId: string, options: Readonly<{ expectedRevision: number; signal?: AbortSignal }>) {
                        const result = await mutate([{
                            kind: 'delete',
                            rowId,
                            expectedRevision: options.expectedRevision,
                        }], options.signal);
                        if (result.status === 'conflict') {
                            throw dataError(COLLECTION_CONFLICT_CODE, 'Collection mutation conflicted with a newer row revision');
                        }
                        const entry = result.results[0];
                        if (!entry || !entry.deleted || entry.rowId !== rowId) {
                            throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection delete response omitted its deleted row');
                        }
                        return Object.freeze({ rowId: entry.rowId, revision: entry.revision, deleted: true as const });
                    },
                    async query(requestInput: PluginCollectionQuery, options?: Readonly<{ signal?: AbortSignal }>) {
                        const credentials = await currentCredentials(options?.signal);
                        const encryption = await currentEncryption(credentials, options?.signal);
                        if (!collection.contract.indexes.some((index) => index.id === requestInput.index)) {
                            throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection query names an undeclared index');
                        }
                        let requestBody: ReturnType<typeof PluginCollectionQueryRequestV1Schema.parse>;
                        try {
                            requestBody = PluginCollectionQueryRequestV1Schema.parse({
                                pluginId: lifecycle.pluginId,
                                collectionId: collection.contract.collectionId,
                                indexId: requestInput.index,
                                prefix: requestInput.prefix ?? [],
                                ...(requestInput.range ? { range: requestInput.range } : {}),
                                order: requestInput.order,
                                ...(requestInput.cursor ? { cursor: requestInput.cursor } : {}),
                                ...(requestInput.limit ? { limit: requestInput.limit } : {}),
                            });
                        } catch {
                            throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection query is invalid');
                        }
                        const response = await request({
                            path: PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
                            body: requestBody,
                            kind: 'read',
                            credentials,
                            operationSignal: options?.signal,
                        });
                        const parsed = PluginCollectionQueryResultV1Schema.safeParse(response);
                        if (!parsed.success) {
                            throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection query response is invalid');
                        }
                        await assertCurrentAccount(credentials, options?.signal);
                        const accountScopeKey = currentAccountScopeKey();
                        if (accountScopeKey) {
                            recordCollectionQueryCursor(collection.contract, accountScopeKey, parsed.data.changeCursor);
                        }
                        return Object.freeze({
                            rows: Object.freeze(parsed.data.rows.map((row) => (
                                materialize(row, encryption.mode, encryption.material)
                            ))),
                            ...(parsed.data.nextCursor ? { nextCursor: parsed.data.nextCursor } : {}),
                            changeCursor: parsed.data.changeCursor,
                        });
                    },
                    async batch(
                        operations: readonly PluginCollectionMutation<PluginAccountCollectionValue<TDefinition>>[],
                        options?: Readonly<{ signal?: AbortSignal }>,
                    ) {
                        return await mutate(operations, options?.signal);
                    },
                    async limits(options?: Readonly<{ signal?: AbortSignal }>) {
                        await assertBoundCurrent(lifecycle, options?.signal);
                        return resolveEffectivePluginCollectionLimitsV1({
                            deployment: readKnownCollectionLimits(),
                            quota: collection.contract.quota,
                        });
                    },
                    async measureBatch(
                        operations: readonly PluginCollectionMutation<PluginAccountCollectionValue<TDefinition>>[],
                        options?: Readonly<{ signal?: AbortSignal }>,
                    ) {
                        await assertBoundCurrent(lifecycle, options?.signal);
                        if (operations.length === 0) {
                            throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection batch measurement requires at least one operation');
                        }
                        // A plugin measures precisely because its candidates do
                        // not fit one request, so measurement seals in
                        // request-sized windows. Costs are additive and the
                        // shell is identical in every window, so the reported
                        // decomposition is exact for any subset.
                        const window = PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchRows;
                        const operationEncodedBytes: number[] = [];
                        let overheadEncodedBytes = 0;
                        for (let offset = 0; offset < operations.length; offset += window) {
                            const sealed = await sealMutationRequest(
                                operations.slice(offset, offset + window),
                                options?.signal,
                            );
                            const measured = measurePluginCollectionMutationRequestDecompositionV1(
                                sealed.request,
                            );
                            overheadEncodedBytes = measured.overheadEncodedBytes;
                            operationEncodedBytes.push(...measured.operationEncodedBytes);
                        }
                        return Object.freeze({
                            overheadEncodedBytes,
                            operationEncodedBytes: Object.freeze(operationEncodedBytes),
                        });
                    },
                    watch(
                        requestInput: PluginCollectionWatchQuery<PluginAccountCollectionIndexes<TDefinition>>,
                        listener: (invalidation: PluginCollectionInvalidation) => void,
                    ) {
                        // `watch()` is a synchronous SDK API, but Resource
                        // admission currentness is asynchronous. A sync stale
                        // binding still fails synchronously; an async one
                        // starts only after its canonical Account-owner check
                        // resolves and never delivers a stale hint.
                        const initialCurrentness = checkBoundCurrent(lifecycle);
                        if (!('kind' in requestInput) && !collection.contract.indexes.some((index) => index.id === requestInput.index)) {
                            throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection watch names an undeclared index');
                        }
                        let disposed = false;
                        let upstreamDispose: (() => void) | null = null;
                        const dispose = (): void => {
                            if (disposed) return;
                            disposed = true;
                            lifecycle.signal.removeEventListener('abort', dispose);
                            upstreamDispose?.();
                        };
                        lifecycle.signal.addEventListener('abort', dispose, { once: true });
                        const accountScopeKey = currentAccountScopeKey();
                        if (!accountScopeKey) {
                            dispose();
                            throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account Data is unavailable for the current Account');
                        }
                        const recordedQuery = latestQueryCursorByCollectionKey.get(
                            collectionQueryCursorKey(collection.contract),
                        );
                        const startingCursor = recordedQuery?.accountScopeKey === accountScopeKey
                            ? recordedQuery.changeCursor
                            : undefined;
                        const start = (): void => {
                            if (disposed) return;
                            upstreamDispose = subscribeChanges({
                                accountScopeKey,
                                pluginId: lifecycle.pluginId,
                                collectionId: collection.contract.collectionId,
                                contractDigest: collection.contract.contractDigest,
                                ...(startingCursor !== undefined ? { startingCursor } : {}),
                            }, (hint) => {
                                if (disposed) return;
                                const deliverHint = (): void => {
                                    if (disposed || currentAccountScopeKey() !== accountScopeKey) {
                                        dispose();
                                        return;
                                    }
                                    if (hint.kind === 'reset') {
                                        listener(Object.freeze({ kind: 'reset', changeCursor: hint.changeCursor }));
                                    } else if (
                                        hint.pluginId === lifecycle.pluginId
                                        && hint.collectionId === collection.contract.collectionId
                                        && hint.contractDigest === collection.contract.contractDigest
                                    ) {
                                        listener(Object.freeze({ kind: 'changed', changeCursor: hint.changeCursor }));
                                    }
                                };
                                let currentness: void | Promise<void>;
                                try {
                                    currentness = checkBoundCurrent(lifecycle);
                                } catch {
                                    dispose();
                                    return;
                                }
                                if (currentness === undefined) {
                                    deliverHint();
                                } else {
                                    void currentness.then(deliverHint, () => {
                                        dispose();
                                    });
                                }
                            });
                            if (disposed) upstreamDispose();
                            // A flip just after initial admission still closes
                            // the live observer, even when no change hint
                            // arrives to trigger the callback guard above.
                            try {
                                const currentness = checkBoundCurrent(lifecycle);
                                if (currentness !== undefined) {
                                    void currentness.catch(() => {
                                        dispose();
                                    });
                                }
                            } catch {
                                dispose();
                            }
                        };
                        if (initialCurrentness === undefined) {
                            start();
                        } else {
                            void initialCurrentness.then(start, () => {
                                dispose();
                            });
                        }
                        return Object.freeze({ dispose });
                    },
                });
                return bound;
            };

            return Object.freeze({
                kv: createAccountKvScope(),
                collection: bindDeclaredCollection,
            });
        },
    });
}
