import type { Prisma } from "@prisma/client";
import {
    PluginAccountPluginIntentV1Schema,
    PluginCollectionCandidatePreparationErrorV1Schema,
    PluginCollectionCandidatePreparationRetireRequestV1Schema,
    PluginCollectionCandidatePreparationRetireResultV1Schema,
    PluginCollectionCandidatePreparationSourcePageRequestV1Schema,
    PluginCollectionCandidatePreparationSourcePageResultV1Schema,
    PluginCollectionCandidatePreparationStageRequestV1Schema,
    PluginCollectionCandidatePreparationStageResultV1Schema,
    PluginCollectionContractRefV1Schema,
    PluginCollectionProjectionV1Schema,
    buildPluginDomainAccountChangeEntityId,
    computeCanonicalDomainSeparatedDigest,
    decodeBase64,
    encodeBase64,
    measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1,
    PluginUiArtifactDigestV1Schema,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginCollectionCandidatePreparationBindingV1,
    type PluginCollectionCandidatePreparationRetireResultV1,
    type PluginCollectionCandidatePreparationSourcePageResultV1,
    type PluginCollectionCandidatePreparationStageResultV1,
    type PluginCollectionContractRefV1,
    type PluginCollectionProjectionV1,
    type PluginCollectionQuotaDimensionV1,
} from "@happier-dev/protocol";
import { z } from "zod";

import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isPrismaErrorCode } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import {
    PluginCollectionContractMaterializationError,
    PluginCollectionWriterReadinessError,
    readMaterializedPluginCollectionContract,
} from "./contracts";
import {
    assertPluginCollectionStoredContentForAccountTransition,
    preparePluginCollectionDerivedStateForPromotionInTx,
    preparePluginCollectionRelationReplacementInTx,
    PluginCollectionMutationOperationError,
    type ResolvedWritableCollection,
} from "./mutation";
import {
    materializeCandidatePromotionSetwiseInTx,
    prepareCandidatePromotionMaterializedRows,
} from "./candidatePreparationPromotion";
import { retirePluginCollectionCandidatePreparationStagesTx } from "./candidatePreparationLifecycle";
import {
    extendPluginCollectionAccountUsageWithStoredRows,
    findPluginCollectionActivationQuotaIncompatibility,
    findPluginCollectionBatchQuotaIncompatibility,
    PluginCollectionQuotaCensusInconsistencyError,
    readPluginCollectionAccountUsageInTx,
    type PluginCollectionQuotaIncompatibility,
    type PluginCollectionQuotaPolicy,
} from "./quota";

const CANDIDATE_PREPARATION_BINDING_DOMAIN =
    "happier.plugin.collection-candidate-preparation.binding.v1";
const CANDIDATE_PREPARATION_CURSOR_DOMAIN =
    "happier.plugin.collection-candidate-preparation.source-page.cursor.v1";
const CANDIDATE_PREPARATION_CURSOR_VERSION = 1;
const CANDIDATE_PREPARATION_CURSOR_FINGERPRINT_BYTES = 32;
const CANDIDATE_PREPARATION_CURSOR_HEADER_BYTES =
    1 + CANDIDATE_PREPARATION_CURSOR_FINGERPRINT_BYTES + 2;
const CANDIDATE_PREPARATION_CURSOR_MAX_ROW_DB_ID_BYTES = 1_024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

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

type ResolvedCandidateContract = Readonly<{
    id: string;
    ref: PluginCollectionContractRefV1;
    contract: NormalizedPluginAccountCollectionContractV1;
}>;

type ResolvedCandidatePreparationBinding = Readonly<{
    encryptionMode: "plain" | "e2ee";
    source: ResolvedCandidateContract;
    target: ResolvedCandidateContract;
    candidateIdentity: string;
}>;

type CandidatePreparationStageQuotaRecord = Readonly<{
    id: string;
    accountId: string;
    pluginId: string;
    collectionId: string;
    rowId: string;
    candidateIdentity: string;
    sourceRowDbId: string;
    sourceContractId: string;
    sourceSchemaVersion: number;
    sourceContractDigest: string;
    sourceRevision: number;
    targetContractId: string;
    targetSchemaVersion: number;
    targetContractDigest: string;
    candidateReleaseVersion: string;
    candidateArtifactDigest: string;
    targetContentEnvelope: unknown;
    targetProjection: unknown;
    targetContract: StoredCollectionContract;
}>;

type CandidatePreparationProspectiveStage = Readonly<{
    index: number;
    sourceRowDbId: string;
    sourceRevision: number;
    rowId: string;
    target: ResolvedCandidateContract;
    content: unknown;
    projection: PluginCollectionProjectionV1;
    targetContentEnvelope: Prisma.InputJsonValue;
    targetProjection: Prisma.InputJsonValue;
}>;

type CandidatePreparationStageItemResult = PluginCollectionCandidatePreparationStageResultV1["results"][number];

type CandidatePreparationErrorCode =
    | "collection_candidate_preparation_invalid"
    | "collection_candidate_preparation_unavailable"
    | "collection_candidate_preparation_source_changed"
    | "collection_candidate_preparation_contract_mismatch"
    | "collection_candidate_preparation_content_mode_mismatch"
    | "collection_candidate_preparation_cursor_invalid"
    | "collection_quota_incompatible";

/** Candidate preparation owns only prospective target bytes; it never selects or activates a release. */
export class PluginCollectionCandidatePreparationOperationError extends Error {
    readonly dimension: PluginCollectionQuotaDimensionV1 | undefined;
    readonly effectiveMaximum: number | undefined;

    constructor(
        readonly code: CandidatePreparationErrorCode,
        quota?: PluginCollectionQuotaIncompatibility,
    ) {
        super(code);
        this.name = "PluginCollectionCandidatePreparationOperationError";
        this.dimension = quota?.dimension;
        this.effectiveMaximum = quota?.effectiveMaximum;
    }

    toWireError() {
        if (this.code === "collection_quota_incompatible") {
            if (this.dimension === undefined || this.effectiveMaximum === undefined) {
                throw new Error("Candidate preparation quota incompatibility is missing its effective limit.");
            }
            return PluginCollectionCandidatePreparationErrorV1Schema.parse({
                error: this.code,
                dimension: this.dimension,
                effectiveMaximum: this.effectiveMaximum,
            });
        }
        return PluginCollectionCandidatePreparationErrorV1Schema.parse({ error: this.code });
    }
}

