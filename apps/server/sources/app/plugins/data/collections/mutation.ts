import type { Prisma } from "@prisma/client";
import { PLUGIN_COLLECTION_REVISION_MAX } from '@happier-dev/protocol/plugins/data/collectionLimitsV1';
import { PluginAccountPluginIntentV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { PluginCollectionContentEnvelopeV1Schema, PluginCollectionMutationErrorV1Schema, PluginCollectionMutationRequestV1Schema, PluginCollectionMutationResultV1Schema, PluginCollectionProjectionV1Schema, assertPluginCollectionContentEnvelopeForModeV1, encodePluginCollectionIndexSortKeyV1, getPluginCollectionScalarKindV1, measurePluginCollectionMutationRequestEncodedBytesV1, type NormalizedPluginAccountCollectionContractV1, type PluginCollectionMutationErrorCodeV1, type PluginCollectionMutationErrorV1, type PluginCollectionMutationOperationV1, type PluginCollectionMutationRequestV1, type PluginCollectionMutationResultV1, PluginCollectionForgetRequestV1Schema, PluginCollectionForgetResultV1Schema, type PluginCollectionForgetResultV1, type PluginCollectionProjectionV1, type PluginCollectionRelationRestrictionContinuationV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { buildPluginDomainAccountChangeEntityId } from '@happier-dev/protocol/changes/pluginDomain';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isCanonicalPluginCollectionIndexedInstantV1 } from '@happier-dev/protocol/plugins/data/collectionUiQueryWireV1';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { type PluginCollectionRelationV1 } from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import { type PluginDataCollectionsCapabilities } from '@happier-dev/protocol/features/payload/capabilities/pluginDataCollectionsCapabilities';

import { acquireAccountChangePublicationLocksInTx, markAccountChanged, type AccountChangePublication } from "@/app/changes/markAccountChanged";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isPrismaErrorCode } from "@/storage/db";
import { inTx, transactionResult, type TransactionResult, type Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";

import {
    PluginCollectionContractMaterializationError,
    readMaterializedPluginCollectionContract,
} from "./contracts";
import { retirePluginCollectionCandidatePreparationStagesTx } from "./candidatePreparationLifecycle";
import { resolvePluginCollectionHostReferenceForAuthenticationInTx } from "./hostReferenceResolver";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import type { PluginCollectionHostReferenceKind } from "./hostReferences";
import {
    findPluginCollectionBatchQuotaIncompatibility,
    measurePluginCollectionStoredRowEncodedBytes as measureStoredRowEncodedBytes,
    PluginCollectionQuotaCensusInconsistencyError,
    type PluginCollectionQuotaIncompatibility,
} from "./quota";
import { createPluginCollectionMutationQuotaInTx, type PluginCollectionQuotaRowWrite } from './mutationQuota';
import { endCollectionSharingInTx, publishCollectionSharingRowsChangedInTx, readCollectionSharingAudienceInTx } from './sharingStorage';

export { measurePluginCollectionStoredRowEncodedBytes } from "./quota";

type StoredCollectionContract = Readonly<{
    id: string;
    pluginId: string;
    collectionId: string;
    schemaVersion: number;
    contractDigest: string;
    normalizedSchema: unknown;
    indexes: unknown;
    relations: unknown;
    privacyProjection: unknown;
}>;

type CurrentCollectionIndexState = Readonly<{
    id: string;
    indexId: string;
    contractId: string;
    contractDigest: string;
    buildState: string;
    indexedThroughRevision: number | null;
}>;

/** One contract/index-state resolution consumed by every Data-owned row writer. */
export type ResolvedWritableCollection = Readonly<{
    encryptionMode: "plain" | "e2ee";
    contractId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
    indexStates: readonly CurrentCollectionIndexState[];
}>;

type ExistingRow = Readonly<{
    id: string;
    rowId: string;
    revision: number;
    deletedAt: Date | null;
}>;

export type RelationRowChange = Readonly<{
    rowDbId: string;
    rowId: string;
    revision: number;
    projection: PluginCollectionProjectionV1 | null;
}>;

type RelationRestriction = Readonly<{
    dependentCount: number;
    continuation: PluginCollectionRelationRestrictionContinuationV1;
}>;

function rethrowPluginCollectionQuotaCensusError(error: unknown): never {
    if (
        error instanceof PluginCollectionQuotaCensusInconsistencyError
        || error instanceof PluginCollectionContractMaterializationError
    ) {
        throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
    }
    throw error;
}

export class PluginCollectionMutationOperationError extends Error {
    readonly dimension: PluginCollectionQuotaIncompatibility["dimension"] | undefined;
    readonly effectiveMaximum: number | undefined;

    constructor(
        readonly code: PluginCollectionMutationErrorCodeV1,
        readonly details?: RelationRestriction | PluginCollectionQuotaIncompatibility,
    ) {
        super(code);
        this.name = "PluginCollectionMutationOperationError";
        this.dimension = details && "dimension" in details ? details.dimension : undefined;
        this.effectiveMaximum = details && "effectiveMaximum" in details
            ? details.effectiveMaximum
            : undefined;
    }

    toWireError(): PluginCollectionMutationErrorV1 {
        if (this.code === "collection_relation_restricted") {
            if (
                !this.details
                || !("dependentCount" in this.details)
                || !("continuation" in this.details)
            ) {
                throw new Error("Collection relation restriction is missing its continuation");
            }
            return PluginCollectionMutationErrorV1Schema.parse({
                error: this.code,
                ...this.details,
            });
        }
        if (this.code === "collection_quota_incompatible") {
            if (
                !this.details
                || !("dimension" in this.details)
                || !("effectiveMaximum" in this.details)
            ) {
                throw new Error("Collection quota incompatibility is missing its effective limit");
            }
            return PluginCollectionMutationErrorV1Schema.parse({ error: this.code, ...this.details });
        }
        return PluginCollectionMutationErrorV1Schema.parse({ error: this.code });
    }
}

/**
 * The sole Collection currentness allocator. Row revisions and the one
 * Account/plugin/Collection absence epoch share a monotone space seeded from
 * each other, and every provider persists them in the same signed 32-bit
 * `Int` column, so they share this one ceiling. Every increment path — put,
 * delete, relation nullification, forget's retired revision and epoch,
 * candidate promotion, Account erase, and the Account encryption transition —
 * advances through here so none of them can silently overflow the column.
 */
export function advancePluginCollectionRevision(previous: number): number {
    if (previous >= PLUGIN_COLLECTION_REVISION_MAX) {
        throw new PluginCollectionMutationOperationError("collection_revision_exhausted");
    }
    return previous + 1;
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
    }
    return JSON.parse(encoded) as Prisma.InputJsonValue;
}

function fieldSchemaForContract(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    field: string;
}>): object {
    const schema = input.contract.schema;
    const fieldSchema = schema.type === "object" ? schema.properties?.[input.field] : undefined;
    if (!fieldSchema) {
        throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
    }
    return fieldSchema;
}

function fieldIsRequired(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    field: string;
}>): boolean {
    return input.contract.schema.type === "object"
        && input.contract.schema.required?.includes(input.field) === true;
}

/**
 * The AJV validators one resolved contract needs, prepared lazily once per
 * operation and reused across every row and projection field inside it. A
 * fresh AJV instance per compiled schema is the dominant admission cost; the
 * admitted contract is immutable for the operation, so re-preparing it per
 * field per row only lengthens the write transaction. This holder lives for
 * exactly one operation — the caller creates it at the resolved-contract
 * boundary; there is deliberately no persistent cross-operation cache.
 */
export type PluginCollectionContractValidators = Readonly<{
    fieldValidator(field: string): ReturnType<typeof compilePluginJsonSchema>;
    logicalRowValidator(): ReturnType<typeof compilePluginJsonSchema>;
}>;

export function createPluginCollectionContractValidators(
    contract: NormalizedPluginAccountCollectionContractV1,
): PluginCollectionContractValidators {
    const fieldValidators = new Map<string, ReturnType<typeof compilePluginJsonSchema>>();
    let logicalRow: ReturnType<typeof compilePluginJsonSchema> | null = null;
    return Object.freeze({
        fieldValidator(field) {
            const existing = fieldValidators.get(field);
            if (existing) return existing;
            let validate: ReturnType<typeof compilePluginJsonSchema>;
            try {
                validate = compilePluginJsonSchema(fieldSchemaForContract({ contract, field }));
            } catch {
                throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
            }
            fieldValidators.set(field, validate);
            return validate;
        },
        logicalRowValidator() {
            if (!logicalRow) {
                try {
                    logicalRow = compilePluginJsonSchema(contract.schema);
                } catch {
                    throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
                }
            }
            return logicalRow;
        },
    });
}

