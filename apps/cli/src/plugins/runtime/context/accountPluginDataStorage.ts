import axios from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes as nodeRandomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';

import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityCollectionWritersClaimActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { PluginAccountKvRowError, assertPluginAccountKvExpectedVersionV1, clonePluginAccountKvRowV1, commitPluginAccountKvMutationV1, createEmptyPluginAccountKvRowV1, deletePluginAccountKvEntryV1, listPluginAccountKvEntriesV1, normalizePluginAccountKvLogicalKeyV1, projectPluginAccountKvEntryV1, readPluginAccountKvEntryV1, setPluginAccountKvEntryV1, PluginAccountStorageMutationRequestV1Schema, PluginAccountStorageMutationResponseV1Schema, PluginAccountStorageReadResponseV1Schema, PluginAccountStorageRowV1Schema, PluginAccountStorageUnavailableV1Schema, assertPluginAccountStorageEnvelopeForModeV1, openPluginAccountStoragePrivatePayloadV1, sealPluginAccountStoragePrivatePayloadV1 } from '@happier-dev/protocol/plugins/data/accountKvV1';
import type { PluginAccountStorageEntryV1, AccountEncryptionCurrentnessResponse, AccountScopedCryptoMaterial, NormalizedPluginAccountCollectionContractV1, PluginCollectionLogicalDecodeFailureReasonV1, PluginAccountCollectionContributionV1, PluginCollectionCandidatePreparationBindingV1, PluginCollectionContractRefV1, PluginDataCollectionsCapabilities, PluginCollectionMutationOperationV1, PluginCollectionMutationRequestMeasurementV1, PluginCollectionMutationRequestV1, PluginCollectionMutationResultV1, PluginCollectionRowV1, PluginCollectionLogicalValueV1, PluginAccountStorageRowV1 } from '@happier-dev/protocol';
import { PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1, PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1, PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1, PLUGIN_COLLECTION_GET_HTTP_PATH_V1, PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1, PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1, PluginCollectionCandidatePreparationBindingV1Schema, PluginCollectionCandidatePreparationErrorV1Schema, PluginCollectionCandidatePreparationRetireRequestV1Schema, PluginCollectionCandidatePreparationRetireResultV1Schema, PluginCollectionCandidatePreparationSourcePageRequestV1Schema, PluginCollectionCandidatePreparationSourcePageResultV1Schema, PluginCollectionCandidatePreparationStageRequestV1Schema, PluginCollectionCandidatePreparationStageResultV1Schema, PluginCollectionGetRequestV1Schema, PluginCollectionGetResultV1Schema, PLUGIN_COLLECTION_FORGET_HTTP_PATH_V1, PluginCollectionForgetRequestV1Schema, PluginCollectionForgetResultV1Schema, PluginCollectionMutationErrorV1Schema, PluginCollectionMutationResultV1Schema, PluginCollectionQueryRequestV1Schema, PluginCollectionQueryResultV1Schema, PluginCollectionReadErrorV1Schema, normalizePluginAccountCollectionContractV1, resolveEffectivePluginCollectionLimitsV1, resolvePluginCollectionIdentityTagV1, splitPluginCollectionCandidatePreparationStageRequestsForKnownLimitsV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PLUGIN_COLLECTION_LIMITS_V1 } from '@happier-dev/protocol/plugins/data/collectionLimitsV1';
import { assertPluginCollectionContentEnvelopeForModeV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PluginAccountCollectionContributionV1Schema, resolvePluginCollectionMigrationChainV1 } from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import { PluginCollectionRowIdV1Schema } from '@happier-dev/protocol/plugins/data/collectionUiQueryWireV1';
import { compilePluginJsonSchema, createPluginJsonSchemaZodValueAdapter, preparePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { decodePluginCollectionLogicalRowV1, encodePluginCollectionLogicalValueV1, preparePluginCollectionLogicalMutationRequestV1, type PluginCollectionLogicalEncodeOutcomeV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
    isPluginError,
    PluginError,
    type JsonValue,
    type PluginAccountCollectionMigrationRuntimeProjection,
} from '@happier-dev/plugin-sdk';
import {
    normalizePluginAccountCollectionMigrationRuntimeProjection,
    projectPluginAccountCollectionDeclaration,
} from '@happier-dev/plugin-sdk/host/registration';
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
import { readObservedAccountEncryptionCurrentness, waitForObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readStoredCredentials, type Credentials, type StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import {
    getActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { requireAccountSettingsEncryptionCredentials } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { resolveAccountSettingsHttpBaseUrl } from '@/settings/accountSettings/resolveAccountSettingsHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { serializeCanonicalPluginManifest } from '@/plugins/manifest/serialize';
import type { AccountPluginWriterClaims } from './accountWriterClaims';
import { runTracedExternalActionInnerStage, traceExternalActionInnerStage, type ExternalActionInnerDiagnostic } from '@/daemon/externalActions/externalActionPhase';

import type { StablePluginAccountStorageHost } from './storage';
import {
    subscribePluginAccountCollectionWatchInvalidation,
    readPluginAccountAvailabilityChangeKey,
    type PluginAccountCollectionWatchInvalidation,
    type PluginAccountCollectionWatchSubscription,
} from './pluginAccountSettingsChangeBroker';

export type { PluginAccountCollectionWatchInvalidation } from './pluginAccountSettingsChangeBroker';

export type AccountPluginDataHttpClient = Readonly<{
    get(url: string, config: Readonly<Record<string, unknown>>): Promise<Readonly<{
        status: number;
        data: unknown;
    }>>;
    /** `body` is already-encoded JSON; see `serializeRequestBody`. */
    post(url: string, body: string, config: Readonly<Record<string, unknown>>): Promise<Readonly<{
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
    /** The daemon retains the existing claim results across registry/host replacement. */
    writerClaims?: AccountPluginWriterClaims;
    readCredentials?: () => Promise<StoredCredentials | null>;
    isCurrentAccount?: (credentials: StoredCredentials) => boolean | Promise<boolean>;
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
    /**
     * The admitted manifest of a plugin the daemon, not a portable Account
     * release, selects (bundled first-party, trusted development, drop-in)
     * and that declares Account-scoped contributions. Only such a plugin
     * claims a release-less Account intent with it; a managed portable
     * install is selected by the present user through its release.
     * Equal declarations rebuilt by reload keep their successful claim;
     * a changed declaration is admitted independently of code-byte identity.
     */
    resolveReleaseLessDeclaration?: (pluginId: string) => CanonicalPluginManifest | null;
    /** The exact declaring module, loaded by the existing activation/source owner. */
    resolveReleaseLessCollectionMigrations?: (pluginId: string) => Promise<PluginAccountCollectionMigrationRuntimeProjection | null>;
}>;

type BoundAccountDataLifecycle = Readonly<{
    pluginId: string;
    /** Present for plugin bindings; migration preparation has its own candidate authority. */
    occurrenceId?: string;
    signal: AbortSignal;
    isOccurrenceCurrent(): boolean | Promise<boolean>;
    /** Captured from the canonical active-Account publication owner at admission. */
    accountLifetimeToken: number;
}>;

type BoundCollection = Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    validate: ReturnType<typeof compilePluginJsonSchema>;
    storedValueSchema: ReturnType<typeof createPluginJsonSchemaZodValueAdapter>;
}>;

type AdmittedCollection = {
    contract: NormalizedPluginAccountCollectionContractV1;
    prepared?: BoundCollection;
    definitions: WeakMap<PluginAccountCollectionDefinition, BoundCollection>;
    reads?: Readonly<{
        scopeKey: string;
        accountLifetimeToken: number;
        mode: 'plain' | 'e2ee';
        material: AccountScopedCryptoMaterial | null;
        rows: Map<string, Readonly<{
            row: PluginCollectionRow<PluginAccountCollectionValue<PluginAccountCollectionDefinition>>;
            validatedWireRow: JsonValue;
        }>>;
    }>;
};

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
    /** Host declaration publication does not grant the plugin Account storage access. */
    claimReleaseLessDeclaration(binding: Parameters<StablePluginAccountStorageHost['bind']>[0]): Promise<void>;
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
        isOccurrenceCurrent(): boolean | Promise<boolean>;
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
const COLLECTION_WRITERS_CLAIM_HTTP_PATH = PluginAvailabilityActionHttpPathsV1[
    'account.plugins.availability.collectionWriters.claim'
];
/** A present-user release selection outranks the claim; that is a settled answer. */
const COLLECTION_WRITERS_CLAIM_SETTLED_REFUSAL = 'plugin_intent_release_selected';

type CandidatePreparationStageRequest = ReturnType<
    typeof PluginCollectionCandidatePreparationStageRequestV1Schema.parse
>;
type CandidatePreparationStageItem = CandidatePreparationStageRequest['items'][number];

const accountKvTransactionContext = new AsyncLocalStorage<ReadonlySet<object>>();

/**
 * Encodes one request body, or reports that this runtime's `JSON.stringify`
 * refused it.
 *
 * The host serializes here rather than letting the transport do it because only
 * the operation that runs the serializer can truthfully say a refusal came from
 * the serializer. Protocol's strict-JSON admission is iterative and carries no
 * depth quota, while the daemon runs on recursive `JSON.stringify` builds, so an
 * admitted value can still be one this runtime cannot encode; the measured
 * per-engine spread is recorded once with the Protocol strict-JSON owner
 * (`packages/protocol/src/plugins/contributions/strictJsonValue.ts`), which is
 * why no depth is pre-validated anywhere.
 *
 * The throwable is not a discriminator: the same `RangeError` class covers a
 * response longer than the engine's maximum string length, so classifying by it
 * across a whole request would report a recoverable outage as permanently
 * invalid caller data and take it off the retry path. A body this runtime cannot
 * encode, by contrast, can never be written, so its caller is told the value is
 * permanently invalid — the same outcome the direct Plugin UI client reports for
 * the same input, because the two realms must not disagree about one value.
 */
function serializeRequestBody(body: unknown): string | null {
    try {
        return JSON.stringify(body);
    } catch {
        return null;
    }
}

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
        forget: unavailableAsync,
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
        // POST bodies have already passed the owning serializer. Axios's
        // default string transform would parse the same bytes again.
        transformRequest: [],
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
    const current = lifecycle.isOccurrenceCurrent();
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

async function inAccountKvRowAlgebraAsync<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
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

/**
 * The daemon's translation of the shared Protocol codec's encode failures into
 * this realm's `PluginError` vocabulary. Missing Account crypto material is an
 * Account-availability fact; the envelope ceiling is a known-no-effect quota
 * refusal. Malformed values and crypto failures remain invalid authored values.
 */
function collectionEncodeFailureError(
    failure: Extract<PluginCollectionLogicalEncodeOutcomeV1, { status: 'failed' }>,
): PluginError {
    switch (failure.reason) {
        case 'value-schema-invalid':
            return dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection value does not satisfy its admitted schema');
        case 'row-identity-invalid':
            return dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection row identity is invalid');
        case 'projection-invalid':
            return dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection server-readable projection is invalid');
        case 'private-payload-invalid':
            return dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection private payload is invalid');
        case 'private-payload-too-large':
            return dataError('collection_quota_incompatible', 'Collection private envelope exceeds its encoded limit', false, {
                dimension: failure.dimension,
                effectiveMaximum: failure.effectiveMaximum,
            });
        case 'encryption-material-unavailable':
            return dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account encryption material is unavailable');
    }
}

/** Every decode failure is a stored-row/protocol fact, never an author mistake. */
function collectionDecodeFailureError(
    reason: PluginCollectionLogicalDecodeFailureReasonV1,
): PluginError {
    switch (reason) {
        case 'content-mode-mismatch':
            return dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection content does not match the current Account encryption mode');
        case 'projection-mismatch':
            return dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection projection does not match its admitted server-readable fields');
        case 'private-payload-overlaps-projection':
            return dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection private payload overlaps an admitted projection field');
        case 'row-schema-invalid':
            return dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection row does not satisfy its admitted schema');
    }
}

function splitLogicalPut(input: Readonly<{
    collection: BoundCollection;
    value: PluginAccountCollectionValue<PluginAccountCollectionDefinition>;
    encryptionMode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
    randomBytes: (length: number) => Uint8Array;
}>): Pick<Extract<PluginCollectionMutationOperationV1, { kind: 'put' }>, 'kind' | 'rowId' | 'content' | 'projection'> {
    const value = asJsonObject(input.value);
    if (!value) {
        throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection value does not satisfy its admitted schema');
    }
    const encoded = encodePluginCollectionLogicalValueV1({
        contract: input.collection.contract,
        isValidLogicalValue: (candidate) => isValidPluginJsonSchemaValue(
            input.collection.validate,
            candidate,
        ),
        value,
        encryptionMode: input.encryptionMode,
        material: input.material,
        randomBytes: input.randomBytes,
    });
    if (encoded.status === 'failed') throw collectionEncodeFailureError(encoded);
    return {
        kind: 'put',
        rowId: encoded.rowId,
        content: encoded.content,
        projection: encoded.projection,
    };
}

function mergeLogicalRow<TValue extends PluginAccountCollectionValue<PluginAccountCollectionDefinition>>(input: Readonly<{
    collection: BoundCollection;
    row: PluginCollectionRowV1;
    encryptionMode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
}>): PluginCollectionRow<TValue> {
    const decoded = decodePluginCollectionLogicalRowV1<TValue>({
        contract: input.collection.contract,
        parseStoredLogicalValue: value => {
            const parsed = input.collection.storedValueSchema.safeParse(value);
            if (!parsed.success || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) return null;
            // The canonical stored-read parser already validates the projected
            // value against this Collection's admitted logical schema.
            return parsed.data as TValue;
        },
        row: input.row,
        encryptionMode: input.encryptionMode,
        material: input.material,
    });
    if (decoded.status === 'failed') throw collectionDecodeFailureError(decoded.reason);
    return Object.freeze({
        rowId: decoded.rowId,
        revision: decoded.revision,
        value: decoded.value,
    });
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
    const contractsByPluginAndCollection = new Map<string, AdmittedCollection>();
    for (const contract of params.contracts) {
        contractsByPluginAndCollection.set(`${contract.pluginId}\u0000${contract.collectionId}`, {
            contract,
            definitions: new WeakMap(),
        });
    }
    const readCredentials = params.readCredentials ?? readStoredCredentials;
    const http: AccountPluginDataHttpClient = params.http ?? axios;
    const resolveBaseUrl = params.resolveBaseUrl ?? resolveAccountSettingsHttpBaseUrl;
    const resolveAccountEncryptionCurrentness = params.resolveAccountEncryptionCurrentness
        ?? (async (credentials: StoredCredentials, signal?: AbortSignal) => (
            await fetchAccountEncryptionCurrentness({
                token: credentials.token,
                serverBaseUrl: resolveBaseUrl(),
                timeoutMs: 0,
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
    const resolveReleaseLessDeclaration = params.resolveReleaseLessDeclaration ?? (() => null);
    const writerClaimsByScope: AccountPluginWriterClaims = params.writerClaims ?? new Map();

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
                current = await isCurrentAccount(credentials);
            } catch {
                current = false;
            }
            await assertBoundCurrent(lifecycle, operationSignal);
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
            freshness: 'observed' | 'fresh' = 'fresh',
        ): Promise<Readonly<{
            mode: 'plain' | 'e2ee';
            material: AccountScopedCryptoMaterial | null;
        }>> => {
            const signal = signalFor(operationSignal);
            try {
                const currentness = await runTracedExternalActionInnerStage('collection.encryption.currentness', async () => {
                    // ApiMachine's authenticated holder owns the subscription.
                    // Borrow only its exact credential/Home identity; absent
                    // holders retain this operation's fresh transport and signal.
                    const observed = freshness === 'observed' && !params.resolveAccountEncryptionCurrentness
                        ? readObservedAccountEncryptionCurrentness({
                            token: current.token, serverBaseUrl: resolveBaseUrl(), signal,
                        })
                        : null;
                    return await (observed ?? waitForObservation(
                        resolveAccountEncryptionCurrentness(current, signal), signal,
                    ));
                });
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
            /** Canonical-row mutations settle independently of later currentness. */
            kind?: 'read' | 'mutation';
            credentials: StoredCredentials;
            operationSignal?: AbortSignal;
            parseError: (value: unknown, status: number) => PluginError | null;
            unavailableMessage: string;
            diagnosticClaimAttemptId?: string;
            encodedBody?: string | null;
        }>): Promise<unknown> => {
            const signal = signalFor(input.operationSignal);
            const encodedBody = input.encodedBody === undefined
                ? serializeRequestBody(input.body)
                : input.encodedBody;
            if (encodedBody === null) {
                throw dataError(
                    COLLECTION_INVALID_VALUE_CODE,
                    'Collection request cannot be serialized by this runtime',
                );
            }
            await assertCurrentAccount(input.credentials, input.operationSignal);
            try {
                const operation = input.path === COLLECTION_WRITERS_CLAIM_HTTP_PATH ? 'claim'
                    : input.path === PLUGIN_COLLECTION_GET_HTTP_PATH_V1 ? 'get'
                    : input.path === PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1 ? 'query'
                    : input.path === PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1 ? 'mutation'
                    : input.path === PLUGIN_COLLECTION_FORGET_HTTP_PATH_V1 ? 'forget'
                    : 'candidate';
                const diagnostic: { httpStatus?: number; claimAttemptId?: string } = {
                    ...(input.diagnosticClaimAttemptId ? { claimAttemptId: input.diagnosticClaimAttemptId } : {}),
                };
                const response = await runTracedExternalActionInnerStage(`collection.http.${operation}`, async () => {
                    const result = await http.post(
                        `${resolveBaseUrl()}${input.path}`,
                        encodedBody,
                        requestConfig(input.credentials, signal),
                    );
                    diagnostic.httpStatus = result.status;
                    return result;
                }, diagnostic);
                if (input.kind !== 'mutation') {
                    await assertCurrentAccount(input.credentials, input.operationSignal);
                }
                if (response.status >= 200 && response.status < 300) return response.data;
                const rollback = readHomeDomainConfirmedRollbackV1(response.status, response.data);
                if (rollback) {
                    throw dataError(rollback.code, 'Account Collection transaction rolled back', true, rollback.details);
                }
                throw input.parseError(response.data, response.status)
                    ?? (input.kind === 'mutation' ? dataError(
                        'plugin_collection_outcome_unknown',
                        'Account Collection mutation may have committed without a valid acknowledgement',
                    ) : dataError(
                        ACCOUNT_DATA_UNAVAILABLE_CODE,
                        input.unavailableMessage,
                        response.status >= 500,
                    ));
            } catch (error) {
                if (input.kind !== 'mutation') await assertBoundCurrent(lifecycle, input.operationSignal);
                if (isPluginError(error)) throw error;
                if (input.kind === 'mutation') {
                    throw dataError('plugin_collection_outcome_unknown', 'Account Collection mutation outcome is unknown');
                }
                throw dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, `${input.unavailableMessage} failed`, true);
            }
        };
        /**
         * The release-less Availability claim for a daemon-selected plugin,
         * carrying its admitted manifest. It is best effort: the server's
         * Collection, webhook, and Event admission stay the only authorities,
         * so transient failures remain retryable by the next operation. A
         * contract conflict is retained for the exact declaration and live
         * Account/occurrence inputs, and stays visibly unavailable.
         */
        const ensureWriterClaim = async (
            credentials: StoredCredentials,
            operationSignal?: AbortSignal,
            prepareCollections = true,
            triggerKind: NonNullable<ExternalActionInnerDiagnostic['collectionPreparationTriggerKind']> = 'collection-operation',
        ): Promise<void> => {
            const manifest = resolveReleaseLessDeclaration(lifecycle.pluginId);
            const scopeKey = currentAccountScopeKey();
            if (!manifest || scopeKey === null) return;
            const key = `${scopeKey}\u0000${lifecycle.pluginId}`;
            const availabilityChangeKey = readPluginAccountAvailabilityChangeKey(scopeKey, lifecycle.pluginId);
            let claim = writerClaimsByScope.get(key);
            // Reload replaces storage hosts and may reparse an unchanged manifest.
            // Successful admission belongs to the declaration and live Account,
            // not the executable occurrence. Refusals keep their recovery inputs.
            while (claim && claim.accountLifetimeToken === lifecycle.accountLifetimeToken
                && (claim.manifest !== manifest || claim.occurrenceId !== lifecycle.occurrenceId)
                && (claim.manifest === manifest
                    || serializeCanonicalPluginManifest(claim.manifest) === serializeCanonicalPluginManifest(manifest))) {
                const retained = claim;
                const refusal = await retained.result;
                await assertBoundCurrent(lifecycle, operationSignal);
                claim = writerClaimsByScope.get(key);
                if (claim !== retained) continue;
                if (refusal === null) {
                    claim = { ...retained, manifest, occurrenceId: lifecycle.occurrenceId };
                    writerClaimsByScope.set(key, claim);
                }
                break;
            }
            let availabilityRefused = false;
            while (claim && claim.manifest === manifest
                && claim.occurrenceId === lifecycle.occurrenceId
                && claim.accountLifetimeToken === lifecycle.accountLifetimeToken
                && claim.availabilityChangeKey !== availabilityChangeKey) {
                const refusal = await claim.result;
                // A peer may already have published the retry while this caller waited.
                const currentClaim = writerClaimsByScope.get(key);
                if (currentClaim !== claim) {
                    claim = currentClaim;
                    continue;
                }
                availabilityRefused = refusal !== null;
                break;
            }
            if (!claim || claim.manifest !== manifest
                || claim.occurrenceId !== lifecycle.occurrenceId
                || claim.accountLifetimeToken !== lifecycle.accountLifetimeToken
                || availabilityRefused) {
                const encodedClaim = serializeRequestBody({ manifest });
                // A background publication can start the promise another Action later awaits.
                // This diagnostic-only id joins those records without exposing claim inputs.
                const diagnosticClaimAttemptId = process.env.HAPPIER_WEB_LATENCY_TRACE === '1' ? randomUUID() : undefined;
                traceExternalActionInnerStage('collection.writer_claim.start', {
                    ...(diagnosticClaimAttemptId ? { claimAttemptId: diagnosticClaimAttemptId } : {}),
                    pluginId: lifecycle.pluginId,
                    claimOccurrenceId: lifecycle.occurrenceId,
                    claimProducerPid: process.pid,
                    claimProducerKind: configuration.isDaemonProcess ? 'daemon' : 'cli',
                    collectionPreparationTriggerKind: triggerKind,
                    claimAbsent: claim === undefined,
                    declarationChanged: claim !== undefined && claim.manifest !== manifest,
                    occurrenceChanged: claim !== undefined && claim.occurrenceId !== lifecycle.occurrenceId,
                    accountChanged: claim !== undefined && claim.accountLifetimeToken !== lifecycle.accountLifetimeToken,
                    availabilityChanged: claim !== undefined && claim.availabilityChangeKey !== availabilityChangeKey,
                });
                const claimOnce = (prepare?: true) => post({
                    path: COLLECTION_WRITERS_CLAIM_HTTP_PATH,
                    body: { manifest, ...(prepare ? { prepare } : {}) },
                    ...(prepare ? {} : { encodedBody: encodedClaim }),
                    credentials,
                    ...(operationSignal ? { operationSignal } : {}),
                    parseError: (value, status) => {
                        const code = asJsonObject(value as JsonValue)?.error;
                        if (code === 'plugin_collection_contract_conflict' && status !== 409) return null;
                        return typeof code === 'string'
                            ? dataError(code, code === 'plugin_collection_contract_conflict'
                                ? 'Account Collection contract changed without a schemaVersion bump. Update the plugin schemaVersion and migration, then reload the corrected plugin.'
                                : 'Account Collection writer claim was refused')
                            : null;
                    },
                    unavailableMessage: 'Account Collection writer claim',
                    ...(diagnosticClaimAttemptId ? { diagnosticClaimAttemptId } : {}),
                });
                const result: Promise<PluginError | null> = (async () => {
                    try {
                        await claimOnce();
                        return;
                    } catch (error) {
                        if (!isPluginError(error) || error.code !== 'plugin_intent_writable_collections_not_ready') throw error;
                    }
                    const preparation = PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(await claimOnce(true));
                    if (!preparation.preparation?.length) throw dataError('plugin_intent_writable_collections_not_ready', 'Collection writer preparation is unavailable');
                    const runtime = await params.resolveReleaseLessCollectionMigrations?.(lifecycle.pluginId);
                    await assertBoundCurrent(lifecycle, operationSignal);
                    if (!runtime) throw dataError('collection_candidate_preparation_invalid', 'Declaring module migration callbacks are unavailable');
                    const stages: CollectionMigrationCandidateHandle[] = [];
                    try {
                        for (const item of preparation.preparation) {
                            const targetContract = contractsByPluginAndCollection.get(`${lifecycle.pluginId}\u0000${item.binding.target.collectionId}`)?.contract;
                            if (!targetContract) throw dataError('collection_candidate_preparation_contract_mismatch', 'Target Collection is not admitted');
                            const stage = host.createCollectionMigrationCandidate({
                                binding: item.binding,
                                sourceContract: normalizePluginAccountCollectionContractV1({ pluginId: lifecycle.pluginId, contribution: item.source }),
                                targetContract,
                                declarations: manifest.contributes.accountCollections ?? [],
                                runtime,
                                signal: signalFor(operationSignal),
                                isOccurrenceCurrent: lifecycle.isOccurrenceCurrent,
                            });
                            stages.push(stage);
                            await stage.prepare();
                        }
                        await claimOnce();
                    } catch (error) {
                        await Promise.all(stages.map(async (stage) => {
                            try { await stage.retire(); } catch { /* Exact-stage cleanup remains retryable by Data lifecycle retirement. */ }
                        }));
                        throw error;
                    }
                })().then(() => null, (error: unknown) => {
                    if (isPluginError(error) && error.code === 'plugin_collection_contract_conflict') return error;
                    if (isPluginError(error) && error.code === COLLECTION_WRITERS_CLAIM_SETTLED_REFUSAL) return error;
                    // An obsolete request must not evict a newer input's claim.
                    if (writerClaimsByScope.get(key)?.result === result) writerClaimsByScope.delete(key);
                    return null;
                });
                claim = { manifest, occurrenceId: lifecycle.occurrenceId, preparesCollections: prepareCollections,
                    accountLifetimeToken: lifecycle.accountLifetimeToken, availabilityChangeKey, result,
                    ...(diagnosticClaimAttemptId ? { diagnosticClaimAttemptId } : {}) };
                writerClaimsByScope.set(key, claim);
            }
            const retainedClaim = claim;
            const refusal = await runTracedExternalActionInnerStage('collection.writer_claim.wait', () => retainedClaim.result,
                retainedClaim.diagnosticClaimAttemptId ? { claimAttemptId: retainedClaim.diagnosticClaimAttemptId } : {});
            await assertBoundCurrent(lifecycle, operationSignal);
            if (refusal && refusal.code !== COLLECTION_WRITERS_CLAIM_SETTLED_REFUSAL) throw refusal;
        };
        const request = async (input: Readonly<{
            path: string;
            body: unknown;
            kind: 'read' | 'mutation';
            credentials: StoredCredentials;
            operationSignal?: AbortSignal;
        }>): Promise<unknown> => {
            let writerRefusal: PluginError | null = null;
            try {
                await ensureWriterClaim(input.credentials, input.operationSignal);
            } catch (error) {
                if (input.kind !== 'read' || !isPluginError(error) || error.code !== 'plugin_collection_contract_conflict') throw error;
                // A retained exact ref may still be readable. Data's server
                // resolver, not the writer claim or this adapter, admits it.
                writerRefusal = error;
            }
            return await post({
            path: input.path,
            body: input.body,
            kind: input.kind,
            credentials: input.credentials,
            ...(input.operationSignal ? { operationSignal: input.operationSignal } : {}),
                parseError: (value, status) => {
                    const error = parseCollectionError(value, input.kind);
                    return writerRefusal && status === 404 && error?.code === 'collection_unavailable'
                        ? writerRefusal : error;
                },
                unavailableMessage: 'Account Collection transport is unavailable',
            });
        };
        return Object.freeze({
            assertCurrentAccount,
            signalFor,
            currentCredentials,
            currentEncryption,
            ensureWriterClaim,
            post,
            request,
        });
    };

    const host: AccountPluginDataStorageHost = Object.freeze({
        async claimReleaseLessDeclaration(binding): Promise<void> {
            if (binding.signal.aborted || currentAccountScopeKey() === null
                || resolveReleaseLessDeclaration(binding.pluginId) === null) return;
            const lifecycle: BoundAccountDataLifecycle = {
                pluginId: binding.pluginId,
                occurrenceId: binding.occurrenceId,
                signal: binding.signal,
                isOccurrenceCurrent: binding.isOccurrenceCurrent,
                accountLifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
            };
            const context = createBoundRequestContext(lifecycle);
            await context.ensureWriterClaim(await context.currentCredentials(), undefined, true, 'declaration-publication');
        },
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
                isOccurrenceCurrent: input.isCurrent,
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
            )?.contract;
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
            const source: BoundCollection = Object.freeze({ contract: sourceContract, validate: sourceValidate,
                storedValueSchema: createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(sourceContract.schema)) });
            const target: BoundCollection = Object.freeze({ contract: targetContract, validate: targetValidate,
                storedValueSchema: createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(targetContract.schema)) });
            const abort = new AbortController();
            const lifecycle: BoundAccountDataLifecycle = {
                pluginId: binding.target.pluginId,
                signal: composeOperationSignal(input.signal, abort.signal),
                isOccurrenceCurrent: input.isOccurrenceCurrent,
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
                let encodedBody: string | null;
                let baseUrl: string;
                try {
                    encodedBody = serializeRequestBody(
                        PluginCollectionCandidatePreparationRetireRequestV1Schema.parse({ binding }),
                    );
                    baseUrl = resolveBaseUrl();
                } catch {
                    throw dataError(
                        'collection_candidate_preparation_invalid',
                        'Collection candidate retirement authority could not be captured',
                    );
                }
                if (encodedBody === null) {
                    throw dataError(
                        'collection_candidate_preparation_invalid',
                        'Collection candidate retirement request cannot be serialized by this runtime',
                    );
                }
                const retireBody = encodedBody;
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
                            retireBody,
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
                const declarations = resolvePluginCollectionMigrationChainV1({
                    sourceSchemaVersion: source.contract.schemaVersion,
                    targetSchemaVersion: target.contract.schemaVersion,
                    readableSchemaVersions: target.contract.readableSchemaVersions,
                    migrations: target.contract.migrations,
                });
                if (declarations === null || targetMigrations.length !== target.contract.migrations.length) {
                    throw dataError(
                        COLLECTION_INVALID_VALUE_CODE,
                        'Collection candidate migration callbacks do not match the exact source-to-target chain',
                    );
                }
                const chain = targetMigrations.slice(targetMigrations.length - declarations.length);
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
                        const sourceEncryption = await requestContext.currentEncryption(sourceCredentials, undefined, 'observed');
                        const logical = mergeLogicalRow<PluginAccountCollectionValue<PluginAccountCollectionDefinition>>({
                            collection: source,
                            row: sourceRow,
                            encryptionMode: sourceEncryption.mode,
                            material: sourceEncryption.material,
                        });
                        let targetValue = logical.value;
                        for (const migration of chain) {
                            await assertBoundCurrent(lifecycle);
                            try {
                                targetValue = await migration.migrate(targetValue, Object.freeze({ currentRevision: sourceRow.revision }));
                            } catch (error) {
                                await assertBoundCurrent(lifecycle);
                                if (isPluginError(error)) throw error;
                                throw dataError(
                                    COLLECTION_INVALID_VALUE_CODE,
                                    'Collection candidate migration rejected the retained row',
                                );
                            }
                            await assertBoundCurrent(lifecycle);
                        }

                        const targetCredentials = await requestContext.currentCredentials();
                        // A mode/key commit can precede its socket publication.
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
                occurrenceId: binding.occurrenceId,
                signal: binding.signal,
                isOccurrenceCurrent: binding.isOccurrenceCurrent,
                accountLifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
            };
            const kvScopeIdentity = Object.freeze({});
            // Handles retain this invocation's cancellation and authority. Only
            // readonly declaration admission and schema preparation belong to
            // the registry-owned contract lifetime shared by fresh invocations.
            const boundCollections = new WeakMap<PluginAccountCollectionDefinition,
                PluginAccountCollectionForDefinition<PluginAccountCollectionDefinition>>();
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
                ensureWriterClaim,
                request,
            } = createBoundRequestContext(lifecycle);
            // Activation claims too, so Plugin UI reads that reach Data directly
            // and server-side webhook/Event admission do not wait for this
            // plugin's first daemon Collection operation.
            if (resolveReleaseLessDeclaration(binding.pluginId) !== null) {
                void currentCredentials()
                    .then((credentials) => ensureWriterClaim(credentials))
                    .catch(() => undefined);
            }

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
                const encryption = await currentEncryption(credentials, operationSignal, 'observed');
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
            }>): Promise<'updated' | 'conflict'> => {
                // Final sealing keeps a fresh Home witness even when opening
                // the row borrowed the incumbent subscription's identity.
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
                const encodedBody = serializeRequestBody(body);
                if (encodedBody === null) {
                    throw dataError(
                        ACCOUNT_KV_INVALID_CODE,
                        'Account KV row cannot be serialized by this runtime',
                    );
                }
                const signal = signalFor(input.operationSignal);
                await assertCurrentAccount(input.snapshot.credentials, input.operationSignal);
                let response: Readonly<{ status: number; data: unknown }>;
                try {
                    response = await http.post(
                        accountKvUrl(),
                        encodedBody,
                        requestConfig(input.snapshot.credentials, signal),
                    );
                } catch (error) {
                    throw dataError('plugin_account_storage_outcome_unknown', 'Account KV write outcome is unknown');
                }
                if (response.status < 200 || response.status >= 300) {
                    const unavailable = PluginAccountStorageUnavailableV1Schema.safeParse(response.data);
                    throw unavailable.success
                        ? dataError(ACCOUNT_DATA_UNAVAILABLE_CODE, 'Account KV is unavailable on this server')
                        : dataError('plugin_account_storage_outcome_unknown', 'Account KV write outcome is unknown');
                }
                const parsed = PluginAccountStorageMutationResponseV1Schema.safeParse(response.data);
                if (!parsed.success) {
                    throw dataError('plugin_account_storage_outcome_unknown', 'Account KV mutation acknowledgement is invalid');
                }
                if (parsed.data.status === 'conflict') {
                    return 'conflict';
                }
                return 'updated';
            };

            const createAccountKvScope = (): AccountKvService => {
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
                    const transactionSignals = new Set<AbortSignal>();
                    let active = true;
                    let mutated = false;
                    const assertTransactionActive = async (signal?: AbortSignal): Promise<void> => {
                        if (!active) {
                            throw dataError(ACCOUNT_KV_INVALID_CODE, 'Account KV transaction handle is no longer active');
                        }
                        await assertBoundCurrent(lifecycle, operationSignal);
                        if (signal) {
                            transactionSignals.add(signal);
                            await assertBoundCurrent(lifecycle, signal);
                        }
                    };
                    const transaction: AccountKvTransaction = Object.freeze({
                        async get<TValue extends JsonValue = JsonValue>(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                            await assertTransactionActive(options?.signal);
                            const normalizedKey = normalizeAccountKvKey(key);
                            const entry = accountKvEntryAt(row, normalizedKey);
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
                        const commitSignal = transactionSignals.size === 0
                            ? operationSignal
                            : AbortSignal.any([
                                ...(operationSignal ? [operationSignal] : []),
                                ...transactionSignals,
                            ]);
                        await assertBoundCurrent(lifecycle, commitSignal);
                        if (mutated) {
                            await inAccountKvRowAlgebraAsync(async () => await commitPluginAccountKvMutationV1({
                                snapshot,
                                pendingRow: row,
                                assertCurrent: async () => await assertBoundCurrent(lifecycle, commitSignal),
                                write: async (currentSnapshot, currentRow) => await writeAccountKvSnapshot({
                                    snapshot: currentSnapshot,
                                    row: currentRow,
                                    operationSignal: commitSignal,
                                }),
                            }));
                        }
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
                        return await mutate(
                            async (transaction) => await transaction.set(key, value, options),
                            options.signal,
                        );
                    },
                    async delete(key: string, options: Readonly<{
                        expectedVersion: number;
                        signal?: AbortSignal;
                    }>) {
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
                const existing = boundCollections.get(definition);
                if (existing) return existing as PluginAccountCollectionForDefinition<TDefinition>;
                let collection: BoundCollection;
                let admitted: AdmittedCollection | undefined;
                try {
                    admitted = contractsByPluginAndCollection.get(
                        `${lifecycle.pluginId}\u0000${definition.id}`,
                    );
                    if (!admitted) return createUnavailableAccountCollection<TDefinition>(COLLECTION_UNDECLARED_CODE);
                    const prepared = admitted.definitions.get(definition);
                    if (prepared) {
                        collection = prepared;
                    } else {
                        const parsed = PluginAccountCollectionContributionV1Schema.safeParse(
                            projectPluginAccountCollectionDeclaration(definition.id, definition),
                        );
                        if (!parsed.success) return createUnavailableAccountCollection<TDefinition>(COLLECTION_UNDECLARED_CODE);
                        const requested = normalizePluginAccountCollectionContractV1({
                            pluginId: lifecycle.pluginId,
                            contribution: parsed.data,
                        });
                        if (admitted.contract.contractDigest !== requested.contractDigest) {
                            return createUnavailableAccountCollection<TDefinition>(COLLECTION_UNDECLARED_CODE);
                        }
                        // Channels reconciliation enters with a fresh Action
                        // binding on each pass. Preparing at the binding lifetime
                        // recompiles its large static schema on the event loop.
                        if (!admitted.prepared) {
                            const schema = preparePluginJsonSchema(admitted.contract.schema);
                            admitted.prepared = Object.freeze({
                                contract: admitted.contract,
                                validate: schema.validate,
                                storedValueSchema: createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(schema.jsonSchema)),
                            });
                        }
                        collection = admitted.prepared;
                        admitted.definitions.set(definition, collection);
                    }
                } catch {
                    return createUnavailableAccountCollection<TDefinition>(COLLECTION_UNDECLARED_CODE);
                }

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
                    encodedBytes: number;
                    measurement: PluginCollectionMutationRequestMeasurementV1;
                }>> => {
                    const credentials = await currentCredentials(operationSignal);
                    // Measurement and mutation share this fresh pre-sealing boundary.
                    const encryption = await currentEncryption(credentials, operationSignal);
                    let absenceEpoch: number | undefined;
                    for (const operation of operations) {
                        if (operation.kind !== 'put' || operation.expectedRevision !== 'absent') continue;
                        const snapshot = await request({
                            path: PLUGIN_COLLECTION_GET_HTTP_PATH_V1,
                            body: PluginCollectionGetRequestV1Schema.parse({
                                pluginId: lifecycle.pluginId,
                                collectionId: collection.contract.collectionId,
                                readerContext: {
                                    pluginId: collection.contract.pluginId,
                                    collectionId: collection.contract.collectionId,
                                    schemaVersion: collection.contract.schemaVersion,
                                    contractDigest: collection.contract.contractDigest,
                                },
                                rowId: splitLogicalPut({
                                    collection,
                                    value: operation.value,
                                    encryptionMode: encryption.mode,
                                    material: encryption.material,
                                    randomBytes,
                                }).rowId,
                            }),
                            kind: 'read',
                            credentials,
                            operationSignal,
                        });
                        const parsedSnapshot = PluginCollectionGetResultV1Schema.safeParse(snapshot);
                        if (!parsedSnapshot.success) {
                            throw dataError(COLLECTION_PROTOCOL_INVALID_CODE, 'Collection currentness response is invalid');
                        }
                        absenceEpoch = parsedSnapshot.data.absenceEpoch;
                        break;
                    }
                    const prepared = preparePluginCollectionLogicalMutationRequestV1({
                        contract: collection.contract,
                        isValidLogicalValue: (value): value is PluginCollectionLogicalValueV1 => isValidPluginJsonSchemaValue(
                            collection.validate,
                            value,
                        ),
                        operations,
                        encryptionMode: encryption.mode,
                        material: encryption.material,
                        randomBytes,
                        absenceEpoch,
                    });
                    if (prepared.status === 'failed') {
                        if (prepared.reason !== 'mutation-request-invalid') {
                            throw collectionEncodeFailureError(prepared);
                        }
                        throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection mutation does not satisfy the wire contract');
                    }
                    return Object.freeze({
                        credentials,
                        request: prepared.request,
                        encodedBytes: prepared.encodedBytes,
                        measurement: prepared.measurement,
                    });
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
                        const incompatibility = requestBody.operations.length > collectionLimits.maxBatchRows
                            ? {
                                dimension: 'maxBatchRows' as const,
                                effectiveMaximum: collectionLimits.maxBatchRows,
                            }
                            : sealed.encodedBytes > collectionLimits.maxBatchBytes
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
                        throw dataError('plugin_collection_outcome_unknown', 'Collection mutation acknowledgement is invalid');
                    }
                    return parsed.data;
                };

                /**
                 * The exact revision a retention owner already proved
                 * unreachable is the whole currentness witness, so this is one
                 * request. The server advances Collection absence currentness
                 * inside the same transaction, and a direct read cannot see a
                 * tombstone anyway — re-reading before retrying could never
                 * resolve a revision conflict, only spin on it.
                 */
                const forgetRowForRetention = async (
                    rowId: string,
                    expectedRevision: number,
                    operationSignal?: AbortSignal,
                ): Promise<boolean> => {
                    const credentials = await currentCredentials(operationSignal);
                    const response = await request({
                        path: PLUGIN_COLLECTION_FORGET_HTTP_PATH_V1,
                        body: PluginCollectionForgetRequestV1Schema.parse({
                            pluginId: lifecycle.pluginId,
                            collectionId: collection.contract.collectionId,
                            writerContext: {
                                schemaVersion: collection.contract.schemaVersion,
                                contractDigest: collection.contract.contractDigest,
                            },
                            rowId,
                            expectedRevision,
                        }),
                        kind: 'mutation',
                        credentials,
                        operationSignal,
                    });
                    const parsed = PluginCollectionForgetResultV1Schema.safeParse(response);
                    if (!parsed.success) {
                        throw dataError('plugin_collection_outcome_unknown', 'Collection forget acknowledgement is invalid');
                    }
                    return parsed.data.status === 'forgotten';
                };

                const materialize = (
                    row: PluginCollectionRowV1,
                    mode: 'plain' | 'e2ee',
                    material: AccountScopedCryptoMaterial | null,
                ): PluginCollectionRow<PluginAccountCollectionValue<TDefinition>> => {
                    // Transport and current Account admission still run for every
                    // read. Only the stored logical value is retained by this
                    // admitted contract, at its latest server-issued row revision.
                    const scopeKey = currentAccountScopeKey();
                    const prior = admitted?.reads;
                    const sameMaterial = prior?.material === null ? material === null
                        : prior?.material !== undefined && material !== null
                            && prior.material.type === material.type
                            && timingSafeEqual(
                                prior.material.type === 'legacy' ? prior.material.secret : prior.material.machineKey,
                                material.type === 'legacy' ? material.secret : material.machineKey,
                            );
                    if (admitted && (!prior || prior.scopeKey !== scopeKey
                        || prior.accountLifetimeToken !== lifecycle.accountLifetimeToken
                        || prior.mode !== mode || !sameMaterial)) {
                        admitted.reads = scopeKey ? {
                            scopeKey, accountLifetimeToken: lifecycle.accountLifetimeToken,
                            mode, material, rows: new Map(),
                        } : undefined;
                    }
                    const rows = admitted?.reads?.rows;
                    const retained = rows?.get(row.rowId);
                    // The wire schema already admits the envelope. Its mode is
                    // not implied by revision equality, including on a warm hit.
                    if ((mode === 'plain') !== (row.content.t === 'plain')) {
                        throw collectionDecodeFailureError('content-mode-mismatch');
                    }
                    if (mode === 'e2ee') {
                        try { assertPluginCollectionContentEnvelopeForModeV1(row.content, mode); }
                        catch { throw collectionDecodeFailureError('content-mode-mismatch'); }
                    }
                    if (retained?.row.revision === row.revision && sameStrictJsonValue(retained.validatedWireRow, row)) {
                        return Object.freeze({ ...retained.row, value: structuredClone(retained.row.value) }) as PluginCollectionRow<PluginAccountCollectionValue<TDefinition>>;
                    }
                    const decoded = mergeLogicalRow<PluginAccountCollectionValue<TDefinition>>({
                        collection, row, encryptionMode: mode, material,
                    });
                    // Private immutable wire witness covers both the exact content
                    // envelope and its projection. Equal revisions alone do not
                    // prove that the retained logical row still corresponds.
                    // Returned values cannot mutate either retained snapshot.
                    rows?.set(row.rowId, {
                        row: { ...decoded, value: structuredClone(decoded.value) },
                        validatedWireRow: normalizeStrictJsonValue(row),
                    });
                    return decoded;
                };

                const bound: PluginAccountCollectionForDefinition<TDefinition> = Object.freeze({
                    async forget(
                        rowId: string,
                        options: Readonly<{ expectedRevision: number; signal?: AbortSignal }>,
                    ) {
                        if (!await forgetRowForRetention(rowId, options.expectedRevision, options.signal)) {
                            throw dataError(COLLECTION_CONFLICT_CODE, 'Collection forget conflicted with a newer row revision');
                        }
                        admitted?.reads?.rows.delete(rowId);
                        return Object.freeze({ rowId, forgotten: true as const });
                    },
                    async identityTag(
                        request: Readonly<{ field: string; components: readonly string[] }>,
                        options?: Readonly<{ signal?: AbortSignal }>,
                    ) {
                        // The admitted contract, not the caller, decides which
                        // purposes exist, and that admit/refuse decision lives
                        // with the contract in Protocol so the daemon and the
                        // direct Plugin UI client cannot drift.
                        const credentials = await currentCredentials(options?.signal);
                        // This local tag has no later server admission point.
                        const encryption = await currentEncryption(credentials, options?.signal);
                        await assertCurrentAccount(credentials, options?.signal);
                        const resolved = resolvePluginCollectionIdentityTagV1({
                            contract: collection.contract,
                            accountEncryptionMode: encryption.mode,
                            material: encryption.material,
                            field: request.field,
                            components: request.components,
                        });
                        if (resolved.status === 'failed') {
                            throw resolved.reason === 'field-not-declared'
                                ? dataError(
                                    COLLECTION_INVALID_VALUE_CODE,
                                    'Collection identity tag names a field the admitted contract does not declare',
                                )
                                : dataError(
                                    ACCOUNT_DATA_UNAVAILABLE_CODE,
                                    'Account encryption material is unavailable',
                                );
                        }
                        return resolved.tag;
                    },
                    async get(rowId: string, options?: Readonly<{ signal?: AbortSignal }>) {
                        const credentials = await currentCredentials(options?.signal);
                        const encryption = await currentEncryption(credentials, options?.signal, 'observed');
                        let requestBody: ReturnType<typeof PluginCollectionGetRequestV1Schema.parse>;
                        try {
                            requestBody = PluginCollectionGetRequestV1Schema.parse({
                                pluginId: lifecycle.pluginId,
                                collectionId: collection.contract.collectionId,
                                readerContext: {
                                    pluginId: collection.contract.pluginId,
                                    collectionId: collection.contract.collectionId,
                                    schemaVersion: collection.contract.schemaVersion,
                                    contractDigest: collection.contract.contractDigest,
                                },
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
                        if (!parsed.data.row) {
                            admitted?.reads?.rows.delete(rowId);
                            return null;
                        }
                        return materialize(parsed.data.row, encryption.mode, encryption.material);
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
                        admitted?.reads?.rows.delete(rowId);
                        return Object.freeze({ rowId: entry.rowId, revision: entry.revision, deleted: true as const });
                    },
                    async query(requestInput: PluginCollectionQuery, options?: Readonly<{ signal?: AbortSignal }>) {
                        const credentials = await currentCredentials(options?.signal);
                        const encryption = await currentEncryption(credentials, options?.signal, 'observed');
                        if (!collection.contract.indexes.some((index) => index.id === requestInput.index)) {
                            throw dataError(COLLECTION_INVALID_VALUE_CODE, 'Collection query names an undeclared index');
                        }
                        let requestBody: ReturnType<typeof PluginCollectionQueryRequestV1Schema.parse>;
                        try {
                            requestBody = PluginCollectionQueryRequestV1Schema.parse({
                                pluginId: lifecycle.pluginId,
                                collectionId: collection.contract.collectionId,
                                readerContext: {
                                    pluginId: collection.contract.pluginId,
                                    collectionId: collection.contract.collectionId,
                                    schemaVersion: collection.contract.schemaVersion,
                                    contractDigest: collection.contract.contractDigest,
                                },
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
                            overheadEncodedBytes = sealed.measurement.overheadEncodedBytes;
                            operationEncodedBytes.push(...sealed.measurement.operationEncodedBytes);
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
                boundCollections.set(definition, bound);
                return bound;
            };

            return Object.freeze({
                kv: createAccountKvScope(),
                collection: bindDeclaredCollection,
            });
        },
    });
    return host;
}