function refsMatch(left: PluginCollectionContractRefV1, right: PluginCollectionContractRefV1): boolean {
    return left.pluginId === right.pluginId
        && left.collectionId === right.collectionId
        && left.schemaVersion === right.schemaVersion
        && left.contractDigest === right.contractDigest;
}

export function candidatePreparationBindingIdentity(input: Readonly<{
    accountId: string;
    binding: PluginCollectionCandidatePreparationBindingV1;
}>): string {
    const { binding } = input;
    return computeCanonicalDomainSeparatedDigest(CANDIDATE_PREPARATION_BINDING_DOMAIN, [
        input.accountId,
        binding.source.pluginId,
        binding.source.collectionId,
        String(binding.source.schemaVersion),
        binding.source.contractDigest,
        binding.target.pluginId,
        binding.target.collectionId,
        String(binding.target.schemaVersion),
        binding.target.contractDigest,
        binding.candidate.releaseVersion,
        binding.candidate.artifactDigest,
    ]);
}

function candidatePreparationCursorFingerprint(input: Readonly<{
    accountId: string;
    binding: PluginCollectionCandidatePreparationBindingV1;
}>): string {
    return computeCanonicalDomainSeparatedDigest(CANDIDATE_PREPARATION_CURSOR_DOMAIN, [
        candidatePreparationBindingIdentity(input),
    ]);
}

function encodeSourcePageCursor(input: Readonly<{
    fingerprint: string;
    lastRowDbId: string;
}>): string {
    const fingerprint = decodeBase64(input.fingerprint, "base64url");
    const rowDbId = textEncoder.encode(input.lastRowDbId);
    if (
        encodeBase64(fingerprint, "base64url") !== input.fingerprint
        || fingerprint.byteLength !== CANDIDATE_PREPARATION_CURSOR_FINGERPRINT_BYTES
        || rowDbId.byteLength === 0
        || rowDbId.byteLength > CANDIDATE_PREPARATION_CURSOR_MAX_ROW_DB_ID_BYTES
    ) {
        throw new Error("Candidate preparation cursor cannot encode an invalid row identity.");
    }
    const bytes = new Uint8Array(CANDIDATE_PREPARATION_CURSOR_HEADER_BYTES + rowDbId.byteLength);
    bytes[0] = CANDIDATE_PREPARATION_CURSOR_VERSION;
    bytes.set(fingerprint, 1);
    new DataView(bytes.buffer).setUint16(
        1 + CANDIDATE_PREPARATION_CURSOR_FINGERPRINT_BYTES,
        rowDbId.byteLength,
        false,
    );
    bytes.set(rowDbId, CANDIDATE_PREPARATION_CURSOR_HEADER_BYTES);
    return encodeBase64(bytes, "base64url");
}

function decodeSourcePageCursor(input: Readonly<{
    cursor: string;
    fingerprint: string;
}>): string {
    try {
        const bytes = decodeBase64(input.cursor, "base64url");
        if (encodeBase64(bytes, "base64url") !== input.cursor) {
            throw new Error("Cursor is not canonical base64url.");
        }
        if (bytes.byteLength < CANDIDATE_PREPARATION_CURSOR_HEADER_BYTES || bytes[0] !== CANDIDATE_PREPARATION_CURSOR_VERSION) {
            throw new Error("Cursor envelope is invalid.");
        }
        const rowDbIdLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
            1 + CANDIDATE_PREPARATION_CURSOR_FINGERPRINT_BYTES,
            false,
        );
        if (
            rowDbIdLength === 0
            || rowDbIdLength > CANDIDATE_PREPARATION_CURSOR_MAX_ROW_DB_ID_BYTES
            || bytes.byteLength !== CANDIDATE_PREPARATION_CURSOR_HEADER_BYTES + rowDbIdLength
        ) {
            throw new Error("Cursor row identity is invalid.");
        }
        const fingerprint = encodeBase64(
            bytes.slice(1, 1 + CANDIDATE_PREPARATION_CURSOR_FINGERPRINT_BYTES),
            "base64url",
        );
        if (fingerprint !== input.fingerprint) {
            throw new Error("Cursor belongs to another candidate binding.");
        }
        const rowDbIdBytes = bytes.slice(CANDIDATE_PREPARATION_CURSOR_HEADER_BYTES);
        const rowDbId = textDecoder.decode(rowDbIdBytes);
        if (
            rowDbId.length === 0
            || !rowDbIdBytes.every((value, index) => textEncoder.encode(rowDbId)[index] === value)
        ) {
            throw new Error("Cursor row identity is not canonical UTF-8.");
        }
        return rowDbId;
    } catch {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_cursor_invalid",
        );
    }
}

function parseReleaseContracts(value: unknown): readonly PluginCollectionContractRefV1[] {
    const parsed = z.array(PluginCollectionContractRefV1Schema).max(32).safeParse(value);
    if (!parsed.success) {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_contract_mismatch",
        );
    }
    return parsed.data;
}

async function readExactCandidateContractInTx(input: Readonly<{
    tx: Tx;
    ref: PluginCollectionContractRefV1;
}>): Promise<ResolvedCandidateContract> {
    const persisted = await input.tx.pluginCollectionContract.findFirst({
        where: {
            pluginId: input.ref.pluginId,
            collectionId: input.ref.collectionId,
            schemaVersion: input.ref.schemaVersion,
            contractDigest: input.ref.contractDigest,
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
    if (!persisted) {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_contract_mismatch",
        );
    }
    try {
        const contract = readMaterializedPluginCollectionContract(persisted as StoredCollectionContract);
        if (!refsMatch(contract, input.ref)) {
            throw new Error("Persisted contract did not reconstruct to the requested exact reference.");
        }
        return { id: persisted.id, ref: input.ref, contract };
    } catch {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_contract_mismatch",
        );
    }
}

function hasDeclaredMigrationChain(input: Readonly<{
    sourceSchemaVersion: number;
    target: NormalizedPluginAccountCollectionContractV1;
}>): boolean {
    if (input.sourceSchemaVersion >= input.target.schemaVersion) return false;
    if (!input.target.readableSchemaVersions.includes(input.sourceSchemaVersion)) return false;
    let current = input.sourceSchemaVersion;
    while (current < input.target.schemaVersion) {
        const next = input.target.migrations.find((migration) => migration.fromSchemaVersion === current);
        if (!next || next.toSchemaVersion <= current) return false;
        current = next.toSchemaVersion;
    }
    return current === input.target.schemaVersion;
}

/**
 * Candidate callers need a declared callback chain only when there is a live
 * incumbent row to transform. An empty collection can adopt a new target
 * contract directly, including one that intentionally does not read the old
 * schema version.
 */
function assertCandidatePreparationMigrationAvailable(input: Readonly<{
    source: ResolvedCandidateContract;
    target: ResolvedCandidateContract;
}>): void {
    if (refsMatch(input.source.ref, input.target.ref)) return;
    if (!hasDeclaredMigrationChain({
        sourceSchemaVersion: input.source.ref.schemaVersion,
        target: input.target.contract,
    })) {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_contract_mismatch",
        );
    }
}