function validateProjection(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    validators: PluginCollectionContractValidators;
    rowId: string;
    projection: PluginCollectionProjectionV1;
}>): PluginCollectionProjectionV1 {
    const expected = new Set(input.contract.serverReadable);
    const actual = Object.keys(input.projection);
    if (actual.length !== expected.size || actual.some((field) => !expected.has(field))) {
        throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
    }

    for (const field of input.contract.serverReadable) {
        const value = input.projection[field];
        if (value === undefined && !hasOwn(input.projection, field)) {
            throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
        }
        if (field === input.contract.rowIdField && value !== input.rowId) {
            throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
        }
        if (value === null) {
            if (fieldIsRequired({ contract: input.contract, field })) {
                throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
            }
            continue;
        }
        const validate = input.validators.fieldValidator(field);
        if (!isValidPluginJsonSchemaValue(validate, value)) {
            throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
        }
        let kind: ReturnType<typeof getPluginCollectionScalarKindV1>;
        try {
            kind = getPluginCollectionScalarKindV1({ schema: input.contract.schema, field });
        } catch {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
        if (
            kind === "instant"
            && (typeof value !== "string" || !isCanonicalPluginCollectionIndexedInstantV1(value))
        ) {
            throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
        }
    }
    return input.projection;
}

function validatePlainLogicalRow(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    validators: PluginCollectionContractValidators;
    operation: Extract<PluginCollectionMutationOperationV1, { kind: "put" }>;
    projection: PluginCollectionProjectionV1;
}>): void {
    if (input.operation.content.t !== "plain") {
        throw new PluginCollectionMutationOperationError("collection_content_mode_mismatch");
    }
    const reserved = new Set([
        input.contract.rowIdField,
        ...input.contract.serverReadable,
    ]);
    for (const field of Object.keys(input.operation.content.v)) {
        if (reserved.has(field)) {
            throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
        }
    }

    const logical = Object.create(null) as Record<string, unknown>;
    for (const [field, value] of Object.entries(input.operation.content.v)) {
        Object.defineProperty(logical, field, {
            value,
            enumerable: true,
            writable: false,
            configurable: false,
        });
    }
    for (const field of input.contract.serverReadable) {
        const value = input.projection[field];
        if (value === null && !fieldIsRequired({ contract: input.contract, field })) {
            continue;
        }
        Object.defineProperty(logical, field, {
            value,
            enumerable: true,
            writable: false,
            configurable: false,
        });
    }
    if (!hasOwn(logical, input.contract.rowIdField)) {
        Object.defineProperty(logical, input.contract.rowIdField, {
            value: input.operation.rowId,
            enumerable: true,
            writable: false,
            configurable: false,
        });
    }
    const validate = input.validators.logicalRowValidator();
    if (!isValidPluginJsonSchemaValue(validate, logical)) {
        throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
    }
}

function validateCollectionContentAndProjection(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    validators: PluginCollectionContractValidators;
    encryptionMode: "plain" | "e2ee";
    rowId: string;
    content: unknown;
    projection: PluginCollectionProjectionV1;
}>): Readonly<{
    content: ReturnType<typeof PluginCollectionContentEnvelopeV1Schema.parse>;
    projection: PluginCollectionProjectionV1;
}> {
    const parsedContent = PluginCollectionContentEnvelopeV1Schema.safeParse(input.content);
    if (!parsedContent.success) {
        throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
    }
    try {
        assertPluginCollectionContentEnvelopeForModeV1(parsedContent.data, input.encryptionMode);
    } catch {
        throw new PluginCollectionMutationOperationError("collection_content_mode_mismatch");
    }
    const projection = validateProjection({
        contract: input.contract,
        validators: input.validators,
        rowId: input.rowId,
        projection: input.projection,
    });
    if (input.encryptionMode === "plain") {
        validatePlainLogicalRow({
            contract: input.contract,
            validators: input.validators,
            operation: {
                kind: "put",
                rowId: input.rowId,
                expectedRevision: 0,
                content: parsedContent.data,
                projection,
            },
            projection,
        });
    }
    return { content: parsedContent.data, projection };
}

function validatePutContent(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    validators: PluginCollectionContractValidators;
    encryptionMode: "plain" | "e2ee";
    operation: Extract<PluginCollectionMutationOperationV1, { kind: "put" }>;
}>): PluginCollectionProjectionV1 {
    return validateCollectionContentAndProjection({
        contract: input.contract,
        validators: input.validators,
        encryptionMode: input.encryptionMode,
        rowId: input.operation.rowId,
        content: input.operation.content,
        projection: input.operation.projection,
    }).projection;
}

function indexSortKey(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    index: NormalizedPluginAccountCollectionContractV1["indexes"][number];
    rowId: string;
    projection: PluginCollectionProjectionV1;
}>): Uint8Array {
    let fields: Array<{
        kind: ReturnType<typeof getPluginCollectionScalarKindV1>;
        value: PluginCollectionProjectionV1[keyof PluginCollectionProjectionV1];
        direction: "asc" | "desc";
    }>;
    try {
        fields = input.index.fields.map((field) => ({
                kind: getPluginCollectionScalarKindV1({
                    schema: input.contract.schema,
                    field: field.field,
                }),
                value: field.field === input.contract.rowIdField
                    ? input.rowId
                    : input.projection[field.field]!,
                direction: field.direction,
            }));
    } catch {
        throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
    }
    try {
        return encodePluginCollectionIndexSortKeyV1({
            fields,
            rowId: input.rowId,
        });
    } catch {
        // The contract has already admitted the index shape. At this point an
        // encoding failure is a caller-supplied indexed scalar/compound key.
        throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
    }
}

export type PluginCollectionIndexEntryWrite = Readonly<{
    indexStateId: string;
    encodedSortKey: Uint8Array<ArrayBuffer>;
    rowId: string;
    rowRevision: number;
}>;

export type PluginCollectionIndexValue = Readonly<{
    indexId: string;
    encodedSortKey: Uint8Array<ArrayBuffer>;
}>;

function copyIndexSortKey(input: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    return copy;
}

/** Validates and derives index bytes independently of persisted index-state ids. */
export function buildPluginCollectionIndexValues(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    rowId: string;
    projection: PluginCollectionProjectionV1;
}>): readonly PluginCollectionIndexValue[] {
    return input.contract.indexes.map((index) => ({
        indexId: index.id,
        encodedSortKey: copyIndexSortKey(indexSortKey({
            contract: input.contract,
            index,
            rowId: input.rowId,
            projection: input.projection,
        })),
    }));
}

/** The shared index derivation owner for ordinary writes and candidate promotion. */
export function buildPluginCollectionIndexEntries(input: Readonly<{
    resolved: ResolvedWritableCollection;
    rowId: string;
    revision: number;
    projection: PluginCollectionProjectionV1 | null;
    values?: readonly PluginCollectionIndexValue[];
}>): readonly PluginCollectionIndexEntryWrite[] {
    const projection = input.projection;
    const stateByIndex = new Map(input.resolved.indexStates.map((state) => [state.indexId, state]));
    if (projection === null && input.values === undefined) return [];
    const values = input.values ?? buildPluginCollectionIndexValues({
        contract: input.resolved.contract,
        rowId: input.rowId,
        projection: projection!,
    });
    if (
        values.length !== input.resolved.contract.indexes.length
        || values.some((value) => !stateByIndex.has(value.indexId))
    ) {
        throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
    }
    return values.map((value) => {
        const state = stateByIndex.get(value.indexId);
        if (!state) throw new PluginCollectionMutationOperationError("collection_index_not_ready");
        return {
            indexStateId: state.id,
            encodedSortKey: copyIndexSortKey(value.encodedSortKey),
            rowId: input.rowId,
            rowRevision: input.revision,
        };
    });
}

async function resolveWritableCollectionInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    encryptionMode: "plain" | "e2ee";
    request: Pick<PluginCollectionMutationRequestV1, "pluginId" | "collectionId" | "writerContext">;
}>): Promise<ResolvedWritableCollection> {
    const intent = await input.tx.accountPluginIntent.findUnique({
        where: {
            accountId_pluginId: {
                accountId: input.accountId,
                pluginId: input.request.pluginId,
            },
        },
        select: {
            pluginId: true,
            desiredVersion: true,
            enabled: true,
            offlineUiHosting: true,
            writableCollections: true,
            revision: true,
        },
    });
    if (!intent) throw new PluginCollectionMutationOperationError("collection_unavailable");
    const parsedIntent = PluginAccountPluginIntentV1Schema.safeParse({
        pluginId: intent.pluginId,
        desiredVersion: intent.desiredVersion,
        enabled: intent.enabled,
        offlineUiHosting: intent.offlineUiHosting,
        writableCollections: intent.writableCollections,
        revision: intent.revision.toString(),
    });
    if (!parsedIntent.success || !parsedIntent.data.enabled) {
        throw new PluginCollectionMutationOperationError("collection_unavailable");
    }
    const writer = parsedIntent.data.writableCollections.find((candidate) => (
        candidate.collectionId === input.request.collectionId
    ));
    if (
        !writer
        || writer.schemaVersion !== input.request.writerContext.schemaVersion
        || writer.contractDigest !== input.request.writerContext.contractDigest
    ) {
        throw new PluginCollectionMutationOperationError("collection_writer_contract_unavailable");
    }

    const persisted = await input.tx.pluginCollectionContract.findFirst({
        where: {
            pluginId: writer.pluginId,
            collectionId: writer.collectionId,
            schemaVersion: writer.schemaVersion,
            contractDigest: writer.contractDigest,
        },
        select: {
            id: true,
            pluginId: true,
            collectionId: true,
            schemaVersion: true,
            contractDigest: true,
            normalizedSchema: true,
            indexes: true,
            relations: true,
            privacyProjection: true,
        },
    });
    if (!persisted) throw new PluginCollectionMutationOperationError("collection_writer_contract_unavailable");
    let contract: NormalizedPluginAccountCollectionContractV1;
    try {
        contract = readMaterializedPluginCollectionContract(persisted as StoredCollectionContract);
    } catch {
        throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
    }
    const indexStates = await input.tx.pluginCollectionIndexState.findMany({
        where: {
            accountId: input.accountId,
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            contractDigest: contract.contractDigest,
        },
        select: {
            id: true,
            indexId: true,
            contractId: true,
            contractDigest: true,
            buildState: true,
            indexedThroughRevision: true,
        },
    });
    const statesByIndex = new Map(indexStates.map((state) => [state.indexId, state]));
    for (const index of contract.indexes) {
        const state = statesByIndex.get(index.id);
        if (
            !state
            || state.contractId !== persisted.id
            || state.contractDigest !== contract.contractDigest
            || state.buildState !== "ready"
            || state.indexedThroughRevision === null
        ) {
            throw new PluginCollectionMutationOperationError("collection_index_not_ready");
        }
    }
    return {
        encryptionMode: input.encryptionMode,
        contractId: persisted.id,
        contract,
        indexStates,
    };
}

