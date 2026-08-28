import type { Prisma } from "@prisma/client";
import {
    PluginAccountPluginIntentV1Schema,
    PluginCollectionContentEnvelopeV1Schema,
    PluginCollectionMutationErrorV1Schema,
    PluginCollectionMutationRequestV1Schema,
    PluginCollectionMutationResultV1Schema,
    PluginCollectionProjectionV1Schema,
    assertPluginCollectionContentEnvelopeForModeV1,
    buildPluginDomainAccountChangeEntityId,
    compilePluginJsonSchema,
    encodePluginCollectionIndexSortKeyV1,
    getPluginCollectionScalarKindV1,
    isCanonicalPluginCollectionIndexedInstantV1,
    measurePluginCollectionMutationRequestEncodedBytesV1,
    isValidPluginJsonSchemaValue,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginCollectionMutationErrorCodeV1,
    type PluginCollectionMutationErrorV1,
    type PluginCollectionMutationOperationV1,
    type PluginCollectionMutationRequestV1,
    type PluginCollectionMutationResultV1,
    type PluginCollectionProjectionV1,
    type PluginCollectionRelationV1,
    type PluginDataCollectionsCapabilities,
    type PluginCollectionRelationRestrictionContinuationV1,
} from "@happier-dev/protocol";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isPrismaErrorCode } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";

import {
    PluginCollectionContractMaterializationError,
    readMaterializedPluginCollectionContract,
} from "./contracts";
import { retirePluginCollectionCandidatePreparationStagesTx } from "./candidatePreparationLifecycle";
import { pluginCollectionHostReferenceResolver } from "./hostReferenceResolver";
import type { PluginCollectionHostReferenceKind } from "./hostReferences";
import {
    findPluginCollectionBatchQuotaIncompatibility,
    findPluginCollectionMutationQuotaIncompatibility,
    measurePluginCollectionStoredRowEncodedBytes as measureStoredRowEncodedBytes,
    readPluginCollectionAccountUsageInTx,
    readPluginCollectionPrefixQuotaUsageInTx,
    PluginCollectionQuotaCensusInconsistencyError,
    type PluginCollectionPrefixQuotaPolicy,
    type PluginCollectionPrefixQuotaUsage,
    type PluginCollectionQuotaIncompatibility,
    type PluginCollectionQuotaPolicy,
} from "./quota";

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

function quotaPolicyIdentity(input: Readonly<{
    pluginId: string;
    collectionId: string;
    contractDigest: string;
}>): string {
    return `${input.pluginId}\u0000${input.collectionId}\u0000${input.contractDigest}`;
}

function collectPluginCollectionQuotaPolicies(input: Readonly<{
    usages: readonly Awaited<ReturnType<typeof readPluginCollectionAccountUsageInTx>>[];
    resolved: readonly ResolvedWritableCollection[];
}>): Readonly<{
    collections: readonly PluginCollectionQuotaPolicy[];
    prefixes: readonly PluginCollectionPrefixQuotaPolicy[];
}> {
    const contracts = new Map<string, Readonly<{
        id: string;
        contract: NormalizedPluginAccountCollectionContractV1;
    }>>();
    const add = (candidate: Readonly<{
        id: string;
        contract: NormalizedPluginAccountCollectionContractV1;
    }>): void => {
        const identity = quotaPolicyIdentity(candidate.contract);
        const existing = contracts.get(identity);
        if (existing && existing.id !== candidate.id) {
            throw new PluginCollectionQuotaCensusInconsistencyError(
                "Collection quota policy has two immutable contract records for one digest.",
            );
        }
        contracts.set(identity, candidate);
    };
    for (const usage of input.usages) {
        for (const persisted of usage.contracts.values()) {
            add({
                id: persisted.id,
                contract: readMaterializedPluginCollectionContract(persisted as StoredCollectionContract),
            });
        }
    }
    for (const current of input.resolved) {
        add({ id: current.contractId, contract: current.contract });
    }
    const materialized = [...contracts.values()].sort((left, right) => (
        left.contract.pluginId.localeCompare(right.contract.pluginId)
        || left.contract.collectionId.localeCompare(right.contract.collectionId)
        || left.contract.contractDigest.localeCompare(right.contract.contractDigest)
    ));
    return {
        collections: materialized.map(({ contract }) => ({
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            quota: contract.quota,
        })),
        prefixes: materialized.map(({ id, contract }) => ({
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            contractId: id,
            contractDigest: contract.contractDigest,
            quota: contract.quota,
            schema: contract.schema,
            indexes: contract.indexes,
        })),
    };
}

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