/**
 * Resolves the prospective source/target binding at the authenticated Account
 * boundary. The current intent authorizes the incumbent source only; the
 * candidate release authorizes the target only. Neither grants activation.
 */
async function resolveCandidatePreparationBindingInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    binding: PluginCollectionCandidatePreparationBindingV1;
}>): Promise<ResolvedCandidatePreparationBinding> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(input.tx, input.accountId);
    if (fence.status === "account_not_found") {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_unavailable",
        );
    }
    if (fence.status === "account_inconsistent") {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_content_mode_mismatch",
        );
    }

    const intent = await input.tx.accountPluginIntent.findUnique({
        where: {
            accountId_pluginId: {
                accountId: input.accountId,
                pluginId: input.binding.source.pluginId,
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
    if (!intent) {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_unavailable",
        );
    }
    const currentIntent = PluginAccountPluginIntentV1Schema.safeParse({
        pluginId: intent.pluginId,
        desiredVersion: intent.desiredVersion,
        enabled: intent.enabled,
        offlineUiHosting: intent.offlineUiHosting,
        writableCollections: intent.writableCollections,
        revision: intent.revision.toString(),
    });
    if (
        !currentIntent.success
        || currentIntent.data.desiredVersion === null
        || !currentIntent.data.writableCollections.some((ref) => refsMatch(ref, input.binding.source))
    ) {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_unavailable",
        );
    }

    const [sourceRelease, targetRelease] = await Promise.all([
        input.tx.accountPluginRelease.findUnique({
            where: {
                accountId_pluginId_version: {
                    accountId: input.accountId,
                    pluginId: input.binding.source.pluginId,
                    version: currentIntent.data.desiredVersion,
                },
            },
            select: { pluginId: true, version: true, collectionContracts: true },
        }),
        input.tx.accountPluginRelease.findUnique({
            where: {
                accountId_pluginId_version: {
                    accountId: input.accountId,
                    pluginId: input.binding.target.pluginId,
                    version: input.binding.candidate.releaseVersion,
                },
            },
            select: { pluginId: true, version: true, collectionContracts: true },
        }),
    ]);
    if (
        !sourceRelease
        || sourceRelease.pluginId !== input.binding.source.pluginId
        || sourceRelease.version !== currentIntent.data.desiredVersion
        || !parseReleaseContracts(sourceRelease.collectionContracts).some((ref) => refsMatch(ref, input.binding.source))
    ) {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_contract_mismatch",
        );
    }
    if (
        !targetRelease
        || targetRelease.pluginId !== input.binding.target.pluginId
        || targetRelease.version !== input.binding.candidate.releaseVersion
        || !parseReleaseContracts(targetRelease.collectionContracts).some((ref) => refsMatch(ref, input.binding.target))
    ) {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_contract_mismatch",
        );
    }

    const [source, target] = await Promise.all([
        readExactCandidateContractInTx({ tx: input.tx, ref: input.binding.source }),
        readExactCandidateContractInTx({ tx: input.tx, ref: input.binding.target }),
    ]);
    return {
        encryptionMode: fence.account.currentness.encryptionMode,
        source,
        target,
        candidateIdentity: candidatePreparationBindingIdentity(input),
    };
}

function sourceProjectionEntries(input: PluginCollectionProjectionV1): readonly Readonly<{
    fieldId: string;
    typedEncodedValue: string;
}>[] {
    return Object.entries(input).map(([fieldId, value]) => {
        const typedEncodedValue = JSON.stringify(value);
        if (typedEncodedValue === undefined) {
            throw new PluginCollectionCandidatePreparationOperationError(
                "collection_candidate_preparation_invalid",
            );
        }
        return { fieldId, typedEncodedValue };
    });
}

function validateCandidateTarget(input: Readonly<{
    target: ResolvedCandidateContract;
    encryptionMode: "plain" | "e2ee";
    rowId: string;
    content: unknown;
    projection: PluginCollectionProjectionV1;
}>): Readonly<{
    content: unknown;
    projection: PluginCollectionProjectionV1;
}> {
    try {
        return assertPluginCollectionStoredContentForAccountTransition({
            contract: input.target.contract,
            encryptionMode: input.encryptionMode,
            rowId: input.rowId,
            contentEnvelope: input.content,
            projections: sourceProjectionEntries(input.projection),
        });
    } catch (error) {
        if (error instanceof PluginCollectionMutationOperationError) {
            if (error.code === "collection_content_mode_mismatch") {
                throw new PluginCollectionCandidatePreparationOperationError(
                    "collection_candidate_preparation_content_mode_mismatch",
                );
            }
            if (error.code === "collection_contract_inconsistent") {
                throw new PluginCollectionCandidatePreparationOperationError(
                    "collection_candidate_preparation_contract_mismatch",
                );
            }
        }
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_invalid",
        );
    }
}