async function resolveDerivedCollectionWithExpectedBuildStateInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    encryptionMode: "plain" | "e2ee";
    contractId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
    expectedBuildState: "building" | "ready";
}>): Promise<ResolvedWritableCollection> {
    const indexStates = await input.tx.pluginCollectionIndexState.findMany({
        where: {
            accountId: input.accountId,
            pluginId: input.contract.pluginId,
            collectionId: input.contract.collectionId,
            contractDigest: input.contract.contractDigest,
        },
        select: {
            id: true,
            indexId: true,
            contractId: true,
            contractDigest: true,
            buildState: true,
            indexedThroughRevision: true,
        },
    });
    const statesByIndex = new Map(indexStates.map((state) => [state.indexId, state]));
    for (const index of input.contract.indexes) {
        const state = statesByIndex.get(index.id);
        if (
            !state
            || state.contractId !== input.contractId
            || state.contractDigest !== input.contract.contractDigest
            || state.buildState !== input.expectedBuildState
            || (
                input.expectedBuildState === "ready"
                    ? state.indexedThroughRevision === null
                    : state.indexedThroughRevision !== null
            )
        ) {
            throw new PluginCollectionMutationOperationError("collection_index_not_ready");
        }
    }
    return {
        encryptionMode: input.encryptionMode,
        contractId: input.contractId,
        contract: input.contract,
        indexStates,
    };
}

export async function resolveDerivedCollectionInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    encryptionMode: "plain" | "e2ee";
    contractId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
}>): Promise<ResolvedWritableCollection> {
    return await resolveDerivedCollectionWithExpectedBuildStateInTx({
        ...input,
        expectedBuildState: "ready",
    });
}

/**
 * Installs a target contract's derived state only inside the already fenced
 * Availability promotion transaction. The ordinary mutation writer and the
 * promotion path then share the exact same index/relationship derivation.
 */
export async function preparePluginCollectionDerivedStateForPromotionInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    encryptionMode: "plain" | "e2ee";
    contractId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
}>): Promise<ResolvedWritableCollection> {
    for (const index of input.contract.indexes) {
        const identity = {
            accountId: input.accountId,
            pluginId: input.contract.pluginId,
            collectionId: input.contract.collectionId,
            indexId: index.id,
            contractDigest: input.contract.contractDigest,
        };
        let state = await input.tx.pluginCollectionIndexState.findUnique({
            where: { accountId_pluginId_collectionId_indexId_contractDigest: identity },
            select: { id: true, contractId: true },
        });
        if (!state) {
            try {
                state = await input.tx.pluginCollectionIndexState.create({
                    data: {
                        ...identity,
                        contractId: input.contractId,
                        buildState: "building",
                        indexedThroughRevision: null,
                    },
                    select: { id: true, contractId: true },
                });
            } catch (error) {
                if (!isPrismaErrorCode(error, "P2002")) throw error;
                state = await input.tx.pluginCollectionIndexState.findUnique({
                    where: { accountId_pluginId_collectionId_indexId_contractDigest: identity },
                    select: { id: true, contractId: true },
                });
            }
        }
        if (!state || state.contractId !== input.contractId) {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
        await input.tx.pluginCollectionIndexState.update({
            where: { id: state.id },
            data: { buildState: "building", indexedThroughRevision: null, quotaPrefixCounts: {} },
        });
        await input.tx.pluginCollectionIndexEntry.deleteMany({ where: { indexStateId: state.id } });
    }
    return await resolveDerivedCollectionWithExpectedBuildStateInTx({
        ...input,
        expectedBuildState: "building",
    });
}

/**
 * Finishes the target index build inside the Availability promotion transaction.
 * The target contract is not publishable until every live row is at the exact
 * target contract and has one current entry for each declared target index.
 */
export async function finalizePluginCollectionDerivedStateForPromotionInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    resolved: ResolvedWritableCollection;
}>): Promise<void> {
    const statesByIndex = new Map(input.resolved.indexStates.map((state) => [state.indexId, state]));
    const states = input.resolved.contract.indexes.map((index) => {
        const state = statesByIndex.get(index.id);
        if (
            !state
            || state.contractId !== input.resolved.contractId
            || state.contractDigest !== input.resolved.contract.contractDigest
            || state.buildState !== "building"
            || state.indexedThroughRevision !== null
        ) {
            throw new PluginCollectionMutationOperationError("collection_index_not_ready");
        }
        return state;
    });
    if (states.length === 0) return;

    const liveRows = await input.tx.pluginCollectionRow.findMany({
        where: {
            accountId: input.accountId,
            pluginId: input.resolved.contract.pluginId,
            collectionId: input.resolved.contract.collectionId,
            deletedAt: null,
        },
        select: {
            rowId: true,
            revision: true,
            contractId: true,
            contractDigest: true,
            schemaVersion: true,
        },
    });
    const rowsById = new Map(liveRows.map((row) => [row.rowId, row]));
    if (
        rowsById.size !== liveRows.length
        || liveRows.some((row) => (
            row.contractId !== input.resolved.contractId
            || row.contractDigest !== input.resolved.contract.contractDigest
            || row.schemaVersion !== input.resolved.contract.schemaVersion
        ))
    ) {
        throw new PluginCollectionMutationOperationError("collection_index_not_ready");
    }

    const entries = await input.tx.pluginCollectionIndexEntry.findMany({
        where: { indexStateId: { in: states.map((state) => state.id) } },
        select: { indexStateId: true, rowId: true, rowRevision: true },
    });
    const entriesByState = new Map<string, Map<string, number>>();
    for (const entry of entries) {
        const entriesByRowId = entriesByState.get(entry.indexStateId) ?? new Map<string, number>();
        if (entriesByRowId.has(entry.rowId)) {
            throw new PluginCollectionMutationOperationError("collection_index_not_ready");
        }
        entriesByRowId.set(entry.rowId, entry.rowRevision);
        entriesByState.set(entry.indexStateId, entriesByRowId);
    }
    for (const state of states) {
        const entriesByRowId = entriesByState.get(state.id);
        if (
            !entriesByRowId
            || entriesByRowId.size !== rowsById.size
            || [...rowsById.values()].some((row) => entriesByRowId.get(row.rowId) !== row.revision)
        ) {
            throw new PluginCollectionMutationOperationError("collection_index_not_ready");
        }
    }

    const indexedThroughRevision = Math.max(0, ...liveRows.map((row) => row.revision));
    const finalized = await input.tx.pluginCollectionIndexState.updateMany({
        where: {
            id: { in: states.map((state) => state.id) },
            buildState: "building",
            indexedThroughRevision: null,
        },
        data: { buildState: "ready", indexedThroughRevision },
    });
    if (finalized.count !== states.length) {
        throw new PluginCollectionMutationOperationError("collection_index_not_ready");
    }
}

function conflictFor(input: Readonly<{
    operation: PluginCollectionMutationOperationV1;
    existing: ExistingRow | undefined;
    absenceEpoch: number;
}>): Readonly<{ rowId: string; revision: number | null; deleted: boolean }> | null {
    const existing = input.existing;
    if (input.operation.kind === "put") {
        if (input.operation.expectedRevision === "absent") {
            if (input.operation.expectedAbsenceEpoch !== input.absenceEpoch) {
                return {
                    rowId: input.operation.rowId,
                    revision: existing?.revision ?? null,
                    deleted: existing ? existing.deletedAt !== null : false,
                };
            }
            if (!existing) return null;
            return {
                rowId: input.operation.rowId,
                revision: existing.revision,
                deleted: existing.deletedAt !== null,
            };
        }
    }
    if (!existing || existing.revision !== input.operation.expectedRevision) {
        return {
            rowId: input.operation.rowId,
            revision: existing?.revision ?? null,
            deleted: existing ? existing.deletedAt !== null : false,
        };
    }
    if ((input.operation.kind === "delete" || input.operation.kind === "assert") && existing.deletedAt !== null) {
        return {
            rowId: input.operation.rowId,
            revision: existing.revision,
            deleted: true,
        };
    }
    return null;
}

export async function replaceIndexEntriesForRowTx(input: Readonly<{
    tx: Tx;
    resolved: ResolvedWritableCollection;
    rowId: string;
    revision: number;
    projection: PluginCollectionProjectionV1 | null;
}>): Promise<readonly PluginCollectionIndexEntryWrite[]> {
    const entries = buildPluginCollectionIndexEntries(input);
    for (const index of input.resolved.contract.indexes) {
        const state = input.resolved.indexStates.find((candidate) => candidate.indexId === index.id);
        if (!state) throw new PluginCollectionMutationOperationError("collection_index_not_ready");
        await input.tx.pluginCollectionIndexEntry.deleteMany({
            where: { indexStateId: state.id, rowId: input.rowId },
        });
    }
    if (entries.length > 0) {
        await input.tx.pluginCollectionIndexEntry.createMany({ data: [...entries] });
    }
    return entries;
}