function validateProjection(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
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
        let validate: ReturnType<typeof compilePluginJsonSchema>;
        try {
            validate = compilePluginJsonSchema(fieldSchemaForContract({ contract: input.contract, field }));
        } catch {
            throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
        }
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
    let validate: ReturnType<typeof compilePluginJsonSchema>;
    try {
        validate = compilePluginJsonSchema(input.contract.schema);
    } catch {
        throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
    }
    if (!isValidPluginJsonSchemaValue(validate, logical)) {
        throw new PluginCollectionMutationOperationError("collection_mutation_invalid");
    }
}

function validateCollectionContentAndProjection(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
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
        rowId: input.rowId,
        projection: input.projection,
    });
    if (input.encryptionMode === "plain") {
        validatePlainLogicalRow({
            contract: input.contract,
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
    encryptionMode: "plain" | "e2ee";
    operation: Extract<PluginCollectionMutationOperationV1, { kind: "put" }>;
}>): PluginCollectionProjectionV1 {
    return validateCollectionContentAndProjection({
        contract: input.contract,
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
    request: PluginCollectionMutationRequestV1;
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
    if (!parsedIntent.success || !parsedIntent.data.enabled || parsedIntent.data.desiredVersion === null) {
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
            data: { buildState: "building", indexedThroughRevision: null },
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
}>): Readonly<{ rowId: string; revision: number | null; deleted: boolean }> | null {
    const existing = input.existing;
    if (input.operation.expectedRevision === "absent") {
        if (!existing) return null;
        return {
            rowId: input.operation.rowId,
            revision: existing.revision,
            deleted: existing.deletedAt !== null,
        };
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
}>): Promise<void> {
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
}>): Promise<void> {
    const hostEdges = input.edges.filter((edge) => edge.relation.kind === "host");
    for (const batch of boundedChunks(hostEdges, input.maximumBatchRows)) {
        await Promise.all(batch.map(async (edge) => {
            if (edge.relation.kind !== "host") return;
            const resolution = await pluginCollectionHostReferenceResolver.resolveInTx({
                tx: input.tx,
                accountId: input.accountId,
                hostKind: edge.relation.hostKind,
                targetId: edge.targetRowId,
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
 * promotion consumes this before its first derived-state write, while the
 * ordinary row writer immediately materializes the same plan below.
 */
export async function preparePluginCollectionRelationReplacementInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
    changes: readonly RelationRowChange[];
    maximumBatchRows: number;
}>): Promise<PluginCollectionPreparedRelationReplacement> {
    const sourceRowDbIds = input.changes.map((change) => change.rowDbId);
    if (new Set(sourceRowDbIds).size !== sourceRowDbIds.length) {
        throw new PluginCollectionMutationOperationError("collection_contract_inconsistent");
    }
    const edges = deriveRelationEdges({ contract: input.contract, changes: input.changes });
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
    });
    assertCandidateRelationUniqueness({ edges });
    await assertNoPersistedRelationUniquenessCollisionInTx({
        tx: input.tx,
        accountId: input.accountId,
        contract: input.contract,
        sourceRowDbIds,
        edges,
        maximumBatchRows: input.maximumBatchRows,
    });
    return { sourceRowDbIds, edges };
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
    resolved: ResolvedWritableCollection;
    changes: readonly RelationRowChange[];
    maximumBatchRows: number;
}>): Promise<void> {
    const prepared = await preparePluginCollectionRelationReplacementInTx({
        tx: input.tx,
        accountId: input.accountId,
        contract: input.resolved.contract,
        changes: input.changes,
        maximumBatchRows: input.maximumBatchRows,
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
    });
}

function readStoredProjection(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
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
    const projection = readStoredProjection({
        contract: input.contract,
        rowId: input.rowId,
        projections: input.projections,
    });
    return validateCollectionContentAndProjection({
        contract: input.contract,
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
    if (incoming.length > 200) {
        throw new PluginCollectionMutationOperationError("collection_relation_unavailable");
    }

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
            dependentCount: restrictions.length,
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

    const changes: Array<Readonly<{
        resolved: ResolvedWritableCollection;
        rowDbId: string;
        rowId: string;
        revision: number;
    }>> = [];
    for (const pending of nullificationsBySourceRowId.values()) {
        const projection = readStoredProjection({
            contract: pending.sourceContract,
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
        const revision = pending.sourceRow.revision + 1;
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
        await replaceIndexEntriesForRowTx({
            tx: input.tx,
            resolved,
            rowId: pending.sourceRow.rowId,
            revision,
            projection,
        });
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
    const revision = await input.tx.pluginCollectionRow.aggregate({
        where: {
            accountId: input.accountId,
            pluginId: input.resolved.contract.pluginId,
            collectionId: input.resolved.contract.collectionId,
            deletedAt: null,
        },
        _max: { revision: true },
    });
    await input.tx.pluginCollectionIndexState.updateMany({
        where: { id: { in: input.resolved.indexStates.map((state) => state.id) } },
        data: { indexedThroughRevision: revision._max.revision ?? 0 },
    });
}

async function mutatePluginCollectionInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    request: PluginCollectionMutationRequestV1;
    deployment: PluginDataCollectionsCapabilities;
}>): Promise<PluginCollectionMutationResultV1> {
    // Collection mutations share the Account-first transition fence with every
    // mode-bound writer. The returned currentness is the sole encryption-mode
    // authority for this transaction; do not re-read Account through a second
    // local mode path after the fence.
    const fence = await acquireAccountEncryptionTransitionFenceInTx(
        input.tx,
        input.accountId,
    );
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
    const operations = input.request.operations;
    const rowIds = operations.map((operation) => operation.rowId);
    const existingRows = await input.tx.pluginCollectionRow.findMany({
        where: {
            accountId: input.accountId,
            pluginId: resolved.contract.pluginId,
            collectionId: resolved.contract.collectionId,
            rowId: { in: rowIds },
        },
        select: { id: true, rowId: true, revision: true, deletedAt: true },
    });
    const existingByRowId = new Map(existingRows.map((row) => [row.rowId, row]));
    const conflicts = operations
        .map((operation) => conflictFor({ operation, existing: existingByRowId.get(operation.rowId) }))
        .filter((conflict): conflict is NonNullable<typeof conflict> => conflict !== null);
    if (conflicts.length > 0) {
        return PluginCollectionMutationResultV1Schema.parse({ status: "conflict", conflicts });
    }

    let beforeQuotaUsage: Awaited<ReturnType<typeof readPluginCollectionAccountUsageInTx>>;
    let beforeQuotaPolicies: ReturnType<typeof collectPluginCollectionQuotaPolicies>;
    let beforePrefixUsage: PluginCollectionPrefixQuotaUsage;
    try {
        beforeQuotaUsage = await readPluginCollectionAccountUsageInTx({
            tx: input.tx,
            accountId: input.accountId,
            deployment: input.deployment,
        });
        beforeQuotaPolicies = collectPluginCollectionQuotaPolicies({
            usages: [beforeQuotaUsage],
            resolved: [resolved],
        });
        beforePrefixUsage = await readPluginCollectionPrefixQuotaUsageInTx({
            tx: input.tx,
            accountId: input.accountId,
            usage: beforeQuotaUsage,
            policies: beforeQuotaPolicies.prefixes,
        });
    } catch (error) {
        rethrowPluginCollectionQuotaCensusError(error);
    }

    const results: Array<{ rowId: string; revision: number; deleted: boolean }> = [];
    const relationChanges: RelationRowChange[] = [];
    for (const operation of operations) {
        if (operation.kind === "assert") continue;
        const existing = existingByRowId.get(operation.rowId);
        const revision = (existing?.revision ?? 0) + 1;
        if (operation.kind === "put") {
            const projection = validatePutContent({
                contract: resolved.contract,
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
            await replaceIndexEntriesForRowTx({
                tx: input.tx,
                resolved,
                rowId: operation.rowId,
                revision,
                projection,
            });
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
        relationChanges.push({
            rowDbId: existing.id,
            rowId: operation.rowId,
            revision,
            projection: null,
        });
        results.push({ rowId: operation.rowId, revision, deleted: true });
    }

    if (relationChanges.length > 0) {
        await replaceRelationEdgesForRowsTx({
            tx: input.tx,
            accountId: input.accountId,
            resolved,
            changes: relationChanges,
            maximumBatchRows: input.deployment.maxBatchRows,
        });
    }
    const nullifiedChanges = await applyIncomingRelationDeletesTx({
        tx: input.tx,
        accountId: input.accountId,
        resolved,
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

    let afterQuotaUsage: Awaited<ReturnType<typeof readPluginCollectionAccountUsageInTx>>;
    let afterQuotaPolicies: ReturnType<typeof collectPluginCollectionQuotaPolicies>;
    let afterPrefixUsage: PluginCollectionPrefixQuotaUsage;
    try {
        afterQuotaUsage = await readPluginCollectionAccountUsageInTx({
            tx: input.tx,
            accountId: input.accountId,
            deployment: input.deployment,
        });
        afterQuotaPolicies = collectPluginCollectionQuotaPolicies({
            usages: [beforeQuotaUsage, afterQuotaUsage],
            resolved: [resolved],
        });
        afterPrefixUsage = await readPluginCollectionPrefixQuotaUsageInTx({
            tx: input.tx,
            accountId: input.accountId,
            usage: afterQuotaUsage,
            policies: afterQuotaPolicies.prefixes,
        });
    } catch (error) {
        rethrowPluginCollectionQuotaCensusError(error);
    }
    const quotaIncompatibility = findPluginCollectionMutationQuotaIncompatibility({
        deployment: input.deployment,
        before: beforeQuotaUsage,
        after: afterQuotaUsage,
        collections: afterQuotaPolicies.collections,
        beforePrefixUsage,
        afterPrefixUsage,
    });
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
    let changeCursor = 0;
    const orderedChanges = [...changesByCollection.values()].sort((left, right) => (
        left.resolved.contract.pluginId.localeCompare(right.resolved.contract.pluginId)
        || left.resolved.contract.collectionId.localeCompare(right.resolved.contract.collectionId)
    ));
    for (const collection of orderedChanges) {
        const rows = [...collection.rows.entries()];
        const hint = rows.length <= 200
            ? {
                pluginDomain: "dataCollection" as const,
                pluginId: collection.resolved.contract.pluginId,
                collectionId: collection.resolved.contract.collectionId,
                contractDigest: collection.resolved.contract.contractDigest,
                revision: Math.max(...rows.map(([, revision]) => revision)),
                rowIds: rows.map(([rowId]) => rowId),
            }
            : {
                pluginDomain: "dataCollection" as const,
                pluginId: collection.resolved.contract.pluginId,
                collectionId: collection.resolved.contract.collectionId,
                contractDigest: collection.resolved.contract.contractDigest,
                revision: Math.max(...rows.map(([, revision]) => revision)),
                full: true as const,
            };
        changeCursor = await markAccountChanged(input.tx, {
            accountId: input.accountId,
            kind: "pluginDomain",
            entityId: buildPluginDomainAccountChangeEntityId(hint),
            hint,
        });
    }
    return PluginCollectionMutationResultV1Schema.parse({
        status: "updated",
        results,
        changeCursor,
    });
}

/**
 * The only live collection writer. Account intent owns current writable
 * contract selection; this owner consumes it in the same transaction as CAS,
 * projections, index entries, quota, and the level-triggered AccountChange.
 */
export async function mutatePluginCollection(input: Readonly<{
    accountId: string;
    request: unknown;
}>): Promise<PluginCollectionMutationResultV1> {
    const request = PluginCollectionMutationRequestV1Schema.parse(input.request);
    const deployment = readPluginsFeatureEnv(process.env).collectionLimits;
    const batchIncompatibility = findPluginCollectionBatchQuotaIncompatibility({
        deployment,
        operationCount: request.operations.length,
        encodedBytes: measurePluginCollectionMutationRequestEncodedBytesV1(request),
    });
    if (batchIncompatibility) {
        throw new PluginCollectionMutationOperationError(
            "collection_quota_incompatible",
            batchIncompatibility,
        );
    }
    return await inTx(async (tx) => await mutatePluginCollectionInTx({
        tx,
        accountId: input.accountId,
        request,
        deployment,
    }));
}