function readValidatedSourceRow(input: Readonly<{
    source: ResolvedCandidateContract;
    encryptionMode: "plain" | "e2ee";
    row: Readonly<{
        rowId: string;
        contentEnvelope: unknown;
        projections: readonly Readonly<{ fieldId: string; typedEncodedValue: string }>[];
    }>;
}>): Readonly<{
    content: unknown;
    projection: PluginCollectionProjectionV1;
}> {
    try {
        return assertPluginCollectionStoredContentForAccountTransition({
            contract: input.source.contract,
            encryptionMode: input.encryptionMode,
            rowId: input.row.rowId,
            contentEnvelope: input.row.contentEnvelope,
            projections: input.row.projections,
        });
    } catch (error) {
        if (
            error instanceof PluginCollectionMutationOperationError
            && error.code === "collection_content_mode_mismatch"
        ) {
            throw new PluginCollectionCandidatePreparationOperationError(
                "collection_candidate_preparation_content_mode_mismatch",
            );
        }
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_contract_mismatch",
        );
    }
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_invalid",
        );
    }
    return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function exactStageWhere(input: Readonly<{
    accountId: string;
    resolved: ResolvedCandidatePreparationBinding;
    binding: PluginCollectionCandidatePreparationBindingV1;
    sourceRowDbId: string;
    sourceRevision: number;
}>): Prisma.PluginCollectionCandidatePreparationStageWhereInput {
    return {
        accountId: input.accountId,
        pluginId: input.resolved.source.ref.pluginId,
        collectionId: input.resolved.source.ref.collectionId,
        candidateIdentity: input.resolved.candidateIdentity,
        sourceRowDbId: input.sourceRowDbId,
        sourceContractId: input.resolved.source.id,
        sourceSchemaVersion: input.resolved.source.ref.schemaVersion,
        sourceContractDigest: input.resolved.source.ref.contractDigest,
        sourceRevision: input.sourceRevision,
        targetContractId: input.resolved.target.id,
        targetSchemaVersion: input.resolved.target.ref.schemaVersion,
        targetContractDigest: input.resolved.target.ref.contractDigest,
        candidateReleaseVersion: input.binding.candidate.releaseVersion,
        candidateArtifactDigest: input.binding.candidate.artifactDigest,
    };
}

function stageMatchesExactBinding(input: Readonly<{
    stage: CandidatePreparationStageQuotaRecord;
    accountId: string;
    resolved: ResolvedCandidatePreparationBinding;
    binding: PluginCollectionCandidatePreparationBindingV1;
    sourceRowDbId: string;
    sourceRevision: number;
}>): boolean {
    const { stage, resolved, binding } = input;
    return stage.accountId === input.accountId
        && stage.pluginId === resolved.source.ref.pluginId
        && stage.collectionId === resolved.source.ref.collectionId
        && stage.candidateIdentity === resolved.candidateIdentity
        && stage.sourceRowDbId === input.sourceRowDbId
        && stage.sourceContractId === resolved.source.id
        && stage.sourceSchemaVersion === resolved.source.ref.schemaVersion
        && stage.sourceContractDigest === resolved.source.ref.contractDigest
        && stage.sourceRevision === input.sourceRevision
        && stage.targetContractId === resolved.target.id
        && stage.targetSchemaVersion === resolved.target.ref.schemaVersion
        && stage.targetContractDigest === resolved.target.ref.contractDigest
        && stage.candidateReleaseVersion === binding.candidate.releaseVersion
        && stage.candidateArtifactDigest === binding.candidate.artifactDigest;
}

function stageProjectionEntries(value: unknown): readonly Readonly<{
    fieldId: string;
    typedEncodedValue: string;
}>[] {
    const projection = PluginCollectionProjectionV1Schema.parse(value);
    return sourceProjectionEntries(projection);
}

function quotaPolicyIdentity(contract: NormalizedPluginAccountCollectionContractV1): string {
    return `${contract.pluginId}\u0000${contract.collectionId}\u0000${contract.contractDigest}`;
}

function addCandidateQuotaPolicy(
    policies: Map<string, PluginCollectionQuotaPolicy>,
    contract: NormalizedPluginAccountCollectionContractV1,
): void {
    const policy: PluginCollectionQuotaPolicy = {
        pluginId: contract.pluginId,
        collectionId: contract.collectionId,
        quota: contract.quota,
    };
    const key = quotaPolicyIdentity(contract);
    const existing = policies.get(key);
    if (
        existing
        && JSON.stringify(existing.quota) !== JSON.stringify(policy.quota)
    ) {
        throw new PluginCollectionCandidatePreparationOperationError(
            "collection_candidate_preparation_contract_mismatch",
        );
    }
    policies.set(key, policy);
}

async function readCandidateStageQuotaSnapshotInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
}>): Promise<readonly CandidatePreparationStageQuotaRecord[]> {
    return await input.tx.pluginCollectionCandidatePreparationStage.findMany({
        where: { accountId: input.accountId },
        select: {
            id: true,
            accountId: true,
            pluginId: true,
            collectionId: true,
            rowId: true,
            candidateIdentity: true,
            sourceRowDbId: true,
            sourceContractId: true,
            sourceSchemaVersion: true,
            sourceContractDigest: true,
            sourceRevision: true,
            targetContractId: true,
            targetSchemaVersion: true,
            targetContractDigest: true,
            candidateReleaseVersion: true,
            candidateArtifactDigest: true,
            targetContentEnvelope: true,
            targetProjection: true,
            targetContract: {
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
        },
    });
}

async function assertCandidateStageBatchQuotaInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    deployment: ReturnType<typeof readPluginsFeatureEnv>["collectionLimits"];
    stages: readonly CandidatePreparationStageQuotaRecord[];
    prospective: readonly CandidatePreparationProspectiveStage[];
    candidateIdentity: string;
}>): Promise<void> {
    try {
        const usage = await readPluginCollectionAccountUsageInTx({
            tx: input.tx,
            accountId: input.accountId,
        });
        const policies = new Map<string, PluginCollectionQuotaPolicy>();
        for (const persisted of usage.contracts.values()) {
            addCandidateQuotaPolicy(policies, readMaterializedPluginCollectionContract(
                persisted as StoredCollectionContract,
            ));
        }
        const stageRows = input.stages.map((stage) => {
            const contract = readMaterializedPluginCollectionContract(
                stage.targetContract as StoredCollectionContract,
            );
            if (contract.pluginId !== stage.pluginId || contract.collectionId !== stage.collectionId) {
                throw new PluginCollectionCandidatePreparationOperationError(
                    "collection_candidate_preparation_contract_mismatch",
                );
            }
            addCandidateQuotaPolicy(policies, contract);
            return {
                storageKey: `\u0000candidate-stage:${stage.id}`,
                pluginId: stage.pluginId,
                collectionId: stage.collectionId,
                rowId: stage.rowId,
                contentEnvelope: stage.targetContentEnvelope,
                projections: stageProjectionEntries(stage.targetProjection),
            };
        });
        for (const prospective of input.prospective) {
            addCandidateQuotaPolicy(policies, prospective.target.contract);
        }
        const prospectiveUsage = extendPluginCollectionAccountUsageWithStoredRows({
            usage,
            rows: [
                ...stageRows,
                ...input.prospective.map((prospective) => ({
                    storageKey: `\u0000candidate-stage:prospective:${input.candidateIdentity}:${prospective.sourceRowDbId}:${prospective.target.id}`,
                    pluginId: prospective.target.ref.pluginId,
                    collectionId: prospective.target.ref.collectionId,
                    rowId: prospective.rowId,
                    contentEnvelope: prospective.content,
                    projections: sourceProjectionEntries(prospective.projection),
                })),
            ],
        });
        const incompatibility = findPluginCollectionActivationQuotaIncompatibility({
            deployment: input.deployment,
            usage: prospectiveUsage,
            collections: [...policies.values()],
            // Candidate preparation owns no derived index state. Final
            // promotion rebuilds those entries and performs the existing full
            // prefix-index re-census before Availability can publish.
            prefixUsage: [],
        });
        if (incompatibility) {
            throw new PluginCollectionCandidatePreparationOperationError(
                "collection_quota_incompatible",
                incompatibility,
            );
        }
    } catch (error) {
        if (error instanceof PluginCollectionCandidatePreparationOperationError) throw error;
        if (
            error instanceof PluginCollectionContractMaterializationError
            || error instanceof PluginCollectionQuotaCensusInconsistencyError
        ) {
            throw new PluginCollectionCandidatePreparationOperationError(
                "collection_candidate_preparation_contract_mismatch",
            );
        }
        throw error;
    }
}