function hostRelationTargetKind(hostKind: PluginCollectionHostReferenceKind): string {
    return `host:${hostKind}`;
}

export type PluginCollectionPreparedRelationEdge = Readonly<{
    change: RelationRowChange;
    relation: PluginCollectionRelationV1;
    targetRowId: string;
}>;

export type PluginCollectionPreparedRelationReplacement = Readonly<{
    sourceRowDbIds: readonly string[];
    edges: readonly PluginCollectionPreparedRelationEdge[];
}>;

function deriveRelationEdges(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    changes: readonly RelationRowChange[];
}>): readonly PluginCollectionPreparedRelationEdge[] {
    const edges: PluginCollectionPreparedRelationEdge[] = [];
    for (const change of input.changes) {
        if (change.projection === null) continue;
        for (const relation of input.contract.relations) {
            const targetRowId = change.projection[relation.field];
            if (targetRowId === null) {
                if (relation.kind === "collection" && relation.required) {
                    throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
                }
                continue;
            }
            if (typeof targetRowId !== "string") {
                throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
            }
            edges.push({ change, relation, targetRowId });
        }
    }
    return edges;
}

function boundedChunks<T>(items: readonly T[], maximumSize: number): T[][] {
    if (!Number.isSafeInteger(maximumSize) || maximumSize < 1) {
        throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
    }
    const chunks: T[][] = [];
    for (let start = 0; start < items.length; start += maximumSize) {
        chunks.push(items.slice(start, start + maximumSize));
    }
    return chunks;
}

async function validateCollectionRelationTargetsInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
    edges: readonly PluginCollectionPreparedRelationEdge[];
    maximumBatchRows: number;
}>): Promise<void> {
    const targetsByCollection = new Map<string, Set<string>>();
    for (const edge of input.edges) {
        if (edge.relation.kind !== "collection") continue;
        const targets = targetsByCollection.get(edge.relation.collectionId) ?? new Set<string>();
        targets.add(edge.targetRowId);
        targetsByCollection.set(edge.relation.collectionId, targets);
    }
    for (const [collectionId, targets] of targetsByCollection) {
        for (const rowIds of boundedChunks([...targets], input.maximumBatchRows)) {
            const found = await input.tx.pluginCollectionRow.findMany({
                where: {
                    accountId: input.accountId,
                    pluginId: input.contract.pluginId,
                    collectionId,
                    rowId: { in: rowIds },
                    deletedAt: null,
                },
                select: { rowId: true },
            });
            if (found.length !== rowIds.length) {
                throw new PluginCollectionMutationOperationError("collection_relation_unavailable");
            }
        }
    }
}

async function validateHostRelationTargetsInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    edges: readonly PluginCollectionPreparedRelationEdge[];
    maximumBatchRows: number;
    authentication: SessionAccessAuthentication | undefined;
}>): Promise<void> {
    const hostEdges = input.edges.filter((edge) => edge.relation.kind === "host");
    if (hostEdges.length > 0 && !input.authentication) {
        throw new PluginCollectionMutationOperationError("collection_relation_unavailable");
    }
    for (const batch of boundedChunks(hostEdges, input.maximumBatchRows)) {
        await Promise.all(batch.map(async (edge) => {
            if (edge.relation.kind !== "host") return;
            const resolution = await resolvePluginCollectionHostReferenceForAuthenticationInTx({
                tx: input.tx,
                accountId: input.accountId,
                hostKind: edge.relation.hostKind,
                targetId: edge.targetRowId,
                authentication: input.authentication!,
            });
            if (resolution.status !== "available") {
                throw new PluginCollectionMutationOperationError("collection_relation_unavailable");
            }
        }));
    }
}

function assertCandidateRelationUniqueness(input: Readonly<{
    edges: readonly PluginCollectionPreparedRelationEdge[];
}>): void {
    const identities = new Set<string>();
    for (const edge of input.edges) {
        if (edge.relation.kind !== "collection" || !edge.relation.unique) continue;
        const identity = [
            edge.relation.id,
            edge.relation.collectionId,
            edge.targetRowId,
        ].join("\u0000");
        if (identities.has(identity)) {
            throw new PluginCollectionMutationOperationError("collection_relation_unavailable");
        }
        identities.add(identity);
    }
}

async function assertNoPersistedRelationUniquenessCollisionInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
    sourceRowDbIds: readonly string[];
    edges: readonly PluginCollectionPreparedRelationEdge[];
    maximumBatchRows: number;
}>): Promise<void> {
    const replacedSourceRowDbIds = new Set(input.sourceRowDbIds);
    const targetsByRelation = new Map<string, Readonly<{
        relationId: string;
        collectionId: string;
        targets: Set<string>;
    }>>();
    for (const edge of input.edges) {
        if (edge.relation.kind !== "collection" || !edge.relation.unique) continue;
        const identity = [edge.relation.id, edge.relation.collectionId].join("\u0000");
        const existing = targetsByRelation.get(identity);
        if (existing) {
            existing.targets.add(edge.targetRowId);
            continue;
        }
        targetsByRelation.set(identity, {
            relationId: edge.relation.id,
            collectionId: edge.relation.collectionId,
            targets: new Set([edge.targetRowId]),
        });
    }
    for (const { relationId, collectionId, targets } of targetsByRelation.values()) {
        for (const rowIds of boundedChunks([...targets], input.maximumBatchRows)) {
            const collisions = await input.tx.pluginCollectionRelation.findMany({
                where: {
                    accountId: input.accountId,
                    sourcePluginId: input.contract.pluginId,
                    sourceCollectionId: input.contract.collectionId,
                    relationId,
                    targetKind: "collection",
                    targetPluginId: input.contract.pluginId,
                    targetCollectionId: collectionId,
                    targetRowId: { in: rowIds },
                    deletedAt: null,
                },
                select: { sourceRowDbId: true },
            });
            if (collisions.some((collision) => !replacedSourceRowDbIds.has(collision.sourceRowDbId))) {
                throw new PluginCollectionMutationOperationError("collection_relation_unavailable");
            }
        }
    }
}

/**
 * Validates a bounded relation replacement without writing. Candidate
 * promotion consumes this per source page; the ordinary row writer immediately
 * materializes the same plan below.
 */
export async function preparePluginCollectionRelationReplacementInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    actorAccountId?: string;
    contract: NormalizedPluginAccountCollectionContractV1;
    changes: readonly RelationRowChange[];
    maximumBatchRows: number;
    authentication: SessionAccessAuthentication | undefined;
    skipPersistedUniqueRelationCollisionCheck?: boolean;
}>): Promise<PluginCollectionPreparedRelationReplacement> {
    const sourceRowDbIds = input.changes.map((change) => change.rowDbId);
    if (new Set(sourceRowDbIds).size !== sourceRowDbIds.length) {
        throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
    }
    const edges = deriveRelationEdges({ contract: input.contract, changes: input.changes });
    if (input.actorAccountId !== undefined && input.actorAccountId !== input.accountId && input.contract.relations.length > 0) {
        // A grantee may preserve relations, but cannot probe the owner's private
        // Collection or host targets (including private uniqueness collisions).
        // Compare only the admitted source rows' existing edges, then retain them
        // without resolving targets in the owner's authority.
        const edgeIdentity = (sourceRowDbId: string, relationId: string, targetRowId: string | null) =>
            JSON.stringify([sourceRowDbId, relationId, targetRowId]);
        const retained = new Set(edges.map(edge => edgeIdentity(edge.change.rowDbId, edge.relation.id, edge.targetRowId)));
        let existingCount = 0;
        for (const rowDbIds of boundedChunks(sourceRowDbIds, input.maximumBatchRows)) {
            const existing = await input.tx.pluginCollectionRelation.findMany({
                where: { sourceRowDbId: { in: rowDbIds }, deletedAt: null },
                select: { sourceRowDbId: true, relationId: true, targetRowId: true },
            });
            existingCount += existing.length;
            if (existing.some(edge => !retained.has(edgeIdentity(edge.sourceRowDbId, edge.relationId, edge.targetRowId)))) {
                throw new PluginCollectionMutationOperationError("collection_relation_unavailable");
            }
        }
        if (existingCount !== retained.size) {
            throw new PluginCollectionMutationOperationError("collection_relation_unavailable");
        }
        return { sourceRowDbIds, edges };
    }
    await validateCollectionRelationTargetsInTx({
        tx: input.tx,
        accountId: input.accountId,
        contract: input.contract,
        edges,
        maximumBatchRows: input.maximumBatchRows,
    });
    await validateHostRelationTargetsInTx({
        tx: input.tx,
        accountId: input.accountId,
        edges,
        maximumBatchRows: input.maximumBatchRows,
        authentication: input.authentication,
    });
    assertCandidateRelationUniqueness({ edges });
    if (input.skipPersistedUniqueRelationCollisionCheck !== true) {
        await assertNoPersistedRelationUniquenessCollisionInTx({
            tx: input.tx,
            accountId: input.accountId,
            contract: input.contract,
            sourceRowDbIds,
            edges,
            maximumBatchRows: input.maximumBatchRows,
        });
    }
    return { sourceRowDbIds, edges };
}