type CandidatePromotionCurrentIntent = Readonly<{
    pluginId: string;
    desiredVersion: string | null;
    enabled: boolean;
    offlineUiHosting: string;
    writableCollections: unknown;
    revision: bigint;
}>;

function promotionNotReady(): never {
    throw new PluginCollectionWriterReadinessError("collection_writer_contract_not_ready");
}

function promotionIntent(input: CandidatePromotionCurrentIntent): ReturnType<typeof PluginAccountPluginIntentV1Schema.parse> {
    const parsed = PluginAccountPluginIntentV1Schema.safeParse({
        pluginId: input.pluginId,
        desiredVersion: input.desiredVersion,
        enabled: input.enabled,
        offlineUiHosting: input.offlineUiHosting,
        writableCollections: input.writableCollections,
        revision: input.revision.toString(),
    });
    if (!parsed.success) promotionNotReady();
    return parsed.data;
}

function isExactPersistedRef(input: Readonly<{
    row: Readonly<{
        contractId: string;
        schemaVersion: number;
        contractDigest: string;
    }>;
    materialized: ResolvedCandidateContract;
}>): boolean {
    return input.row.contractId === input.materialized.id
        && input.row.schemaVersion === input.materialized.ref.schemaVersion
        && input.row.contractDigest === input.materialized.ref.contractDigest;
}

/**
 * Re-censuses and promotes one fully prepared candidate only while
 * Availability owns the surrounding intent CAS transaction. It cannot select
 * a release, expose staged bytes, or publish an intent by itself.
 */
export async function promotePluginCollectionCandidatePreparationInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    currentIntent: CandidatePromotionCurrentIntent | null;
    targetReleaseVersion: string | null;
    targetContracts: readonly PluginCollectionContractRefV1[];
}>): Promise<void> {
    if (!input.currentIntent || input.targetReleaseVersion === null) return;
    const currentIntent = promotionIntent(input.currentIntent);
    if (currentIntent.pluginId !== input.pluginId || currentIntent.desiredVersion === null) {
        promotionNotReady();
    }
    const targetCollectionIdentities = new Set(input.targetContracts.map((ref) => (
        `${ref.pluginId}\u0000${ref.collectionId}`
    )));
    if (currentIntent.writableCollections.some((ref) => (
        !targetCollectionIdentities.has(`${ref.pluginId}\u0000${ref.collectionId}`)
    ))) {
        // Releasing a Collection is a separate destructive-retirement flow.
        // An ordinary non-null target release cannot silently orphan a current
        // Collection, even when it currently has no live rows to promote.
        promotionNotReady();
    }
    const fence = await acquireAccountEncryptionTransitionFenceInTx(input.tx, input.accountId);
    if (fence.status !== "ready") promotionNotReady();

    const changesByCollection = new Map<string, {
        pluginId: string;
        collectionId: string;
        contractDigest: string;
        revision: number;
    }>();

    for (const targetRef of input.targetContracts) {
        let target: ResolvedCandidateContract;
        try {
            target = await readExactCandidateContractInTx({ tx: input.tx, ref: targetRef });
        } catch (error) {
            if (error instanceof PluginCollectionCandidatePreparationOperationError) {
                promotionNotReady();
            }
            throw error;
        }
        const sourceRef = currentIntent.writableCollections.find((candidate) => (
            candidate.collectionId === targetRef.collectionId
        ));
        const allLiveRows = await input.tx.pluginCollectionRow.findMany({
            where: {
                accountId: input.accountId,
                pluginId: input.pluginId,
                collectionId: targetRef.collectionId,
                deletedAt: null,
            },
            orderBy: [{ rowId: "asc" }, { id: "asc" }],
            select: {
                id: true,
                rowId: true,
                revision: true,
                contractId: true,
                schemaVersion: true,
                contractDigest: true,
            },
        });

        if (!sourceRef || refsMatch(sourceRef, targetRef)) {
            if (allLiveRows.some((row) => !isExactPersistedRef({ row, materialized: target }))) {
                promotionNotReady();
            }
            continue;
        }

        let source: ResolvedCandidateContract;
        try {
            source = await readExactCandidateContractInTx({ tx: input.tx, ref: sourceRef });
        } catch (error) {
            if (error instanceof PluginCollectionCandidatePreparationOperationError) {
                promotionNotReady();
            }
            throw error;
        }
        if (allLiveRows.length === 0) continue;
        if (!hasDeclaredMigrationChain({
            sourceSchemaVersion: source.ref.schemaVersion,
            target: target.contract,
        })) {
            promotionNotReady();
        }
        if (allLiveRows.some((row) => !isExactPersistedRef({ row, materialized: source }))) {
            promotionNotReady();
        }

        const stages = await input.tx.pluginCollectionCandidatePreparationStage.findMany({
            where: {
                accountId: input.accountId,
                pluginId: input.pluginId,
                collectionId: targetRef.collectionId,
                sourceContractId: source.id,
                sourceSchemaVersion: source.ref.schemaVersion,
                sourceContractDigest: source.ref.contractDigest,
                targetContractId: target.id,
                targetSchemaVersion: target.ref.schemaVersion,
                targetContractDigest: target.ref.contractDigest,
                candidateReleaseVersion: input.targetReleaseVersion,
                sourceRowDbId: { in: allLiveRows.map((row) => row.id) },
            },
            select: {
                id: true,
                rowId: true,
                candidateIdentity: true,
                candidateArtifactDigest: true,
                sourceRowDbId: true,
                sourceRevision: true,
                targetContentEnvelope: true,
                targetProjection: true,
            },
        });
        const stagesByCandidateIdentity = new Map<string, typeof stages>();
        for (const stage of stages) {
            const candidateArtifactDigest = PluginUiArtifactDigestV1Schema.safeParse(
                stage.candidateArtifactDigest,
            );
            if (!candidateArtifactDigest.success) promotionNotReady();
            const expectedIdentity = candidatePreparationBindingIdentity({
                accountId: input.accountId,
                binding: {
                    source: source.ref,
                    target: target.ref,
                    candidate: {
                        releaseVersion: input.targetReleaseVersion,
                        artifactDigest: candidateArtifactDigest.data,
                    },
                },
            });
            if (stage.candidateIdentity !== expectedIdentity) promotionNotReady();
            const existing = stagesByCandidateIdentity.get(stage.candidateIdentity) ?? [];
            existing.push(stage);
            stagesByCandidateIdentity.set(stage.candidateIdentity, existing);
        }
        const completeCandidates = [...stagesByCandidateIdentity.values()].filter((candidateStages) => {
            if (candidateStages.length !== allLiveRows.length) return false;
            const bySourceRowId = new Map(candidateStages.map((stage) => [stage.sourceRowDbId, stage]));
            return bySourceRowId.size === allLiveRows.length && allLiveRows.every((row) => {
                const stage = bySourceRowId.get(row.id);
                return stage?.sourceRevision === row.revision && stage.rowId === row.rowId;
            });
        });
        if (completeCandidates.length !== 1) promotionNotReady();
        const selectedStages = completeCandidates[0]!;
        const selectedStageBySourceRowId = new Map(selectedStages.map((stage) => [stage.sourceRowDbId, stage]));
        const validatedTargets = new Map<string, ReturnType<typeof validateCandidateTarget>>();
        for (const row of allLiveRows) {
            const stage = selectedStageBySourceRowId.get(row.id);
            if (!stage) promotionNotReady();
            try {
                validatedTargets.set(row.id, validateCandidateTarget({
                    target,
                    encryptionMode: fence.account.currentness.encryptionMode,
                    rowId: row.rowId,
                    content: stage.targetContentEnvelope,
                    projection: PluginCollectionProjectionV1Schema.parse(stage.targetProjection),
                }));
            } catch (error) {
                if (error instanceof PluginCollectionCandidatePreparationOperationError) {
                    promotionNotReady();
                }
                throw error;
            }
        }
        const promotionRows = allLiveRows.map((row) => {
            const targetValue = validatedTargets.get(row.id);
            if (!targetValue) promotionNotReady();
            return {
                id: row.id,
                rowId: row.rowId,
                expectedRevision: row.revision,
                contentEnvelope: targetValue.content,
                projection: targetValue.projection,
            };
        });
        const maximumBatchRows = readPluginsFeatureEnv(process.env).collectionLimits.maxBatchRows;
        let preparedRows: ReturnType<typeof prepareCandidatePromotionMaterializedRows>;
        let preparedRelations: Awaited<ReturnType<typeof preparePluginCollectionRelationReplacementInTx>>;
        try {
            preparedRows = prepareCandidatePromotionMaterializedRows({
                contract: target.contract,
                rows: promotionRows,
            });
            preparedRelations = await preparePluginCollectionRelationReplacementInTx({
                tx: input.tx,
                accountId: input.accountId,
                contract: target.contract,
                changes: promotionRows.map((row) => ({
                    rowDbId: row.id,
                    rowId: row.rowId,
                    revision: row.expectedRevision + 1,
                    projection: row.projection,
                })),
                maximumBatchRows,
            });
        } catch (error) {
            if (error instanceof PluginCollectionMutationOperationError) {
                promotionNotReady();
            }
            throw error;
        }

        let derived: ResolvedWritableCollection;
        try {
            derived = await preparePluginCollectionDerivedStateForPromotionInTx({
                tx: input.tx,
                accountId: input.accountId,
                encryptionMode: fence.account.currentness.encryptionMode,
                contractId: target.id,
                contract: target.contract,
            });
        } catch (error) {
            if (error instanceof PluginCollectionMutationOperationError) {
                promotionNotReady();
            }
            throw error;
        }
        let promoted: boolean;
        try {
            promoted = await materializeCandidatePromotionSetwiseInTx({
                tx: input.tx,
                accountId: input.accountId,
                source: {
                    contractId: source.id,
                    schemaVersion: source.ref.schemaVersion,
                    contractDigest: source.ref.contractDigest,
                },
                target: {
                    contractId: target.id,
                    schemaVersion: target.ref.schemaVersion,
                    contractDigest: target.ref.contractDigest,
                },
                resolved: derived,
                rows: preparedRows,
                relations: preparedRelations,
                maximumBatchRows,
            });
        } catch (error) {
            if (error instanceof PluginCollectionMutationOperationError) {
                promotionNotReady();
            }
            throw error;
        }
        if (!promoted) promotionNotReady();
        await retirePluginCollectionCandidatePreparationStagesTx({
            tx: input.tx,
            accountId: input.accountId,
            sourceRowDbIds: allLiveRows.map((row) => row.id),
        });
        const change = {
            pluginId: target.ref.pluginId,
            collectionId: target.ref.collectionId,
            contractDigest: target.ref.contractDigest,
            revision: Math.max(...allLiveRows.map((row) => row.revision + 1)),
        };
        const key = `${change.pluginId}\u0000${change.collectionId}`;
        const existing = changesByCollection.get(key);
        if (
            !existing
            || change.revision > existing.revision
            || (
                change.revision === existing.revision
                && change.contractDigest > existing.contractDigest
            )
        ) {
            changesByCollection.set(key, change);
        }
    }

    for (const change of [...changesByCollection.values()].sort((left, right) => (
        left.pluginId.localeCompare(right.pluginId)
        || left.collectionId.localeCompare(right.collectionId)
    ))) {
        const hint = {
            pluginDomain: "dataCollection" as const,
            pluginId: change.pluginId,
            collectionId: change.collectionId,
            contractDigest: change.contractDigest,
            revision: change.revision,
            full: true as const,
        };
        await markAccountChanged(input.tx, {
            accountId: input.accountId,
            kind: "pluginDomain",
            entityId: buildPluginDomainAccountChangeEntityId(hint),
            hint,
        });
    }
}