export async function retirePluginCollectionRelationsForSourceCollectionInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    collectionId: string;
}>): Promise<void> {
    await input.tx.pluginCollectionRelation.updateMany({
        where: {
            accountId: input.accountId,
            sourcePluginId: input.pluginId,
            sourceCollectionId: input.collectionId,
            deletedAt: null,
        },
        data: { deletedAt: new Date() },
    });
}

export async function assertNoActiveUniqueCollectionRelationDuplicatesInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
}>): Promise<void> {
    for (const relation of input.contract.relations) {
        if (relation.kind !== "collection" || !relation.unique) continue;
        const duplicates = await input.tx.pluginCollectionRelation.groupBy({
            by: ["targetRowId"],
            where: {
                accountId: input.accountId,
                sourcePluginId: input.contract.pluginId,
                sourceCollectionId: input.contract.collectionId,
                relationId: relation.id,
                targetKind: "collection",
                targetPluginId: input.contract.pluginId,
                targetCollectionId: relation.collectionId,
                deletedAt: null,
            },
            _count: { _all: true },
            having: { targetRowId: { _count: { gt: 1 } } },
            orderBy: { targetRowId: "asc" },
            take: 1,
        });
        if (duplicates.length > 0) {
            throw new PluginCollectionMutationOperationError("collection_relation_unavailable");
        }
    }
}

/** Materializes a prevalidated relation replacement in bounded setwise writes. */
export async function materializePluginCollectionRelationReplacementInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
    prepared: PluginCollectionPreparedRelationReplacement;
    maximumBatchRows: number;
}>): Promise<void> {
    for (const rowDbIds of boundedChunks(input.prepared.sourceRowDbIds, input.maximumBatchRows)) {
        await input.tx.pluginCollectionRelation.updateMany({
            where: {
                accountId: input.accountId,
                sourceRowDbId: { in: rowDbIds },
                deletedAt: null,
            },
            data: { deletedAt: new Date() },
        });
    }
    for (const edgeBatch of boundedChunks(input.prepared.edges, input.maximumBatchRows)) {
        if (edgeBatch.length === 0) continue;
        await input.tx.pluginCollectionRelation.createMany({
            data: edgeBatch.map((edge) => ({
                accountId: input.accountId,
                sourceRowDbId: edge.change.rowDbId,
                sourcePluginId: input.contract.pluginId,
                sourceCollectionId: input.contract.collectionId,
                sourceRowId: edge.change.rowId,
                relationId: edge.relation.id,
                targetKind: edge.relation.kind === "collection"
                    ? "collection"
                    : hostRelationTargetKind(edge.relation.hostKind),
                targetPluginId: edge.relation.kind === "collection"
                    ? input.contract.pluginId
                    : null,
                targetCollectionId: edge.relation.kind === "collection"
                    ? edge.relation.collectionId
                    : null,
                targetRowId: edge.targetRowId,
                sourceRevision: edge.change.revision,
            })),
        });
    }
}

/**
 * Replaces derived relations for one bounded set of already-validated row
 * changes. The ordinary row writer delegates through the same preflight and
 * materialization owners that candidate promotion consumes separately.
 */
export async function replaceRelationEdgesForRowsTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    actorAccountId?: string;
    resolved: ResolvedWritableCollection;
    changes: readonly RelationRowChange[];
    maximumBatchRows: number;
    authentication: SessionAccessAuthentication | undefined;
}>): Promise<void> {
    const prepared = await preparePluginCollectionRelationReplacementInTx({
        tx: input.tx,
        accountId: input.accountId,
        actorAccountId: input.actorAccountId,
        contract: input.resolved.contract,
        changes: input.changes,
        maximumBatchRows: input.maximumBatchRows,
        authentication: input.authentication,
    });
    await materializePluginCollectionRelationReplacementInTx({
        tx: input.tx,
        accountId: input.accountId,
        contract: input.resolved.contract,
        prepared,
        maximumBatchRows: input.maximumBatchRows,
    });
}

export async function replaceRelationEdgesForRowTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    resolved: ResolvedWritableCollection;
    change: RelationRowChange;
}>): Promise<void> {
    await replaceRelationEdgesForRowsTx({
        tx: input.tx,
        accountId: input.accountId,
        resolved: input.resolved,
        changes: [input.change],
        maximumBatchRows: 1,
        authentication: undefined,
    });
}