/** The bounded source-page owner; it never reads staged target bytes. */
export async function pagePluginCollectionCandidatePreparationSource(input: Readonly<{
    accountId: string;
    request: unknown;
}>): Promise<PluginCollectionCandidatePreparationSourcePageResultV1> {
    const request = PluginCollectionCandidatePreparationSourcePageRequestV1Schema.parse(input.request);
    return await inTx(async (tx) => {
        const resolved = await resolveCandidatePreparationBindingInTx({
            tx,
            accountId: input.accountId,
            binding: request.binding,
        });
        const fingerprint = candidatePreparationCursorFingerprint({
            accountId: input.accountId,
            binding: request.binding,
        });
        const afterId = request.cursor
            ? decodeSourcePageCursor({ cursor: request.cursor, fingerprint })
            : undefined;
        const rows = await tx.pluginCollectionRow.findMany({
            where: {
                accountId: input.accountId,
                pluginId: resolved.source.ref.pluginId,
                collectionId: resolved.source.ref.collectionId,
                contractId: resolved.source.id,
                schemaVersion: resolved.source.ref.schemaVersion,
                contractDigest: resolved.source.ref.contractDigest,
                deletedAt: null,
                ...(afterId ? { id: { gt: afterId } } : {}),
            },
            orderBy: { id: "asc" },
            take: request.limit + 1,
            select: {
                id: true,
                rowId: true,
                revision: true,
                contentEnvelope: true,
                projections: {
                    select: { fieldId: true, typedEncodedValue: true },
                    orderBy: { fieldId: "asc" },
                },
            },
        });
        if (rows.length > 0) {
            assertCandidatePreparationMigrationAvailable({
                source: resolved.source,
                target: resolved.target,
            });
        }
        const pageRows = rows.slice(0, request.limit);
        const stages = pageRows.length === 0
            ? []
            : await tx.pluginCollectionCandidatePreparationStage.findMany({
                where: {
                    accountId: input.accountId,
                    pluginId: resolved.source.ref.pluginId,
                    collectionId: resolved.source.ref.collectionId,
                    candidateIdentity: resolved.candidateIdentity,
                    sourceContractId: resolved.source.id,
                    sourceSchemaVersion: resolved.source.ref.schemaVersion,
                    sourceContractDigest: resolved.source.ref.contractDigest,
                    targetContractId: resolved.target.id,
                    targetSchemaVersion: resolved.target.ref.schemaVersion,
                    targetContractDigest: resolved.target.ref.contractDigest,
                    candidateReleaseVersion: request.binding.candidate.releaseVersion,
                    candidateArtifactDigest: request.binding.candidate.artifactDigest,
                    sourceRowDbId: { in: pageRows.map((row) => row.id) },
                },
                select: { sourceRowDbId: true, sourceRevision: true },
            });
        const stagedRevisionBySourceRowId = new Map(
            stages.map((stage) => [stage.sourceRowDbId, stage.sourceRevision]),
        );
        const response = {
            rows: pageRows.map((row) => {
                const validated = readValidatedSourceRow({
                    source: resolved.source,
                    encryptionMode: resolved.encryptionMode,
                    row,
                });
                return {
                    rowId: row.rowId,
                    revision: row.revision,
                    content: validated.content,
                    projection: validated.projection,
                    alreadyStaged: stagedRevisionBySourceRowId.get(row.id) === row.revision,
                };
            }),
            ...(rows.length > request.limit && pageRows.length > 0
                ? {
                    nextCursor: encodeSourcePageCursor({
                        fingerprint,
                        lastRowDbId: pageRows[pageRows.length - 1]!.id,
                    }),
                }
                : {}),
        };
        return PluginCollectionCandidatePreparationSourcePageResultV1Schema.parse(response);
    });
}

/** The first valid target for one exact source revision wins; replay never overwrites it. */
export async function stagePluginCollectionCandidatePreparation(input: Readonly<{
    accountId: string;
    request: unknown;
}>): Promise<PluginCollectionCandidatePreparationStageResultV1> {
    const request = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(input.request);
    const deployment = readPluginsFeatureEnv(process.env).collectionLimits;
    const encodedBytes = measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(request);
    return await inTx(async (tx) => {
        const resolved = await resolveCandidatePreparationBindingInTx({
            tx,
            accountId: input.accountId,
            binding: request.binding,
        });
        const batchIncompatibility = findPluginCollectionBatchQuotaIncompatibility({
            deployment,
            operationCount: request.items.length,
            encodedBytes,
        });
        if (batchIncompatibility) {
            throw new PluginCollectionCandidatePreparationOperationError(
                "collection_quota_incompatible",
                batchIncompatibility,
            );
        }

        const sourceRows = await tx.pluginCollectionRow.findMany({
            where: {
                accountId: input.accountId,
                pluginId: resolved.source.ref.pluginId,
                collectionId: resolved.source.ref.collectionId,
                contractId: resolved.source.id,
                schemaVersion: resolved.source.ref.schemaVersion,
                contractDigest: resolved.source.ref.contractDigest,
                rowId: { in: [...new Set(request.items.map((item) => item.source.rowId))] },
                deletedAt: null,
            },
            select: { id: true, rowId: true, revision: true },
        });
        const sourceByRowId = new Map(sourceRows.map((row) => [row.rowId, row]));
        const prepared = request.items.map((item, index) => {
            const currentSource = sourceByRowId.get(item.source.rowId);
            const target = validateCandidateTarget({
                target: resolved.target,
                encryptionMode: resolved.encryptionMode,
                rowId: item.source.rowId,
                content: item.target.content,
                projection: item.target.projection,
            });
            return {
                index,
                sourceRow: currentSource?.revision === item.source.revision ? currentSource : undefined,
                sourceRevision: item.source.revision,
                rowId: item.source.rowId,
                target,
                targetContentEnvelope: toPrismaJson(target.content),
                targetProjection: toPrismaJson(target.projection),
            };
        });
        if (!prepared.some((item) => item.sourceRow)) {
            return PluginCollectionCandidatePreparationStageResultV1Schema.parse({
                results: prepared.map(() => ({ status: "sourceChanged" as const })),
            });
        }
        assertCandidatePreparationMigrationAvailable({
            source: resolved.source,
            target: resolved.target,
        });

        const stages = await readCandidateStageQuotaSnapshotInTx({
            tx,
            accountId: input.accountId,
        });
        const existingBySourceRowDbId = new Map<string, CandidatePreparationStageQuotaRecord>();
        for (const stage of stages) {
            if (
                stage.candidateIdentity === resolved.candidateIdentity
                && stage.targetContractId === resolved.target.id
            ) {
                existingBySourceRowDbId.set(stage.sourceRowDbId, stage);
            }
        }
        const results: Array<CandidatePreparationStageItemResult | undefined> = new Array(request.items.length);
        const prospective: CandidatePreparationProspectiveStage[] = [];
        const admittedSourceRowDbIds = new Set<string>();
        for (const item of prepared) {
            if (!item.sourceRow) {
                results[item.index] = { status: "sourceChanged" };
                continue;
            }
            const existing = existingBySourceRowDbId.get(item.sourceRow.id);
            if (existing) {
                if (!stageMatchesExactBinding({
                    stage: existing,
                    accountId: input.accountId,
                    resolved,
                    binding: request.binding,
                    sourceRowDbId: item.sourceRow.id,
                    sourceRevision: item.sourceRevision,
                })) {
                    throw new PluginCollectionCandidatePreparationOperationError(
                        "collection_candidate_preparation_invalid",
                    );
                }
                results[item.index] = { status: "staged" };
                continue;
            }
            if (!admittedSourceRowDbIds.add(item.sourceRow.id)) {
                results[item.index] = { status: "staged" };
                continue;
            }
            prospective.push({
                index: item.index,
                sourceRowDbId: item.sourceRow.id,
                sourceRevision: item.sourceRevision,
                rowId: item.rowId,
                target: resolved.target,
                content: item.target.content,
                projection: item.target.projection,
                targetContentEnvelope: item.targetContentEnvelope,
                targetProjection: item.targetProjection,
            });
        }

        if (prospective.length > 0) {
            await assertCandidateStageBatchQuotaInTx({
                tx,
                accountId: input.accountId,
                deployment,
                stages,
                prospective,
                candidateIdentity: resolved.candidateIdentity,
            });
            for (const stage of prospective) {
                const stageWhere = exactStageWhere({
                    accountId: input.accountId,
                    resolved,
                    binding: request.binding,
                    sourceRowDbId: stage.sourceRowDbId,
                    sourceRevision: stage.sourceRevision,
                });
                try {
                    await tx.pluginCollectionCandidatePreparationStage.create({
                        data: {
                            accountId: input.accountId,
                            pluginId: resolved.source.ref.pluginId,
                            collectionId: resolved.source.ref.collectionId,
                            rowId: stage.rowId,
                            candidateIdentity: resolved.candidateIdentity,
                            sourceRowDbId: stage.sourceRowDbId,
                            sourceContractId: resolved.source.id,
                            sourceSchemaVersion: resolved.source.ref.schemaVersion,
                            sourceContractDigest: resolved.source.ref.contractDigest,
                            sourceRevision: stage.sourceRevision,
                            targetContractId: resolved.target.id,
                            targetSchemaVersion: resolved.target.ref.schemaVersion,
                            targetContractDigest: resolved.target.ref.contractDigest,
                            candidateReleaseVersion: request.binding.candidate.releaseVersion,
                            candidateArtifactDigest: request.binding.candidate.artifactDigest,
                            targetContentEnvelope: stage.targetContentEnvelope,
                            targetProjection: stage.targetProjection,
                        },
                    });
                } catch (error) {
                    if (!isPrismaErrorCode(error, "P2002")) throw error;
                    // The compact candidateIdentity is only an implementation
                    // key. A race must re-prove every persisted binding fact;
                    // accepting a different raw record would make that key an
                    // authority boundary.
                    const raced = await tx.pluginCollectionCandidatePreparationStage.findFirst({
                        where: stageWhere,
                        select: { id: true },
                    });
                    if (!raced) {
                        throw new PluginCollectionCandidatePreparationOperationError(
                            "collection_candidate_preparation_invalid",
                        );
                    }
                }
                results[stage.index] = { status: "staged" };
            }
        }
        return PluginCollectionCandidatePreparationStageResultV1Schema.parse({
            results: results.map((result) => {
                if (!result) {
                    throw new Error("Candidate stage batch result was not resolved.");
                }
                return result;
            }),
        });
    });
}

/** Exact binding retirement remains available after its release has disappeared. */
export async function retirePluginCollectionCandidatePreparation(input: Readonly<{
    accountId: string;
    request: unknown;
}>): Promise<PluginCollectionCandidatePreparationRetireResultV1> {
    const request = PluginCollectionCandidatePreparationRetireRequestV1Schema.parse(input.request);
    const candidateIdentity = candidatePreparationBindingIdentity({
        accountId: input.accountId,
        binding: request.binding,
    });
    await inTx(async (tx) => {
        await tx.pluginCollectionCandidatePreparationStage.deleteMany({
            where: {
                accountId: input.accountId,
                pluginId: request.binding.source.pluginId,
                collectionId: request.binding.source.collectionId,
                candidateIdentity,
                sourceSchemaVersion: request.binding.source.schemaVersion,
                sourceContractDigest: request.binding.source.contractDigest,
                targetSchemaVersion: request.binding.target.schemaVersion,
                targetContractDigest: request.binding.target.contractDigest,
                candidateReleaseVersion: request.binding.candidate.releaseVersion,
                candidateArtifactDigest: request.binding.candidate.artifactDigest,
            },
        });
    });
    return PluginCollectionCandidatePreparationRetireResultV1Schema.parse({ status: "retired" });
}