function readStoredProjection(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    validators: PluginCollectionContractValidators;
    rowId: string;
    projections: readonly Readonly<{ fieldId: string; typedEncodedValue: string }>[];
}>): PluginCollectionProjectionV1 {
    const projection: Record<string, unknown> = {};
    for (const stored of input.projections) {
        if (hasOwn(projection, stored.fieldId)) {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
        try {
            projection[stored.fieldId] = JSON.parse(stored.typedEncodedValue);
        } catch {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
    }
    const parsed = PluginCollectionProjectionV1Schema.safeParse(projection);
    if (!parsed.success) {
        throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
    }
    try {
        return validateProjection({
            contract: input.contract,
            validators: input.validators,
            rowId: input.rowId,
            projection: parsed.data,
        });
    } catch (error) {
        if (error instanceof PluginCollectionMutationOperationError) throw error;
        throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
    }
}

/**
 * The transition adapter uses the same private-envelope and plaintext logical
 * row validation as the only live Collection writer. It receives projections
 * from persisted derived state; it never becomes a second crypto/mode owner.
 */
export function assertPluginCollectionStoredContentForAccountTransition(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    encryptionMode: "plain" | "e2ee";
    rowId: string;
    contentEnvelope: unknown;
    projections: readonly Readonly<{
        fieldId: string;
        typedEncodedValue: string;
    }>[];
}>): Readonly<{
    content: ReturnType<typeof PluginCollectionContentEnvelopeV1Schema.parse>;
    projection: PluginCollectionProjectionV1;
}> {
    const validators = createPluginCollectionContractValidators(input.contract);
    const projection = readStoredProjection({
        contract: input.contract,
        validators,
        rowId: input.rowId,
        projections: input.projections,
    });
    return validateCollectionContentAndProjection({
        contract: input.contract,
        validators,
        encryptionMode: input.encryptionMode,
        rowId: input.rowId,
        content: input.contentEnvelope,
        projection,
    });
}

async function applyIncomingRelationDeletesTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    resolved: ResolvedWritableCollection;
    targetRowIds: readonly string[];
    beforeRowChange: (change: Readonly<{ resolved: ResolvedWritableCollection; rowId: string }>) => Promise<void>;
    afterRowChange: (change: PluginCollectionQuotaRowWrite) => void;
}>): Promise<readonly Readonly<{
    resolved: ResolvedWritableCollection;
    rowDbId: string;
    rowId: string;
    revision: number;
}>[]> {
    const targetRowIds = [...new Set(input.targetRowIds)];
    if (targetRowIds.length === 0) return [];
    const incoming = await input.tx.pluginCollectionRelation.findMany({
        where: {
            accountId: input.accountId,
            targetKind: "collection",
            targetPluginId: input.resolved.contract.pluginId,
            targetCollectionId: input.resolved.contract.collectionId,
            targetRowId: { in: targetRowIds },
            deletedAt: null,
        },
        orderBy: [
            { sourceCollectionId: "asc" },
            { relationId: "asc" },
            { sourceRowId: "asc" },
            { targetRowId: "asc" },
        ],
        take: 201,
        select: {
            sourcePluginId: true,
            sourceCollectionId: true,
            sourceRowId: true,
            relationId: true,
            sourceRevision: true,
            targetPluginId: true,
            targetCollectionId: true,
            targetRowId: true,
            sourceRow: {
                select: {
                    id: true,
                    rowId: true,
                    revision: true,
                    deletedAt: true,
                    contentEnvelope: true,
                    contract: {
                        select: {
                            id: true,
                            pluginId: true,
                            collectionId: true,
                            schemaVersion: true,
                            contractDigest: true,
                            normalizedSchema: true,
                            indexes: true,
                            relations: true,
                            privacyProjection: true,
                        },
                    },
                    projections: {
                        select: { fieldId: true, typedEncodedValue: true },
                    },
                },
            },
        },
    });
    const restrictions: Array<Readonly<{
        sourcePluginId: string;
        sourceCollectionId: string;
        relationId: string;
        indexId: string;
        targetCollectionId: string;
        targetRowId: string;
    }>> = [];
    const nullificationsBySourceRowId = new Map<string, Readonly<{
        sourceRow: typeof incoming[number]["sourceRow"];
        sourceContract: NormalizedPluginAccountCollectionContractV1;
        fields: Map<string, string>;
    }>>();
    for (const edge of incoming) {
        if (
            edge.targetPluginId !== input.resolved.contract.pluginId
            || edge.targetCollectionId === null
            || edge.targetRowId === null
            || edge.sourceRow.deletedAt !== null
            || edge.sourceRevision !== edge.sourceRow.revision
        ) {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
        let sourceContract: NormalizedPluginAccountCollectionContractV1;
        try {
            sourceContract = readMaterializedPluginCollectionContract(
                edge.sourceRow.contract as StoredCollectionContract,
            );
        } catch {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
        const relation = sourceContract.relations.find((candidate) => (
            candidate.kind === "collection"
            && candidate.id === edge.relationId
            && candidate.collectionId === edge.targetCollectionId
        ));
        if (
            !relation
            || relation.kind !== "collection"
            || edge.sourcePluginId !== sourceContract.pluginId
            || edge.sourceCollectionId !== sourceContract.collectionId
        ) {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
        if (relation.onDelete === "restrict") {
            const index = sourceContract.indexes.find((candidate) => (
                candidate.fields[0]?.field === relation.field
            ));
            if (!index) {
                throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
            }
            restrictions.push({
                sourcePluginId: edge.sourcePluginId,
                sourceCollectionId: edge.sourceCollectionId,
                relationId: edge.relationId,
                indexId: index.id,
                targetCollectionId: edge.targetCollectionId,
                targetRowId: edge.targetRowId,
            });
            continue;
        }
        const existing = nullificationsBySourceRowId.get(edge.sourceRow.id);
        if (existing) {
            const previousTarget = existing.fields.get(relation.field);
            if (previousTarget !== undefined && previousTarget !== edge.targetRowId) {
                throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
            }
            existing.fields.set(relation.field, edge.targetRowId);
            continue;
        }
        nullificationsBySourceRowId.set(edge.sourceRow.id, {
            sourceRow: edge.sourceRow,
            sourceContract,
            fields: new Map([[relation.field, edge.targetRowId]]),
        });
    }
    const firstRestriction = restrictions[0];
    if (firstRestriction) {
        throw new PluginCollectionMutationOperationError("collection_relation_restricted", {
            dependentCount: Math.min(restrictions.length, 200),
            continuation: {
                pluginId: firstRestriction.sourcePluginId,
                collectionId: firstRestriction.sourceCollectionId,
                relationId: firstRestriction.relationId,
                target: {
                    collectionId: firstRestriction.targetCollectionId,
                    rowId: firstRestriction.targetRowId,
                },
                query: {
                    indexId: firstRestriction.indexId,
                    prefix: [firstRestriction.targetRowId],
                    order: "asc",
                    limit: 200,
                },
            },
        });
    }
    // A known restriction is actionable even when the bounded incoming page
    // overflows. Only automatic nullification requires the complete edge set.
    if (incoming.length > 200) {
        throw new PluginCollectionMutationOperationError("collection_relation_unavailable");
    }

    const changes: Array<Readonly<{
        resolved: ResolvedWritableCollection;
        rowDbId: string;
        rowId: string;
        revision: number;
    }>> = [];
    // Pendings sharing one source contract share one prepared validator set.
    const sourceContractValidators = new Map<
        NormalizedPluginAccountCollectionContractV1,
        PluginCollectionContractValidators
    >();
    for (const pending of nullificationsBySourceRowId.values()) {
        let validators = sourceContractValidators.get(pending.sourceContract);
        if (!validators) {
            validators = createPluginCollectionContractValidators(pending.sourceContract);
            sourceContractValidators.set(pending.sourceContract, validators);
        }
        const projection = readStoredProjection({
            contract: pending.sourceContract,
            validators,
            rowId: pending.sourceRow.rowId,
            projections: pending.sourceRow.projections,
        });
        for (const [field, targetRowId] of pending.fields) {
            if (projection[field] !== targetRowId) {
                throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
            }
            projection[field] = null;
        }
        const resolved = await resolveDerivedCollectionInTx({
            tx: input.tx,
            accountId: input.accountId,
            encryptionMode: input.resolved.encryptionMode,
            contractId: pending.sourceRow.contract.id,
            contract: pending.sourceContract,
        });
        const revision = advancePluginCollectionRevision(pending.sourceRow.revision);
        await input.beforeRowChange({ resolved, rowId: pending.sourceRow.rowId });
        await input.tx.pluginCollectionRow.update({
            where: { id: pending.sourceRow.id },
            data: { revision },
        });
        const projectionRevisionUpdate = await input.tx.pluginCollectionProjection.updateMany({
            where: { rowDbId: pending.sourceRow.id },
            data: { rowRevision: revision },
        });
        if (projectionRevisionUpdate.count !== pending.sourceContract.serverReadable.length) {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
        const projectionUpdate = await input.tx.pluginCollectionProjection.updateMany({
            where: {
                rowDbId: pending.sourceRow.id,
                fieldId: { in: [...pending.fields.keys()] },
            },
            data: {
                typedEncodedValue: "null",
            },
        });
        if (projectionUpdate.count !== pending.fields.size) {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
        const indexEntries = await replaceIndexEntriesForRowTx({
            tx: input.tx,
            resolved,
            rowId: pending.sourceRow.rowId,
            revision,
            projection,
        });
        input.afterRowChange({ resolved, rowId: pending.sourceRow.rowId,
            contentEnvelope: pending.sourceRow.contentEnvelope, projection, indexEntries });
        await replaceRelationEdgesForRowTx({
            tx: input.tx,
            accountId: input.accountId,
            resolved,
            change: {
                rowDbId: pending.sourceRow.id,
                rowId: pending.sourceRow.rowId,
                revision,
                projection,
            },
        });
        changes.push({
            resolved,
            rowDbId: pending.sourceRow.id,
            rowId: pending.sourceRow.rowId,
            revision,
        });
    }
    return changes;
}

/**
 * Measures a mutation put exactly as quota enforcement will persist it.  This
 * is intentionally a thin conversion into the sole stored-row metric above,
 * so callers cannot drift to a payload-only or unsorted-projection estimate.
 */
export function measurePluginCollectionCandidateRowEncodedBytes(input: Readonly<{
    rowId: string;
    contentEnvelope: unknown;
    projection: PluginCollectionProjectionV1;
}>): number {
    const projections: Array<{ fieldId: string; typedEncodedValue: string }> = [];
    for (const [fieldId, value] of Object.entries(input.projection)) {
        const typedEncodedValue = JSON.stringify(value);
        if (typedEncodedValue === undefined) {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
        projections.push({ fieldId, typedEncodedValue });
    }
    return measureStoredRowEncodedBytes({
        rowId: input.rowId,
        contentEnvelope: input.contentEnvelope,
        projections,
    });
}

export async function updateIndexReadinessInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    resolved: ResolvedWritableCollection;
}>): Promise<void> {
    if (input.resolved.indexStates.length === 0) return;
    const latest = await input.tx.pluginCollectionRow.findFirst({
        where: {
            accountId: input.accountId,
            pluginId: input.resolved.contract.pluginId,
            collectionId: input.resolved.contract.collectionId,
            deletedAt: null,
        },
        // All matches have deletedAt = null. Naming that constant ordering
        // lets PostgreSQL use the nullable live-index prefix for revision too.
        orderBy: [{ deletedAt: 'desc' }, { revision: 'desc' }],
        select: { revision: true },
    });
    await input.tx.pluginCollectionIndexState.updateMany({
        where: { id: { in: input.resolved.indexStates.map((state) => state.id) } },
        data: { indexedThroughRevision: latest?.revision ?? 0 },
    });
}

type UpdatedPluginCollectionMutationResult = Extract<PluginCollectionMutationResultV1, { status: "updated" }>;
type PluginCollectionMutationInTxResult =
    | Exclude<PluginCollectionMutationResultV1, UpdatedPluginCollectionMutationResult>
    | (Omit<UpdatedPluginCollectionMutationResult, "changeCursor"> & TransactionResult<PluginCollectionMutationResultV1>);

async function mutatePluginCollectionAfterAdmissionInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    actorAccountId?: string;
    request: PluginCollectionMutationRequestV1;
    resolved: ResolvedWritableCollection;
    deployment: PluginDataCollectionsCapabilities;
    authentication: SessionAccessAuthentication | undefined;
    /**
     * Physical retirement deletes the row that would otherwise carry the
     * retired revision, so the requested collection cannot be invalidated at
     * row scope. This owner remains the single AccountChange publisher for the
     * whole transaction and only widens that one collection; relation-nullified
     * collections keep their exact hints.
     */
    physicallyRetiresRequestedRow?: boolean;
    resourcePromotionRowId?: string;
}>): Promise<PluginCollectionMutationInTxResult> {
    const resolved = input.resolved;
    const operations = input.request.operations;
    const rowIds = operations.map((operation) => operation.rowId);
    const existingRows = await input.tx.pluginCollectionRow.findMany({
        where: {
            accountId: input.accountId,
            pluginId: resolved.contract.pluginId,
            collectionId: resolved.contract.collectionId,
            rowId: { in: rowIds },
        },
        select: { id: true, rowId: true, revision: true, deletedAt: true, contentEnvelope: true },
    });
    const existingByRowId = new Map(existingRows.map((row) => [row.rowId, row]));
    const absenceEpoch = await input.tx.pluginCollectionAbsenceEpoch.findUnique({
        where: { accountId_pluginId_collectionId: {
            accountId: input.accountId,
            pluginId: resolved.contract.pluginId,
            collectionId: resolved.contract.collectionId,
        } },
        select: { epoch: true },
    });
    const currentAbsenceEpoch = absenceEpoch?.epoch ?? 0;
    const conflicts = operations
        .map((operation) => conflictFor({
            operation,
            existing: existingByRowId.get(operation.rowId),
            absenceEpoch: currentAbsenceEpoch,
        }))
        .filter((conflict): conflict is NonNullable<typeof conflict> => conflict !== null);
    if (conflicts.length > 0) {
        const result = { status: "conflict" as const, conflicts };
        PluginCollectionMutationResultV1Schema.parse(result);
        return result;
    }

    const quota = createPluginCollectionMutationQuotaInTx(input);
    try {
        await quota.captureBefore([{ pluginId: resolved.contract.pluginId, collectionId: resolved.contract.collectionId,
            rowIds: operations.filter(operation => operation.kind !== 'assert').map(operation => operation.rowId),
            indexStateIds: resolved.indexStates.map(state => state.id) }]);
    } catch (error) {
        rethrowPluginCollectionQuotaCensusError(error);
    }

    const results: Array<{ rowId: string; revision: number; deleted: boolean }> = [];
    // Capture both sides of membership before replacing index entries. Keys
    // already belong to the server-readable projection; private bodies never
    // enter the invalidation. Assertions do not publish changes.
    const changedRowIds = operations.filter(operation => operation.kind !== "assert").map(operation => operation.rowId);
    const previousIndexEntries = changedRowIds.length === 0 ? [] : await input.tx.pluginCollectionIndexEntry.findMany({
        where: { indexStateId: { in: resolved.indexStates.map(state => state.id) }, rowId: { in: changedRowIds } },
        select: { indexStateId: true, encodedSortKey: true },
    });
    const currentIndexEntries: PluginCollectionIndexEntryWrite[] = [];
    const relationChanges: RelationRowChange[] = [];
    // One resolved contract serves the whole batch: prepare its validators once
    // here, not per field per row inside the write transaction.
    const contractValidators = createPluginCollectionContractValidators(resolved.contract);
    for (const operation of operations) {
        if (operation.kind === "assert") continue;
        const existing = existingByRowId.get(operation.rowId);
        // Physical forget removes the row that normally carries revision
        // history. Seed a later absent create from the Collection absence
        // epoch so an old exact-revision forget can never match a recreated
        // row (the epoch is advanced beyond the forgotten revision below).
        const revision = advancePluginCollectionRevision(
            existing ? existing.revision : currentAbsenceEpoch,
        );
        if (operation.kind === "put") {
            const previousContent = existing?.contentEnvelope;
            const previousResource = previousContent !== null && typeof previousContent === 'object'
                && !Array.isArray(previousContent) && 'k' in previousContent && previousContent.k === 'collection';
            const nextResource = operation.content.t === 'encrypted' && operation.content.k === 'collection';
            if (previousResource !== nextResource && !(nextResource && input.resourcePromotionRowId === operation.rowId)) {
                throw new PluginCollectionMutationOperationError('collection_content_mode_mismatch');
            }
            const projection = validatePutContent({
                contract: resolved.contract,
                validators: contractValidators,
                encryptionMode: resolved.encryptionMode,
                operation,
            });
            const row = existing
                ? await input.tx.pluginCollectionRow.update({
                    where: { id: existing.id },
                    data: {
                        schemaVersion: resolved.contract.schemaVersion,
                        revision,
                        contractId: resolved.contractId,
                        contractDigest: resolved.contract.contractDigest,
                        contentEnvelope: toPrismaJson(operation.content),
                        deletedAt: null,
                    },
                    select: { id: true },
                })
                : await input.tx.pluginCollectionRow.create({
                    data: {
                        accountId: input.accountId,
                        pluginId: resolved.contract.pluginId,
                        collectionId: resolved.contract.collectionId,
                        rowId: operation.rowId,
                        schemaVersion: resolved.contract.schemaVersion,
                        revision,
                        contractId: resolved.contractId,
                        contractDigest: resolved.contract.contractDigest,
                        contentEnvelope: toPrismaJson(operation.content),
                    },
                    select: { id: true },
                });
            await input.tx.pluginCollectionProjection.deleteMany({ where: { rowDbId: row.id } });
            await input.tx.pluginCollectionProjection.createMany({
                data: resolved.contract.serverReadable.map((field) => ({
                    rowDbId: row.id,
                    accountId: input.accountId,
                    pluginId: resolved.contract.pluginId,
                    collectionId: resolved.contract.collectionId,
                    rowId: operation.rowId,
                    fieldId: field,
                    typedEncodedValue: JSON.stringify(projection[field]),
                    rowRevision: revision,
                })),
            });
            const indexEntries = await replaceIndexEntriesForRowTx({
                tx: input.tx,
                resolved,
                rowId: operation.rowId,
                revision,
                projection,
            });
            currentIndexEntries.push(...indexEntries);
            quota.recordAfter({ resolved, rowId: operation.rowId, contentEnvelope: operation.content, projection, indexEntries });
            relationChanges.push({
                rowDbId: row.id,
                rowId: operation.rowId,
                revision,
                projection,
            });
            results.push({ rowId: operation.rowId, revision, deleted: false });
            continue;
        }

        if (!existing) {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
        await input.tx.pluginCollectionRow.update({
            where: { id: existing.id },
            // Tombstones retain their identity/currentness history but never
            // retain the private envelope. Account-transition census treats
            // JSON null as content-free tombstone state.
            data: {
                revision,
                deletedAt: new Date(),
                contentEnvelope: getActivePrismaRuntime().JsonNull,
            },
        });
        await input.tx.pluginCollectionProjection.deleteMany({ where: { rowDbId: existing.id } });
        await replaceIndexEntriesForRowTx({
            tx: input.tx,
            resolved,
            rowId: operation.rowId,
            revision,
            projection: null,
        });
        quota.recordAfter({ resolved, rowId: operation.rowId, contentEnvelope: null, projection: null, indexEntries: [] });
        relationChanges.push({
            rowDbId: existing.id,
            rowId: operation.rowId,
            revision,
            projection: null,
        });
        results.push({ rowId: operation.rowId, revision, deleted: true });
    }

    await endCollectionSharingInTx(input.tx, relationChanges.filter(change => change.projection === null).map(change => change.rowDbId));
    if (relationChanges.length > 0) {
        await replaceRelationEdgesForRowsTx({
            tx: input.tx,
            accountId: input.accountId,
            actorAccountId: input.actorAccountId,
            resolved,
            changes: relationChanges,
            maximumBatchRows: input.deployment.maxBatchRows,
            authentication: input.authentication,
        });
    }
    const nullifiedChanges = await applyIncomingRelationDeletesTx({
        tx: input.tx,
        accountId: input.accountId,
        resolved,
        beforeRowChange: ({ resolved: source, rowId }) => quota.captureBefore([{
            pluginId: source.contract.pluginId, collectionId: source.contract.collectionId, rowIds: [rowId],
            indexStateIds: source.indexStates.map(state => state.id),
        }]),
        afterRowChange: quota.recordAfter,
        targetRowIds: relationChanges
            .filter((change) => change.projection === null)
            .map((change) => change.rowId),
    });
    await retirePluginCollectionCandidatePreparationStagesTx({
        tx: input.tx,
        accountId: input.accountId,
        sourceRowDbIds: [
            ...relationChanges.map((change) => change.rowDbId),
            ...nullifiedChanges.map((change) => change.rowDbId),
        ],
    });
    const changesByCollection = new Map<string, {
        resolved: ResolvedWritableCollection;
        rows: Map<string, number>;
    }>();
    const recordCollectionChange = (change: Readonly<{
        resolved: ResolvedWritableCollection;
        rowId: string;
        revision: number;
    }>): void => {
        const key = `${change.resolved.contract.pluginId}\u0000${change.resolved.contract.collectionId}`;
        const existing = changesByCollection.get(key);
        if (existing) {
            existing.rows.set(change.rowId, change.revision);
            return;
        }
        changesByCollection.set(key, {
            resolved: change.resolved,
            rows: new Map([[change.rowId, change.revision]]),
        });
    };
    for (const result of results) {
        recordCollectionChange({
            resolved,
            rowId: result.rowId,
            revision: result.revision,
        });
    }
    for (const change of nullifiedChanges) recordCollectionChange(change);

    let quotaIncompatibility: PluginCollectionQuotaIncompatibility | null;
    try {
        quotaIncompatibility = await quota.check({
            resolved: [resolved, ...[...changesByCollection.values()].map(change => change.resolved)],
            changedRows: [...changesByCollection.values()].map(change => ({
                pluginId: change.resolved.contract.pluginId, collectionId: change.resolved.contract.collectionId,
                rowIds: [...change.rows.keys()],
            })),
        });
    } catch (error) {
        rethrowPluginCollectionQuotaCensusError(error);
    }
    if (quotaIncompatibility) {
        throw new PluginCollectionMutationOperationError(
            "collection_quota_incompatible",
            quotaIncompatibility,
        );
    }

    for (const collection of changesByCollection.values()) {
        await updateIndexReadinessInTx({
            tx: input.tx,
            accountId: input.accountId,
            resolved: collection.resolved,
        });
    }
    let publication: AccountChangePublication | undefined;
    const orderedChanges = [...changesByCollection.values()].sort((left, right) => (
        left.resolved.contract.pluginId.localeCompare(right.resolved.contract.pluginId)
        || left.resolved.contract.collectionId.localeCompare(right.resolved.contract.collectionId)
    ));
    const indexIdByStateId = new Map(resolved.indexStates.map(state => [state.id, state.indexId]));
    const indexKeys = [
        ...previousIndexEntries.map(entry => ({ indexId: indexIdByStateId.get(entry.indexStateId)!, key: Buffer.from(entry.encodedSortKey).toString('hex') })),
        ...currentIndexEntries.map(entry => ({ indexId: indexIdByStateId.get(entry.indexStateId)!, key: Buffer.from(entry.encodedSortKey).toString('hex') })),
    ];
    for (const collection of orderedChanges) {
        const rows = [...collection.rows.entries()];
        const retiredCollection = input.physicallyRetiresRequestedRow === true
            && collection.resolved.contract.pluginId === resolved.contract.pluginId
            && collection.resolved.contract.collectionId === resolved.contract.collectionId;
        const hint = rows.length <= 200 && !retiredCollection
            ? {
                pluginDomain: "dataCollection" as const,
                pluginId: collection.resolved.contract.pluginId,
                collectionId: collection.resolved.contract.collectionId,
                contractDigest: collection.resolved.contract.contractDigest,
                revision: Math.max(...rows.map(([, revision]) => revision)),
                rowIds: rows.map(([rowId]) => rowId),
                // Relation nullification can change additional rows; retain the
                // existing broad invalidation unless both sides are known.
                ...(nullifiedChanges.length === 0 && collection.resolved === resolved ? {
                    indexChanges: { previousCursor: 0, keys: indexKeys },
                } : {}),
            }
            : {
                pluginDomain: "dataCollection" as const,
                pluginId: collection.resolved.contract.pluginId,
                collectionId: collection.resolved.contract.collectionId,
                contractDigest: collection.resolved.contract.contractDigest,
                revision: Math.max(...rows.map(([, revision]) => revision)),
                full: true as const,
            };
        publication = await markAccountChanged(input.tx, {
            accountId: input.accountId,
            kind: "pluginDomain",
            entityId: buildPluginDomainAccountChangeEntityId(hint),
            hint,
        });
        await publishCollectionSharingRowsChangedInTx(input.tx, { accountId: input.accountId,
            pluginId: collection.resolved.contract.pluginId, collectionId: collection.resolved.contract.collectionId,
            rowIds: rows.map(([rowId]) => rowId) });
    }
    const result = { status: "updated" as const, results };
    return Object.assign(transactionResult(() => PluginCollectionMutationResultV1Schema.parse({
        ...result,
        changeCursor: publication?.resolveCursor() ?? 0,
    })), result);
}

export async function mutatePluginCollectionInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    /** Omitted by owner-only writers; sharing supplies the admitted actor. */
    actorAccountId?: string;
    request: PluginCollectionMutationRequestV1;
    deployment: PluginDataCollectionsCapabilities;
    authentication: SessionAccessAuthentication | undefined;
    physicallyRetiresRequestedRow?: boolean;
    resourcePromotionRowId?: string;
}>): Promise<PluginCollectionMutationInTxResult> {
    const batchIncompatibility = findPluginCollectionBatchQuotaIncompatibility({
        deployment: input.deployment,
        operationCount: input.request.operations.length,
        encodedBytes: measurePluginCollectionMutationRequestEncodedBytesV1(input.request),
    });
    if (batchIncompatibility) {
        throw new PluginCollectionMutationOperationError("collection_quota_incompatible", batchIncompatibility);
    }
    // Collection mutations share the Account-first transition fence with every
    // mode-bound writer. The returned currentness is the sole encryption-mode
    // authority for this transaction; do not re-read Account through a second
    // local mode path after the fence.
    const deletedRowIds = input.request.operations.filter(operation => operation.kind === 'delete').map(operation => operation.rowId);
    const audience = await readCollectionSharingAudienceInTx(input.tx, { accountId: input.accountId, OR: [
        { pluginId: input.request.pluginId, collectionId: input.request.collectionId,
            rowId: { in: input.request.operations.filter(operation => operation.kind !== 'assert').map(operation => operation.rowId) } },
        ...(deletedRowIds.length ? [{ sourceRelations: { some: { targetKind: 'collection',
            targetPluginId: input.request.pluginId, targetCollectionId: input.request.collectionId,
            targetRowId: { in: deletedRowIds }, deletedAt: null } } }] : []),
    ] });
    await acquireAccountChangePublicationLocksInTx(input.tx, [input.accountId, ...audience], { intent: 'serializing' });
    const fence = await acquireAccountEncryptionTransitionFenceInTx(input.tx, input.accountId, "serializing");
    if (fence.status === "account_not_found") {
        throw new PluginCollectionMutationOperationError("collection_unavailable");
    }
    if (fence.status === "account_inconsistent") {
        throw new PluginCollectionMutationOperationError("collection_content_mode_mismatch");
    }
    const resolved = await resolveWritableCollectionInTx({
        tx: input.tx,
        accountId: input.accountId,
        encryptionMode: fence.account.currentness.encryptionMode,
        request: input.request,
    });
    return await mutatePluginCollectionAfterAdmissionInTx({ ...input, resolved });
}

/**
 * The only live collection writer. Account intent owns current writable
 * contract selection; this owner consumes it in the same transaction as CAS,
 * projections, index entries, quota, and the level-triggered AccountChange.
 */
export async function mutatePluginCollection(input: Readonly<{
    accountId: string;
    request: unknown;
    authentication: SessionAccessAuthentication;
}>): Promise<PluginCollectionMutationResultV1> {
    const request = PluginCollectionMutationRequestV1Schema.parse(input.request);
    const deployment = readPluginsFeatureEnv(process.env).collectionLimits;
    return await inTx(async (tx) => await mutatePluginCollectionInTx({
        tx,
        accountId: input.accountId,
        request,
        deployment,
        authentication: input.authentication,
    }));
}

/**
 * Host-private, exact-CAS physical reclamation. Ordinary logical delete
 * remains the public Collection mutation; this path is for a retention owner
 * that has already proven an exact live row or tombstone unreachable.
 * Advancing the one Collection absence epoch and deleting that row share this
 * transaction, so a crash cannot strand an undiscoverable tombstone between
 * two retention operations.
 */
export async function forgetPluginCollection(input: Readonly<{
    accountId: string;
    request: unknown;
}>): Promise<PluginCollectionForgetResultV1> {
    const request = PluginCollectionForgetRequestV1Schema.parse(input.request);
    return await inTx(async (tx) => {
        const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId, "serializing");
        if (fence.status === "account_not_found") {
            throw new PluginCollectionMutationOperationError("collection_unavailable");
        }
        if (fence.status === "account_inconsistent") {
            throw new PluginCollectionMutationOperationError("collection_content_mode_mismatch");
        }
        const resolved = await resolveWritableCollectionInTx({
            tx,
            accountId: input.accountId,
            encryptionMode: fence.account.currentness.encryptionMode,
            request,
        });
        const row = await tx.pluginCollectionRow.findFirst({
            where: {
                accountId: input.accountId,
                pluginId: resolved.contract.pluginId,
                collectionId: resolved.contract.collectionId,
                rowId: request.rowId,
            },
            select: { id: true, revision: true, deletedAt: true },
        });
        // A missing row is the response-loss/idempotent replay result. A newer
        // live or recreated identity is an exact-CAS conflict and remains
        // untouched.
        if (!row) {
            return PluginCollectionForgetResultV1Schema.parse({ status: "forgotten" });
        }
        if (row.revision !== request.expectedRevision) {
            return PluginCollectionForgetResultV1Schema.parse({ status: "conflict" });
        }
        const retiredRevision = row.deletedAt === null
            ? advancePluginCollectionRevision(row.revision)
            : row.revision;
        // The Account-first fence above serializes every Account-scoped
        // Collection writer, so reading the one absence epoch and advancing it
        // past this retired revision is atomic here. Absence currentness stays
        // a server fact: only the exact row revision witnesses this operation.
        const epochKey = {
            accountId: input.accountId,
            pluginId: resolved.contract.pluginId,
            collectionId: resolved.contract.collectionId,
        };
        const epoch = await tx.pluginCollectionAbsenceEpoch.findUnique({
            where: { accountId_pluginId_collectionId: epochKey },
            select: { epoch: true },
        });
        const nextEpoch = advancePluginCollectionRevision(
            Math.max(epoch?.epoch ?? 0, retiredRevision),
        );
        await tx.pluginCollectionAbsenceEpoch.upsert({
            where: { accountId_pluginId_collectionId: epochKey },
            create: { ...epochKey, epoch: nextEpoch },
            update: { epoch: nextEpoch },
            select: { id: true },
        });
        if (row.deletedAt === null) {
            // The canonical mutation transaction owns this retirement's whole
            // publication: the logical delete, every relation nullification it
            // cascades, and the retired collection's full-scope invalidation.
            const deleted = await mutatePluginCollectionAfterAdmissionInTx({
                tx,
                accountId: input.accountId,
                resolved,
                deployment: readPluginsFeatureEnv(process.env).collectionLimits,
                physicallyRetiresRequestedRow: true,
                authentication: undefined,
                request: {
                    pluginId: request.pluginId,
                    collectionId: request.collectionId,
                    writerContext: request.writerContext,
                    operations: [{
                        kind: "delete",
                        rowId: request.rowId,
                        expectedRevision: request.expectedRevision,
                    }],
                },
            });
            if (deleted.status !== "updated" || deleted.results.length !== 1) {
                throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
            }
            if (deleted.results[0]!.revision !== retiredRevision) {
                throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
            }
        } else {
            // Retiring an existing tombstone performs no logical mutation, so
            // this transaction publishes the one invalidation the advanced
            // absence epoch owes its readers.
            const hint = {
                pluginDomain: "dataCollection",
                pluginId: resolved.contract.pluginId,
                collectionId: resolved.contract.collectionId,
                contractDigest: resolved.contract.contractDigest,
                revision: retiredRevision,
                full: true,
            } as const;
            await markAccountChanged(tx, {
                accountId: input.accountId,
                kind: "pluginDomain",
                entityId: buildPluginDomainAccountChangeEntityId(hint),
                hint,
            });
        }
        await tx.pluginCollectionRow.delete({ where: { id: row.id } });
        return PluginCollectionForgetResultV1Schema.parse({ status: "forgotten" });
    });
}
