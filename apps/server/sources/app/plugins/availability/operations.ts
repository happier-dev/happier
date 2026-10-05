import type { Prisma } from "@prisma/client";
import {
    PluginAccountPluginIntentV1Schema,
    PluginAccountPluginPackageAssetLinkV1Schema,
    PluginAccountPluginUiArtifactLinkV1Schema,
    MAX_PLUGIN_ACCOUNT_AVAILABILITY_INTENT_IDS,
    PluginAvailabilityIntentReadActionInputV1Schema,
    PluginAvailabilityIntentsListActionInputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityIntentSetActionInputV1Schema,
    PluginAvailabilityCollectionWritersClaimActionInputV1Schema,
    PluginAvailabilityMaterializationsReadActionInputV1Schema,
    PluginAvailabilityMaterializationsReportActionInputV1Schema,
    PluginAvailabilityReleaseReadActionInputV1Schema,
    PluginAvailabilityReleaseReadActionOutputV1Schema,
    PluginAvailabilityReleasePublishActionInputV1Schema,
    PluginAvailabilityPackageAssetPublishActionInputV1Schema,
    PluginAvailabilityPackageAssetReadActionInputV1Schema,
    PluginAvailabilityPackageAssetRemoveActionInputV1Schema,
    PluginAvailabilityUiArtifactPublishActionInputV1Schema,
    PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema,
    PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1Schema,
    PluginAvailabilityUiArtifactReadActionInputV1Schema,
    PluginAvailabilityUiArtifactRemoveActionInputV1Schema,
    isExactPluginMachineMaterializationReleaseCorrespondenceV1,
    isPluginUiReleaseSlotCompatibleWithArtifactLinkV1,
    PluginMachineMaterializationSnapshotV1Schema,
    PluginMachineMaterializationV1Schema,
    PluginUiArtifactHostingCapabilityV1Schema,
    PluginUiReleaseSlotV1Schema,
    buildPluginDomainAccountChangeEntityId,
    createCanonicalJsonSigningInput,
    decodePlainArtifactStoredContent,
    normalizePluginMachineMaterializationSnapshotV1,
    normalizePluginReleaseFactsV1,
    pluginReleaseFactsEqualV1,
    supportsMachineOperationProtocolCapabilityV1,
    type PluginAccountPluginUiArtifactLinkV1,
    type PluginAccountPluginPackageAssetLinkV1,
    type PluginAvailabilityArtifactReadEnvelopeV1,
    type PluginAvailabilityIntentReadActionOutputV1,
    type PluginAvailabilityIntentsListActionOutputV1,
    type PluginAvailabilityIntentSetActionOutputV1,
    type PluginAvailabilityCollectionWritersClaimActionOutputV1,
    type PluginCollectionContractRefV1,
    type PluginAvailabilityMaterializationsReadActionOutputV1,
    type PluginAvailabilityMaterializationsReportActionOutputV1,
    type PluginAvailabilityReleaseReadActionOutputV1,
    type PluginAvailabilityReleasePublishActionOutputV1,
    type PluginAvailabilityPackageAssetPublishActionOutputV1,
    type PluginAvailabilityPackageAssetReadActionOutputV1,
    type PluginAvailabilityPackageAssetRemoveActionOutputV1,
    type PluginAvailabilityUiArtifactPublishActionOutputV1,
    type PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1,
    type PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1,
    type PluginAvailabilityUiArtifactReadActionOutputV1,
    type PluginAvailabilityUiArtifactRemoveActionOutputV1,
    type PluginMachineMaterializationV1,
    type PluginMachineMaterializationSnapshotV1,
    type PluginCollectionQuotaDimensionV1,
    type PluginReleaseFactsV1,
    type PluginUiArtifactHostingCapabilityV1,
    type PluginUiReleaseSlotV1,
    type MachineOperationProtocolCapabilityNameV1,
    type ArtifactAccountEncryptionMigrationOwnershipV1,
} from "@happier-dev/protocol";
import {
    decodePackageAssetArchiveBodyV1,
    openPackageAssetArchiveV1,
} from "@happier-dev/protocol/plugins/availability";
import * as privacyKit from "privacy-kit";
import semver from "semver";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { resolvePluginUiArtifactHostingCapability } from "@/app/features/pluginsFeature";
import {
    createArtifactTx,
} from "@/app/artifacts/artifactWriteService";
import {
    artifactDataKeyMatchesAccountMode,
    artifactStoredContentMatchesAccountMode,
    isPlainArtifactDataKeyBytes,
    openArtifactStoredContentPair,
} from "@/app/artifacts/artifactStoredContent";
import {
    decodePluginUiArtifactArchiveBodyV1,
    deriveGeneratedHostedWebAssetPolicyV1,
    openPluginUiArtifactArchiveV1,
    resolveHostedWebAssetPolicy,
    type GeneratedHostedWebAssetPolicyV1,
    type PluginUiArtifactArchiveOpenedV1,
    type PluginUiArtifactDigestV1,
} from "@happier-dev/protocol/plugins/ui";
import {
    PluginCollectionContractMaterializationError,
    PluginCollectionWriterReadinessError,
    materializePluginCollectionContractsFromManifestTx,
    materializePluginCollectionContractsTx,
    preparePluginCollectionWritableContractsTx,
} from "@/app/plugins/data/collections/contracts";
import { promotePluginCollectionCandidatePreparationInTx } from "@/app/plugins/data/collections/candidatePreparation";
import { retirePluginCollectionCandidatePreparationStagesTx } from "@/app/plugins/data/collections/candidatePreparationLifecycle";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { db, isPrismaErrorCode } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";
import { warn } from "@/utils/logging/log";

import {
    createBrowserArtifactCapabilityUrl,
    isBrowserArtifactCapabilityRequestOnArtifactOrigin,
    mintBrowserArtifactCapability,
    resolveBrowserArtifactCapabilityConfig,
    verifyBrowserArtifactCapability,
} from "./browserArtifactCapability";
import {
    createReleaseLessDeclarationV1,
    readCurrentReleaseLessDeclarationV1,
    type ReleaseLessDeclarationV1,
} from "./currentDeclaration";

type Awaitable<T> = T | Promise<T>;

export type PluginAvailabilityOperationErrorCode =
    | "plugin_availability_authentication_required"
    | "plugin_availability_invalid_request"
    | "plugin_availability_intent_discovery_limit_exceeded"
    | "plugin_availability_publisher_proof_required"
    | "plugin_account_not_found"
    | "plugin_release_content_conflict"
    | "plugin_release_collection_contract_mismatch"
    | "plugin_release_not_found"
    | "plugin_intent_revision_conflict"
    | "plugin_intent_writable_collections_not_ready"
    | "plugin_intent_release_selected"
    | "plugin_collection_contract_conflict"
    | "collection_quota_incompatible"
    | "plugin_materialization_machine_mismatch"
    | "plugin_materialization_server_identity_mismatch"
    | "plugin_ui_artifact_hosting_unsupported"
    | "plugin_ui_artifact_hosting_not_opted_in"
    | "plugin_ui_artifact_hosting_limit_exceeded"
    | "plugin_ui_artifact_invalid_content"
    | "plugin_ui_artifact_conflict"
    | "plugin_ui_artifact_not_found"
    | "plugin_ui_artifact_browser_e2ee_unavailable"
    | "plugin_package_asset_hosting_unsupported"
    | "plugin_package_asset_hosting_not_opted_in"
    | "plugin_package_asset_hosting_limit_exceeded"
    | "plugin_package_asset_invalid_content"
    | "plugin_package_asset_conflict"
    | "plugin_package_asset_not_found";

export class PluginAvailabilityOperationError extends Error {
    readonly code: PluginAvailabilityOperationErrorCode;
    readonly dimension: PluginCollectionQuotaDimensionV1 | undefined;
    readonly effectiveMaximum: number | undefined;

    constructor(
        code: PluginAvailabilityOperationErrorCode,
        quota?: Readonly<{
            dimension: PluginCollectionQuotaDimensionV1;
            effectiveMaximum: number;
        }>,
    ) {
        super(code);
        this.name = "PluginAvailabilityOperationError";
        this.code = code;
        this.dimension = quota?.dimension;
        this.effectiveMaximum = quota?.effectiveMaximum;
    }
}

export type PluginAvailabilityBrowserArtifactFrameResponse = Readonly<{
    bytes: Uint8Array;
    contentType: string;
    headers: Readonly<Record<string, string>>;
}>;

type CurrentPlainBrowserArtifactFrame = Readonly<{
    link: PluginAccountPluginUiArtifactLinkV1;
    archive: PluginUiArtifactArchiveOpenedV1;
    hostedWebPolicy: GeneratedHostedWebAssetPolicyV1;
}>;

type StoredReleaseRow = Readonly<{
    id: string;
    accountId: string;
    pluginId: string;
    version: string;
    archiveDigestSha256: string;
    normalizedManifest: unknown;
    collectionContracts: unknown;
    uiSlots: unknown;
    packageAssetArchive: unknown | null;
}>;

type StoredUiArtifactLinkRow = Readonly<{
    contributionId: string;
    tier: string;
    platform: string;
    artifactId: string;
    artifactDigest: string;
    compatibility: unknown;
    release: Readonly<{
        accountId: string;
        pluginId: string;
        version: string;
    }>;
}>;

type StoredPackageAssetArtifactRow = Readonly<{
    id: string;
    accountId: string;
    header: Uint8Array;
    headerVersion: number;
    body: Uint8Array;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array;
    seq: number;
}>;

type StoredUiArtifactLinkWithArtifactRow = StoredUiArtifactLinkRow & Readonly<{
    artifact: StoredPackageAssetArtifactRow;
}>;

type StoredPackageAssetLinkRow = Readonly<{
    accountId: string;
    pluginId: string;
    version: string;
    packageAssetArchive: unknown | null;
    packageAssetArtifactId: string | null;
    packageAssetArtifact: StoredPackageAssetArtifactRow | null;
}>;

type StoredIntentRow = Readonly<{
    pluginId: string;
    desiredVersion: string | null;
    enabled: boolean;
    offlineUiHosting: string;
    writableCollections: unknown;
    releaseLessDeclaration: unknown;
    revision: bigint;
}>;

const AVAILABILITY_CHANGE_ACTION = "availability" as const;
const MAX_PLUGIN_ACCOUNT_AVAILABILITY_INTENT_LIST_BYTES = 64 * 1024;

function availabilityChangeHint(pluginId: string) {
    return {
        pluginDomain: AVAILABILITY_CHANGE_ACTION,
        pluginId,
    };
}

function comparePluginIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

async function markAvailabilityChangedTx(
    tx: Tx,
    accountId: string,
    pluginId: string,
): Promise<number> {
    const hint = availabilityChangeHint(pluginId);
    return await markAccountChanged(tx, {
        accountId,
        kind: "pluginDomain",
        entityId: buildPluginDomainAccountChangeEntityId(hint),
        hint,
    });
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new TypeError("Availability JSON values must be serializable");
    }
    return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function releaseFactsFromRow(row: StoredReleaseRow): PluginReleaseFactsV1 {
    if (row.packageAssetArchive === null) {
        throw new PluginAvailabilityOperationError(
            "plugin_release_content_conflict",
        );
    }
    return normalizePluginReleaseFactsV1({
        ref: {
            pluginId: row.pluginId,
            version: row.version,
        },
        archiveDigestSha256: row.archiveDigestSha256,
        normalizedManifest: row.normalizedManifest,
        collectionContracts: row.collectionContracts,
        uiSlots: row.uiSlots,
        packageAssetArchive: row.packageAssetArchive,
    });
}

function intentFromRow(row: Omit<StoredIntentRow, "releaseLessDeclaration">) {
    return PluginAccountPluginIntentV1Schema.parse({
        pluginId: row.pluginId,
        desiredVersion: row.desiredVersion,
        enabled: row.enabled,
        offlineUiHosting: row.offlineUiHosting,
        writableCollections: row.writableCollections,
        revision: row.revision.toString(),
    });
}

/**
 * The release normalizer orders collection refs by this same qualified key.
 * Availability uses it only to compare its selected release with the requested
 * writer set; Data remains the sole validator and readiness owner.
 */
function collectionContractsEqual(
    left: readonly Readonly<{
        pluginId: string;
        collectionId: string;
        schemaVersion: number;
        contractDigest: string;
    }>[],
    right: readonly Readonly<{
        pluginId: string;
        collectionId: string;
        schemaVersion: number;
        contractDigest: string;
    }>[],
): boolean {
    const normalize = (contracts: typeof left) => (
        [...contracts].sort((first, second) => (
            `${first.pluginId}\u0000${first.collectionId}`.localeCompare(
                `${second.pluginId}\u0000${second.collectionId}`,
            )
        ))
    );
    return createCanonicalJsonSigningInput(normalize(left))
        === createCanonicalJsonSigningInput(normalize(right));
}

async function retainSelectedPluginReleaseArchivesTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    selectedVersion: string | null;
    priorSelectedVersion: string | null;
}>): Promise<void> {
    const releases = await input.tx.accountPluginRelease.findMany({
        where: { accountId: input.accountId, pluginId: input.pluginId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
            id: true,
            version: true,
            packageAssetArtifactId: true,
            uiArtifacts: { select: { artifactId: true } },
        },
    });
    const archiveVersions = new Set(
        [input.selectedVersion, input.priorSelectedVersion].filter(
            (version): version is string => version !== null,
        ),
    );
    const releasesToPrune = releases.filter(
        (release) => !archiveVersions.has(release.version),
    );
    const artifactIdsToPrune = releasesToPrune.flatMap((release) => [
        release.packageAssetArtifactId,
        ...release.uiArtifacts.map((link) => link.artifactId),
    ]).filter((artifactId): artifactId is string => artifactId !== null);
    if (artifactIdsToPrune.length === 0) return;
    const [account, artifacts] = await Promise.all([
        input.tx.account.findUnique({
            where: { id: input.accountId },
            select: {
                encryptionMode: true,
                publicKey: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        }),
        input.tx.artifact.findMany({
            where: {
                accountId: input.accountId,
                id: { in: artifactIdsToPrune },
            },
            select: { id: true, dataEncryptionKey: true },
        }),
    ]);
    const currentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    const mismatchedPackageAsset = releasesToPrune.some((release) => {
        const artifact = release.packageAssetArtifactId
            ? artifactById.get(release.packageAssetArtifactId)
            : null;
        return artifact !== null && artifact !== undefined && (
            currentness?.status !== "ready"
            || !artifactDataKeyMatchesAccountMode({
                mode: currentness.currentness.encryptionMode,
                dataEncryptionKey: artifact.dataEncryptionKey,
            })
        );
    });
    if (mismatchedPackageAsset) {
        throw new PluginAvailabilityOperationError(
            "plugin_package_asset_invalid_content",
        );
    }
    if (
        currentness?.status !== "ready"
        || releasesToPrune.some((release) => release.uiArtifacts.some((link) => {
            const artifact = artifactById.get(link.artifactId);
            return artifact !== undefined && !artifactDataKeyMatchesAccountMode({
                mode: currentness.currentness.encryptionMode,
                dataEncryptionKey: artifact.dataEncryptionKey,
            });
        }))
    ) {
        throw new PluginAvailabilityOperationError(
            "plugin_ui_artifact_invalid_content",
        );
    }
    for (const release of releases) {
        if (!archiveVersions.has(release.version)) {
            const artifactIds = [
                release.packageAssetArtifactId,
                ...release.uiArtifacts.map((link) => link.artifactId),
            ].filter((artifactId): artifactId is string => artifactId !== null);
            await input.tx.accountPluginUiArtifact.deleteMany({ where: { releaseId: release.id } });
            if (release.packageAssetArtifactId !== null) {
                await input.tx.accountPluginRelease.update({
                    where: { id: release.id },
                    data: { packageAssetArtifactId: null },
                });
            }
            if (artifactIds.length > 0) {
                await input.tx.artifact.deleteMany({
                    where: { accountId: input.accountId, id: { in: artifactIds } },
                });
            }
        }
    }
}

function parseExpectedIntentRevision(value: string | null): bigint | null {
    if (value === null) return null;
    try {
        const revision = BigInt(value);
        if (revision < BigInt(0) || revision.toString() !== value) {
            throw new Error("Intent revision must be a canonical non-negative integer.");
        }
        return revision;
    } catch {
        throw new PluginAvailabilityOperationError(
            "plugin_availability_invalid_request",
        );
    }
}

async function materializeReleaseCollectionContractsTx(
    tx: Tx,
    facts: PluginReleaseFactsV1,
): Promise<void> {
    try {
        const materialized = await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: facts.normalizedManifest,
        });
        if (
            createCanonicalJsonSigningInput(materialized)
            !== createCanonicalJsonSigningInput(facts.collectionContracts)
        ) {
            throw new PluginAvailabilityOperationError(
                "plugin_release_collection_contract_mismatch",
            );
        }
    } catch (error) {
        if (error instanceof PluginAvailabilityOperationError) throw error;
        if (error instanceof PluginCollectionContractMaterializationError) {
            throw new PluginAvailabilityOperationError(
                "plugin_release_collection_contract_mismatch",
            );
        }
        throw error;
    }
}

const INTENT_ROW_SELECT = {
    pluginId: true,
    desiredVersion: true,
    enabled: true,
    offlineUiHosting: true,
    writableCollections: true,
    releaseLessDeclaration: true,
    revision: true,
} as const;

/**
 * The one intent transition body shared by the present-user release
 * selection and the release-less writer claim. Availability remains the
 * release/currentness and final CAS owner; Data only consumes the current
 * source plus the selected target inside this transaction and returns a
 * readiness result before the intent is published.
 */
async function transitionIntentTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    current: StoredIntentRow | null;
    next: Readonly<{
        desiredVersion: string | null;
        enabled: boolean;
        offlineUiHosting: "disabled" | "enabled";
        writableCollections: readonly PluginCollectionContractRefV1[];
        /** Only a release-less intent carries a claimed declaration. */
        releaseLessDeclaration: ReleaseLessDeclarationV1 | null;
    }>;
}>): Promise<PluginAvailabilityIntentSetActionOutputV1> {
    const { tx, accountId, pluginId, current, next } = input;
    if (next.desiredVersion !== null && next.releaseLessDeclaration !== null) {
        throw new TypeError("A selected release cannot carry a release-less declaration");
    }
    await promotePluginCollectionCandidatePreparationInTx({
        tx,
        accountId,
        pluginId,
        currentIntent: current,
        targetReleaseVersion: next.desiredVersion,
        targetContracts: next.writableCollections,
    });
    const prepared = await preparePluginCollectionWritableContractsTx({
        tx,
        accountId,
        pluginId,
        contracts: next.writableCollections,
    });
    // Any successful intent transition retires residual candidate outputs.
    // Promotion removed its exact source stages above; this broad lifecycle
    // cleanup covers cancelled/replaced and no-row bindings without making
    // stages an activation owner.
    await retirePluginCollectionCandidatePreparationStagesTx({ tx, accountId, pluginId });
    const data = {
        desiredVersion: next.desiredVersion,
        enabled: next.enabled,
        offlineUiHosting: next.offlineUiHosting,
        writableCollections: toPrismaJson(prepared.contracts),
        releaseLessDeclaration: next.releaseLessDeclaration === null
            ? getActivePrismaRuntime().DbNull
            : toPrismaJson(next.releaseLessDeclaration),
    };
    if (!current) {
        const created = await tx.accountPluginIntent.create({
            data: { accountId, pluginId, ...data, revision: BigInt(0) },
            select: INTENT_ROW_SELECT,
        });
        await retainSelectedPluginReleaseArchivesTx({
            tx,
            accountId,
            pluginId,
            selectedVersion: next.desiredVersion,
            priorSelectedVersion: null,
        });
        await markAvailabilityChangedTx(tx, accountId, pluginId);
        return { intent: intentFromRow(created) };
    }
    const updated = await tx.accountPluginIntent.updateMany({
        where: { accountId, pluginId, revision: current.revision },
        data: { ...data, revision: { increment: BigInt(1) } },
    });
    if (updated.count !== 1) {
        throw new PluginAvailabilityOperationError("plugin_intent_revision_conflict");
    }
    const stored = await tx.accountPluginIntent.findUnique({
        where: { accountId_pluginId: { accountId, pluginId } },
        select: INTENT_ROW_SELECT,
    });
    if (!stored) {
        throw new PluginAvailabilityOperationError("plugin_intent_revision_conflict");
    }
    if (next.desiredVersion !== current.desiredVersion) {
        await retainSelectedPluginReleaseArchivesTx({
            tx,
            accountId,
            pluginId,
            selectedVersion: next.desiredVersion,
            priorSelectedVersion: current.desiredVersion,
        });
    }
    await markAvailabilityChangedTx(tx, accountId, pluginId);
    return { intent: intentFromRow(stored) };
}

/** Maps Data readiness and CAS races to the typed Availability contract. */
function intentTransitionError(error: unknown): unknown {
    if (error instanceof PluginCollectionWriterReadinessError) {
        if (
            error.code === "collection_quota_incompatible"
            && error.dimension !== undefined
            && error.effectiveMaximum !== undefined
        ) {
            return new PluginAvailabilityOperationError(
                "collection_quota_incompatible",
                {
                    dimension: error.dimension,
                    effectiveMaximum: error.effectiveMaximum,
                },
            );
        }
        return new PluginAvailabilityOperationError(
            "plugin_intent_writable_collections_not_ready",
        );
    }
    if (isPrismaErrorCode(error, "P2002")) {
        return new PluginAvailabilityOperationError("plugin_intent_revision_conflict");
    }
    return error;
}

function linkFromRow(
    row: StoredUiArtifactLinkRow,
    slot: PluginUiReleaseSlotV1,
): PluginAccountPluginUiArtifactLinkV1 {
    return PluginAccountPluginUiArtifactLinkV1Schema.parse({
        release: {
            pluginId: row.release.pluginId,
            version: row.release.version,
        },
        contributionId: row.contributionId,
        artifactId: slot.artifactId,
        tier: row.tier,
        platform: row.platform,
        accountArtifactId: row.artifactId,
        artifactDigest: row.artifactDigest,
        hostUiApiRange: slot.hostUiApiRange,
    });
}

function packageAssetFactsFromRow(row: StoredReleaseRow): PluginReleaseFactsV1 {
    if (row.packageAssetArchive === null) {
        // A pre-feature release has no immutable archive authority. It must
        // remain unavailable rather than receiving a fabricated descriptor.
        throw new PluginAvailabilityOperationError(
            "plugin_package_asset_not_found",
        );
    }
    try {
        return releaseFactsFromRow(row);
    } catch {
        throw new PluginAvailabilityOperationError(
            "plugin_package_asset_conflict",
        );
    }
}

function packageAssetLinkFromRow(
    row: StoredPackageAssetLinkRow,
    descriptor: PluginReleaseFactsV1["packageAssetArchive"],
): PluginAccountPluginPackageAssetLinkV1 | null {
    if (
        row.packageAssetArtifactId === null
        || row.packageAssetArtifact === null
        || row.packageAssetArtifact.id !== row.packageAssetArtifactId
        || row.packageAssetArtifact.accountId !== row.accountId
    ) {
        return null;
    }
    const parsed = PluginAccountPluginPackageAssetLinkV1Schema.safeParse({
        release: { pluginId: row.pluginId, version: row.version },
        artifactId: row.packageAssetArtifactId,
        descriptor,
    });
    return parsed.success ? parsed.data : null;
}

function slotsEqual(
    left: PluginUiReleaseSlotV1,
    right: PluginUiReleaseSlotV1,
): boolean {
    return createCanonicalJsonSigningInput(
        PluginUiReleaseSlotV1Schema.parse(left),
    ) === createCanonicalJsonSigningInput(
        PluginUiReleaseSlotV1Schema.parse(right),
    );
}

function slotCoordinates(slot: PluginUiReleaseSlotV1) {
    return {
        contributionId: slot.contributionId,
        tier: slot.tier,
        platform: slot.platform,
    };
}

function decodeArtifactEnvelope(input: Readonly<{
    header: string;
    body: string;
    dataEncryptionKey: string;
}>, invalidContentCode: PluginAvailabilityOperationErrorCode = "plugin_ui_artifact_invalid_content") {
    try {
        return {
            header: privacyKit.decodeBase64(input.header),
            body: privacyKit.decodeBase64(input.body),
            dataEncryptionKey: privacyKit.decodeBase64(input.dataEncryptionKey),
        };
    } catch {
        throw new PluginAvailabilityOperationError(
            invalidContentCode,
        );
    }
}

function readArtifactArchiveBodyString(value: unknown): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const body = (value as Readonly<Record<string, unknown>>).body;
    return typeof body === "string" ? body : null;
}

function artifactBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return left.byteLength === right.byteLength
        && left.every((value, index) => value === right[index]);
}

function copyArtifactBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function storedArtifactMatchesEnvelope(input: Readonly<{
    accountId: string;
    mode: "plain" | "e2ee";
    artifact: StoredPackageAssetArtifactRow;
    envelope: Readonly<{
        header: Uint8Array;
        body: Uint8Array;
        dataEncryptionKey: Uint8Array;
    }>;
}>): boolean {
    const opened = openArtifactStoredContentPair({
        accountId: input.accountId,
        artifactId: input.artifact.id,
        mode: input.mode,
        dataEncryptionKey: input.artifact.dataEncryptionKey,
        header: input.artifact.header,
        body: input.artifact.body,
    });
    return opened !== null
        && artifactBytesEqual(opened.header, input.envelope.header)
        && artifactBytesEqual(opened.body, input.envelope.body)
        && artifactBytesEqual(
            input.artifact.dataEncryptionKey,
            input.envelope.dataEncryptionKey,
        );
}

async function isStoredHostedArtifactRejoin(input: Readonly<{
    tx: Tx;
    accountId: string;
    artifactId: string;
    link: Readonly<{ artifactId: string; artifact: StoredPackageAssetArtifactRow }>;
    envelope: Readonly<{ header: Uint8Array; body: Uint8Array; dataEncryptionKey: Uint8Array }>;
}>): Promise<boolean> {
    if (input.link.artifact.accountId !== input.accountId) return false;
    const account = await input.tx.account.findUnique({
        where: { id: input.accountId },
        select: {
            encryptionMode: true,
            publicKey: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const currentness = account ? deriveAccountEncryptionCurrentnessFromRow(account) : null;
    if (currentness?.status !== "ready") return false;
    const mode = currentness.currentness.encryptionMode;
    const opened = openArtifactStoredContentPair({
        ...input.link.artifact,
        accountId: input.accountId,
        artifactId: input.link.artifact.id,
        mode,
    });
    if (
        !opened
        || !artifactStoredContentMatchesAccountMode({
            mode: currentness.currentness.encryptionMode,
            ...input.envelope,
        })
        || !artifactStoredContentMatchesAccountMode({
            mode: currentness.currentness.encryptionMode,
            ...opened,
            dataEncryptionKey: input.link.artifact.dataEncryptionKey,
        })
    ) return false;
    if (input.link.artifactId === input.artifactId) {
        return storedArtifactMatchesEnvelope({
            accountId: input.accountId,
            mode,
            artifact: input.link.artifact,
            envelope: input.envelope,
        });
    }
    // The qualified immutable slot is authoritative, not a fresh envelope's
    // nonce or proposed ID. Never absorb an ID already owned by another row.
    return await input.tx.artifact.findUnique({
        where: { id: input.artifactId },
        select: { id: true },
    }) === null;
}

function isExactPlainPackageAssetArchive(input: Readonly<{
    descriptor: PluginReleaseFactsV1["packageAssetArchive"];
    envelope: Readonly<{
        header: Uint8Array;
        body: Uint8Array;
        dataEncryptionKey: Uint8Array;
    }>;
}>): boolean {
    if (!isPlainArtifactDataKeyBytes(input.envelope.dataEncryptionKey)) {
        // E2EE archive bytes are intentionally opaque to the server. Their
        // canonical verification remains at the Account Artifact opener.
        return true;
    }
    const header = decodePlainArtifactStoredContent(
        privacyKit.encodeBase64(copyArtifactBytes(input.envelope.header)),
    );
    const bodyEnvelope = decodePlainArtifactStoredContent(
        privacyKit.encodeBase64(copyArtifactBytes(input.envelope.body)),
    );
    const encodedBody = readArtifactArchiveBodyString(bodyEnvelope);
    const body = encodedBody
        ? decodePackageAssetArchiveBodyV1(encodedBody)
        : null;
    return header !== null
        && body !== null
        && openPackageAssetArchiveV1({
            expectedDescriptor: input.descriptor,
            header,
            body,
        }) !== null;
}

function isExactPlainUiArtifactArchive(input: Readonly<{
    pluginId: string;
    slot: PluginUiReleaseSlotV1;
    envelope: Readonly<{
        header: Uint8Array;
        body: Uint8Array;
        dataEncryptionKey: Uint8Array;
    }>;
}>): boolean {
    if (!isPlainArtifactDataKeyBytes(input.envelope.dataEncryptionKey)) {
        // E2EE archive bytes are intentionally opaque to the server. Their
        // canonical verification remains at the Account Artifact opener.
        return true;
    }
    const header = decodePlainArtifactStoredContent(
        privacyKit.encodeBase64(copyArtifactBytes(input.envelope.header)),
    );
    const bodyEnvelope = decodePlainArtifactStoredContent(
        privacyKit.encodeBase64(copyArtifactBytes(input.envelope.body)),
    );
    const encodedBody = readArtifactArchiveBodyString(bodyEnvelope);
    const body = encodedBody
        ? decodePluginUiArtifactArchiveBodyV1(encodedBody)
        : null;
    const archive = header !== null && body !== null
        ? openPluginUiArtifactArchiveV1({
            pluginId: input.pluginId,
            expectedArtifactDigest: input.slot.artifactDigest,
            header,
            body,
        })
        : null;
    return archive !== null
        && archive.artifactGraph.artifactId === input.slot.artifactId
        && archive.artifactGraph.tier === input.slot.tier
        && archive.artifactGraph.hostUiApiRange === input.slot.hostUiApiRange;
}

function artifactEnvelopeByteLength(input: Readonly<{
    header: Uint8Array;
    body: Uint8Array;
    dataEncryptionKey: Uint8Array;
}>): number {
    return input.header.byteLength
        + input.body.byteLength
        + input.dataEncryptionKey.byteLength;
}

async function resolveReleaseTx(
    tx: Tx,
    accountId: string,
    ref: Readonly<{ pluginId: string; version: string }>,
): Promise<StoredReleaseRow | null> {
    return await tx.accountPluginRelease.findUnique({
        where: {
            accountId_pluginId_version: {
                accountId,
                pluginId: ref.pluginId,
                version: ref.version,
            },
        },
        select: {
            id: true,
            accountId: true,
            pluginId: true,
            version: true,
            archiveDigestSha256: true,
            normalizedManifest: true,
            collectionContracts: true,
            uiSlots: true,
            packageAssetArchive: true,
        },
    });
}

async function resolveStoredSlotLinkTx(
    tx: Tx,
    releaseId: string,
    slot: PluginUiReleaseSlotV1,
): Promise<StoredUiArtifactLinkWithArtifactRow | null> {
    return await tx.accountPluginUiArtifact.findUnique({
        where: {
            releaseId_contributionId_tier_platform: {
                releaseId,
                ...slotCoordinates(slot),
            },
        },
        select: {
            contributionId: true,
            tier: true,
            platform: true,
            artifactId: true,
            artifactDigest: true,
            compatibility: true,
            release: {
                select: {
                    accountId: true,
                    pluginId: true,
                    version: true,
                },
            },
            artifact: {
                select: {
                    id: true,
                    accountId: true,
                    header: true,
                    headerVersion: true,
                    body: true,
                    bodyVersion: true,
                    dataEncryptionKey: true,
                    seq: true,
                },
            },
        },
    });
}

async function resolveStoredPackageAssetLinkTx(
    tx: Tx,
    releaseId: string,
): Promise<StoredPackageAssetLinkRow | null> {
    return await tx.accountPluginRelease.findUnique({
        where: { id: releaseId },
        select: {
            accountId: true,
            pluginId: true,
            version: true,
            packageAssetArchive: true,
            packageAssetArtifactId: true,
            packageAssetArtifact: {
                select: {
                    id: true,
                    accountId: true,
                    header: true,
                    headerVersion: true,
                    body: true,
                    bodyVersion: true,
                    dataEncryptionKey: true,
                    seq: true,
                },
            },
        },
    });
}

function isStoredLinkForDeclaredSlot(
    row: StoredUiArtifactLinkRow,
    slot: PluginUiReleaseSlotV1,
): boolean {
    try {
        const stored = linkFromRow(row, slot);
        return stored.artifactDigest === slot.artifactDigest
            && stored.contributionId === slot.contributionId
            && stored.tier === slot.tier
            && stored.platform === slot.platform
            && isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(slot, stored);
    } catch {
        return false;
    }
}

/** Transition reads retain immutable release authority, not active hosting intent. */
export async function qualifyPluginArtifactAccountEncryptionMigrationInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    artifactId: string;
    uiRelease: Readonly<{ pluginId: string; version: string }> | null;
    packageRelease: Readonly<{ pluginId: string; version: string }> | null;
    envelopes: readonly Readonly<{ header: Uint8Array; body: Uint8Array; dataEncryptionKey: Uint8Array }>[];
}>): Promise<ArtifactAccountEncryptionMigrationOwnershipV1 | null> {
    if ((params.uiRelease === null) === (params.packageRelease === null)) return null;
    const ref = params.uiRelease ?? params.packageRelease!;
    const release = await resolveReleaseTx(params.tx, params.accountId, ref);
    if (!release || release.accountId !== params.accountId) return null;
    try {
        if (params.packageRelease) {
            const facts = packageAssetFactsFromRow(release);
            const stored = await resolveStoredPackageAssetLinkTx(params.tx, release.id);
            const link = stored && packageAssetLinkFromRow(stored, facts.packageAssetArchive);
            if (!link || link.artifactId !== params.artifactId || stored?.accountId !== params.accountId
                || stored.pluginId !== release.pluginId || stored.version !== release.version
                || !params.envelopes.every(envelope => isExactPlainPackageAssetArchive({ descriptor: facts.packageAssetArchive, envelope }))) return null;
            return { kind: 'packageAsset', pluginId: release.pluginId, descriptor: facts.packageAssetArchive };
        }
        const facts = releaseFactsFromRow(release);
        for (const slot of facts.uiSlots) {
            const stored = await resolveStoredSlotLinkTx(params.tx, release.id, slot);
            if (stored?.artifactId !== params.artifactId) continue;
            if (!stored.artifact || stored.artifact.id !== params.artifactId || stored.artifact.accountId !== params.accountId
                || stored.release.accountId !== params.accountId || stored.release.pluginId !== release.pluginId
                || stored.release.version !== release.version || !isStoredLinkForDeclaredSlot(stored, slot)
                || !params.envelopes.every(envelope => isExactPlainUiArtifactArchive({ pluginId: release.pluginId, slot, envelope }))) return null;
            return { kind: 'pluginUi', pluginId: release.pluginId, slot };
        }
    } catch {
        return null;
    }
    return null;
}

type HostedArtifactKind = "ui" | "packageAsset";
type HostedArtifactPolicyError = "unsupported" | "notOptedIn" | "limitExceeded";

function hostedArtifactPolicyError(
    kind: HostedArtifactKind,
    error: HostedArtifactPolicyError,
): PluginAvailabilityOperationErrorCode {
    const errors = {
        ui: {
            unsupported: "plugin_ui_artifact_hosting_unsupported",
            notOptedIn: "plugin_ui_artifact_hosting_not_opted_in",
            limitExceeded: "plugin_ui_artifact_hosting_limit_exceeded",
        },
        packageAsset: {
            unsupported: "plugin_package_asset_hosting_unsupported",
            notOptedIn: "plugin_package_asset_hosting_not_opted_in",
            limitExceeded: "plugin_package_asset_hosting_limit_exceeded",
        },
    } as const;
    return errors[kind][error];
}

async function assertHostingIntentTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
    kind: HostedArtifactKind;
}>): Promise<void> {
    const intent = await params.tx.accountPluginIntent.findUnique({
        where: {
            accountId_pluginId: {
                accountId: params.accountId,
                pluginId: params.pluginId,
            },
        },
        select: {
            desiredVersion: true,
            enabled: true,
            offlineUiHosting: true,
        },
    });
    if (
        !intent
        || intent.desiredVersion !== params.version
        || !intent.enabled
        || intent.offlineUiHosting !== "enabled"
    ) {
        throw new PluginAvailabilityOperationError(
            hostedArtifactPolicyError(params.kind, "notOptedIn"),
        );
    }
}

async function assertHostingCapacityTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    capability: Extract<PluginUiArtifactHostingCapabilityV1, { enabled: true }>;
    candidateBytes: number;
    kind: HostedArtifactKind;
}>): Promise<void> {
    if (params.candidateBytes > params.capability.maxArtifactBytes) {
        throw new PluginAvailabilityOperationError(
            hostedArtifactPolicyError(params.kind, "limitExceeded"),
        );
    }
    const [uiArtifacts, packageAssetReleases] = await Promise.all([
        params.tx.accountPluginUiArtifact.findMany({
            where: { release: { accountId: params.accountId } },
            select: {
                artifact: {
                    select: {
                        header: true,
                        body: true,
                        dataEncryptionKey: true,
                    },
                },
            },
        }),
        params.tx.accountPluginRelease.findMany({
            where: {
                accountId: params.accountId,
                packageAssetArtifactId: { not: null },
            },
            select: {
                packageAssetArtifact: {
                    select: {
                        header: true,
                        body: true,
                        dataEncryptionKey: true,
                    },
                },
            },
        }),
    ]);
    const existing = [
        ...uiArtifacts.map((link) => link.artifact),
        ...packageAssetReleases.flatMap((release) => (
            release.packageAssetArtifact ? [release.packageAssetArtifact] : []
        )),
    ];
    const usedBytes = existing.reduce((total, artifact) => (
        total
        + artifact.header.byteLength
        + artifact.body.byteLength
        + artifact.dataEncryptionKey.byteLength
    ), 0);
    if (usedBytes + params.candidateBytes > params.capability.maxAccountBytes) {
        throw new PluginAvailabilityOperationError(
            hostedArtifactPolicyError(params.kind, "limitExceeded"),
        );
    }
}

type StoredMaterializationRow = Readonly<{
    serverIdentityId: string;
    machineId: string;
    materializationId: string;
    pluginId: string;
    version: string;
    sourceClass: string;
    portableRelease: boolean;
    archiveDigestSha256: string | null;
    uiArtifacts: unknown;
    enabled: boolean;
    trustState: string;
    observedAt: Date;
}>;

function materializationInputFromRow(row: StoredMaterializationRow) {
    return {
        serverIdentityId: row.serverIdentityId,
        machineId: row.machineId,
        materializationId: row.materializationId,
        pluginId: row.pluginId,
        version: row.version,
        sourceClass: row.sourceClass,
        portableRelease: row.portableRelease,
        ...(row.archiveDigestSha256 === null
            ? {}
            : { archiveDigestSha256: row.archiveDigestSha256 }),
        uiArtifacts: row.uiArtifacts,
        enabled: row.enabled,
        trustState: row.trustState,
        observedAt: row.observedAt.getTime(),
    };
}

function materializationFromRow(row: StoredMaterializationRow) {
    return PluginMachineMaterializationV1Schema.parse(materializationInputFromRow(row));
}

function safeMaterializationFromRow(row: StoredMaterializationRow) {
    return PluginMachineMaterializationV1Schema.safeParse(materializationInputFromRow(row));
}

function materializationSemanticSigningInput(
    materialization: PluginMachineMaterializationV1,
): string {
    const { observedAt: _observedAt, ...semanticMaterialization } = materialization;
    return createCanonicalJsonSigningInput(semanticMaterialization);
}

/**
 * Reconciles one complete replacement through the same semantic comparison
 * used for both snapshot equality and per-plugin hints. `observedAt` records
 * when the current semantic row was first observed; a fresh reporter timestamp
 * alone neither changes availability nor replaces that provenance.
 */
function reconcileMaterializationReplacement(input: Readonly<{
    current: readonly PluginMachineMaterializationV1[];
    next: PluginMachineMaterializationSnapshotV1;
}>): Readonly<{
    snapshot: PluginMachineMaterializationSnapshotV1;
    changedPluginIds: readonly string[];
}> {
    const current = normalizePluginMachineMaterializationSnapshotV1({
        serverIdentityId: input.next.serverIdentityId,
        machineId: input.next.machineId,
        materializations: input.current,
    });
    const currentByMaterializationId = new Map(
        current.materializations.map((row) => [row.materializationId, row]),
    );
    const nextByMaterializationId = new Map(
        input.next.materializations.map((row) => [row.materializationId, row]),
    );
    const changedPluginIds = new Set<string>();
    const reconciledMaterializations = input.next.materializations.map((nextRow) => {
        const currentRow = currentByMaterializationId.get(nextRow.materializationId);
        if (
            currentRow !== undefined
            && materializationSemanticSigningInput(currentRow)
                === materializationSemanticSigningInput(nextRow)
        ) {
            return Object.freeze({ ...nextRow, observedAt: currentRow.observedAt });
        }
        return nextRow;
    });

    for (const [materializationId, currentRow] of currentByMaterializationId) {
        const nextRow = nextByMaterializationId.get(materializationId);
        if (
            nextRow === undefined
            || materializationSemanticSigningInput(currentRow)
                !== materializationSemanticSigningInput(nextRow)
        ) {
            changedPluginIds.add(currentRow.pluginId);
            if (nextRow !== undefined) changedPluginIds.add(nextRow.pluginId);
        }
    }
    for (const [materializationId, nextRow] of nextByMaterializationId) {
        if (!currentByMaterializationId.has(materializationId)) {
            changedPluginIds.add(nextRow.pluginId);
        }
    }
    return {
        snapshot: normalizePluginMachineMaterializationSnapshotV1({
            ...input.next,
            materializations: reconciledMaterializations,
        }),
        changedPluginIds: [...changedPluginIds].sort(comparePluginIds),
    };
}

/**
 * Availability keeps immutable release facts at the Account release owner.
 * A portable machine report becomes claimable only when its exact installed
 * coordinate and UI slots correspond to the immutable Account release.
 */
async function hasExactAccountReleaseCorrespondenceTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    materialization: PluginMachineMaterializationV1;
}>): Promise<boolean> {
    if (!input.materialization.portableRelease) {
        return false;
    }
    const release = await resolveReleaseTx(
        input.tx,
        input.accountId,
        {
            pluginId: input.materialization.pluginId,
            version: input.materialization.version,
        },
    );
    if (!release) return false;
    try {
        return isExactPluginMachineMaterializationReleaseCorrespondenceV1(
            input.materialization,
            releaseFactsFromRow(release),
        );
    } catch {
        return false;
    }
}

export type CurrentClaimablePluginMachineMaterialization =
    | Readonly<{
        kind: "current";
        materialization: PluginMachineMaterializationV1;
        /**
         * Identity of the declaration this materialization executes: the
         * portable release archive digest, or the claimed manifest digest of
         * a release-less intent.
         */
        declarationDigestSha256: PluginUiArtifactDigestV1;
    }>
    | Readonly<{ kind: "notCurrent" }>;

/**
 * A daemon-selected (bundled/development) materialization has no portable
 * release. It is claimable only while the Account intent is a release-less
 * claim whose declaration names this exact version; a present-user release
 * selection displaces the claim.
 */
function releaseLessDeclarationDigestForMaterialization(
    materialization: PluginMachineMaterializationV1,
    intent: Readonly<{ desiredVersion: string | null; releaseLessDeclaration: unknown }> | null | undefined,
): PluginUiArtifactDigestV1 | null {
    if (materialization.portableRelease) return null;
    const declaration = readCurrentReleaseLessDeclarationV1(intent, materialization.pluginId);
    return declaration?.manifest.version === materialization.version
        ? declaration.manifestDigestSha256
        : null;
}

type ClaimableMachineRowV1 = Readonly<{
    pluginMaterializationRevision: bigint | null;
    operationProtocolCapabilities: unknown;
    operationProtocolCapabilitiesRevision: number | null;
    revokedAt: Date | null;
    replacedByMachineId: string | null;
}>;

function isClaimableMachineRowV1(
    machine: ClaimableMachineRowV1 | null,
    requiredMachineOperationCapability?: MachineOperationProtocolCapabilityNameV1,
): machine is ClaimableMachineRowV1 {
    return machine !== null
        && machine.pluginMaterializationRevision !== null
        && classifyMachineAvailabilityState(machine) === "available"
        && (
            requiredMachineOperationCapability === undefined
            || (
                typeof machine.operationProtocolCapabilitiesRevision === "number"
                && machine.operationProtocolCapabilitiesRevision >= 1
                && supportsMachineOperationProtocolCapabilityV1(
                    machine.operationProtocolCapabilities,
                    requiredMachineOperationCapability,
                )
            )
        );
}

/**
 * Classifies every current materialization for one authenticated machine
 * installation with a fixed number of database queries. Consumers that select
 * work across materializations use this projection instead of re-running the
 * exact currentness reader once per candidate.
 */
export async function resolveCurrentClaimablePluginMachineMaterializationsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    serverIdentityId: string;
    machineId: string;
    machineInstallationId: string;
    requiredMachineOperationCapability?: MachineOperationProtocolCapabilityNameV1;
}>): Promise<readonly PluginMachineMaterializationV1[]> {
    const machine = await params.tx.machine.findFirst({
        where: {
            accountId: params.accountId,
            id: params.machineId,
            installationId: params.machineInstallationId,
        },
        select: {
            pluginMaterializationRevision: true,
            operationProtocolCapabilities: true,
            operationProtocolCapabilitiesRevision: true,
            revokedAt: true,
            replacedByMachineId: true,
        },
    });
    if (!isClaimableMachineRowV1(machine, params.requiredMachineOperationCapability)) return [];

    const rows = await params.tx.pluginMachineMaterialization.findMany({
        where: {
            accountId: params.accountId,
            serverIdentityId: params.serverIdentityId,
            machineId: params.machineId,
            enabled: true,
            trustState: "trusted",
        },
        select: {
            serverIdentityId: true,
            machineId: true,
            materializationId: true,
            pluginId: true,
            version: true,
            sourceClass: true,
            portableRelease: true,
            archiveDigestSha256: true,
            uiArtifacts: true,
            enabled: true,
            trustState: true,
            observedAt: true,
        },
    });
    if (rows.length === 0) return [];

    const portableRows = rows.filter((row) => row.portableRelease);
    const nonPortablePluginIds = [...new Set(rows.flatMap((row) => (
        row.portableRelease ? [] : [row.pluginId]
    )))];
    const intents = nonPortablePluginIds.length === 0
        ? []
        : await params.tx.accountPluginIntent.findMany({
            where: { accountId: params.accountId, pluginId: { in: nonPortablePluginIds } },
            select: { pluginId: true, desiredVersion: true, releaseLessDeclaration: true },
        });
    const intentsByPluginId = new Map(intents.map((intent) => [intent.pluginId, intent] as const));
    const releases = portableRows.length === 0 ? [] : await params.tx.accountPluginRelease.findMany({
        where: {
            accountId: params.accountId,
            OR: portableRows.map((row) => ({ pluginId: row.pluginId, version: row.version })),
        },
        select: {
            id: true,
            accountId: true,
            pluginId: true,
            version: true,
            archiveDigestSha256: true,
            normalizedManifest: true,
            collectionContracts: true,
            uiSlots: true,
            packageAssetArchive: true,
        },
    });
    const releasesByRef = new Map(
        releases.map((release) => [`${release.pluginId}\0${release.version}`, release] as const),
    );
    return rows.flatMap((row) => {
        try {
            const materialization = materializationFromRow(row);
            if (!materialization.portableRelease) {
                return releaseLessDeclarationDigestForMaterialization(
                    materialization,
                    intentsByPluginId.get(materialization.pluginId),
                ) === null ? [] : [materialization];
            }
            const release = releasesByRef.get(`${row.pluginId}\0${row.version}`);
            return release
                && isExactPluginMachineMaterializationReleaseCorrespondenceV1(
                    materialization,
                    releaseFactsFromRow(release),
                )
                ? [materialization]
                : [];
        } catch {
            return [];
        }
    });
}

/**
 * Revalidates the machine installation and its exact current Availability row
 * within the caller's transaction. Consumers use this for admission only;
 * this owner deliberately does not choose an execution source or target.
 */
export async function resolveCurrentClaimablePluginMachineMaterializationTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    serverIdentityId: string;
    machineId: string;
    machineInstallationId: string;
    materializationId: string;
    pluginId: string;
    version: string;
    requiredMachineOperationCapability?: MachineOperationProtocolCapabilityNameV1;
}>): Promise<CurrentClaimablePluginMachineMaterialization> {
    const machine = await params.tx.machine.findFirst({
        where: {
            accountId: params.accountId,
            id: params.machineId,
            installationId: params.machineInstallationId,
        },
        select: {
            pluginMaterializationRevision: true,
            operationProtocolCapabilities: true,
            operationProtocolCapabilitiesRevision: true,
            revokedAt: true,
            replacedByMachineId: true,
        },
    });
    if (!isClaimableMachineRowV1(machine, params.requiredMachineOperationCapability)) {
        return { kind: "notCurrent" };
    }

    const row = await params.tx.pluginMachineMaterialization.findFirst({
        where: {
            accountId: params.accountId,
            serverIdentityId: params.serverIdentityId,
            machineId: params.machineId,
            materializationId: params.materializationId,
            pluginId: params.pluginId,
            version: params.version,
        },
        select: {
            serverIdentityId: true,
            machineId: true,
            materializationId: true,
            pluginId: true,
            version: true,
            sourceClass: true,
            portableRelease: true,
            archiveDigestSha256: true,
            uiArtifacts: true,
                    enabled: true,
            trustState: true,
            observedAt: true,
        },
    });
    if (!row) return { kind: "notCurrent" };

    let materialization: PluginMachineMaterializationV1;
    try {
        materialization = materializationFromRow(row);
    } catch {
        return { kind: "notCurrent" };
    }
    if (!materialization.enabled || materialization.trustState !== "trusted") {
        return { kind: "notCurrent" };
    }
    if (!materialization.portableRelease) {
        const intent = await params.tx.accountPluginIntent.findUnique({
            where: {
                accountId_pluginId: {
                    accountId: params.accountId,
                    pluginId: materialization.pluginId,
                },
            },
            select: { desiredVersion: true, releaseLessDeclaration: true },
        });
        const declarationDigestSha256 = releaseLessDeclarationDigestForMaterialization(
            materialization,
            intent,
        );
        return declarationDigestSha256 === null
            ? { kind: "notCurrent" }
            : { kind: "current", materialization, declarationDigestSha256 };
    }
    if (
        materialization.archiveDigestSha256 !== undefined
        && await hasExactAccountReleaseCorrespondenceTx({
            tx: params.tx,
            accountId: params.accountId,
            materialization,
        })
    ) {
        return {
            kind: "current",
            materialization,
            declarationDigestSha256: materialization.archiveDigestSha256,
        };
    }
    return { kind: "notCurrent" };
}

export type PluginAvailabilityOperations = Readonly<{
    readRelease(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityReleaseReadActionOutputV1>;
    publishRelease(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityReleasePublishActionOutputV1>;
    reportMaterializations(input: Readonly<{
        accountId: string;
        publisherMachineId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityMaterializationsReportActionOutputV1>;
    readMaterializations(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityMaterializationsReadActionOutputV1>;
    listIntentIds(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityIntentsListActionOutputV1>;
    readIntent(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityIntentReadActionOutputV1>;
    setIntent(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityIntentSetActionOutputV1>;
    claimCollectionWriters(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityCollectionWritersClaimActionOutputV1>;
    publishUiArtifact(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityUiArtifactPublishActionOutputV1>;
    readUiArtifact(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityUiArtifactReadActionOutputV1>;
    publishPackageAsset(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityPackageAssetPublishActionOutputV1>;
    readPackageAsset(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityPackageAssetReadActionOutputV1>;
    removePackageAsset(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityPackageAssetRemoveActionOutputV1>;
    issueBrowserArtifactFrame(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1>;
    readBrowserArtifactFrame(input: Readonly<{
        capability: string;
        requestPath: string;
        request: Readonly<{
            protocol?: unknown;
            host?: unknown;
        }>;
    }>): Promise<PluginAvailabilityBrowserArtifactFrameResponse>;
    removeUiArtifact(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityUiArtifactRemoveActionOutputV1>;
}>;

export function createPluginAvailabilityOperations(options: Readonly<{
    resolveHostingCapability?: () => Awaitable<PluginUiArtifactHostingCapabilityV1>;
    resolveServerIdentityId?: () => Promise<string>;
}> = {}): PluginAvailabilityOperations {
    const resolveConfiguredHostingCapability = options.resolveHostingCapability
        ?? (() => resolvePluginUiArtifactHostingCapability(process.env));
    const resolveHostingCapability = async (): Promise<PluginUiArtifactHostingCapabilityV1> => (
        PluginUiArtifactHostingCapabilityV1Schema.parse(
            await resolveConfiguredHostingCapability(),
        )
    );
    const resolveServerIdentityId =
        options.resolveServerIdentityId ?? getOrCreateServerIdentityId;

    async function readRelease(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityReleaseReadActionOutputV1> {
        const input = PluginAvailabilityReleaseReadActionInputV1Schema.parse(params.input);
        return await inTx(async (tx) => {
            // The target coordinate and cursor share one committed snapshot;
            // selection intent has no role in this immutable release read.
            const [account, release] = await Promise.all([
                tx.account.findUnique({
                    where: { id: params.accountId },
                    select: { seq: true },
                }),
                resolveReleaseTx(tx, params.accountId, input.release),
            ]);
            if (!account) {
                throw new PluginAvailabilityOperationError("plugin_account_not_found");
            }
            if (!release) {
                throw new PluginAvailabilityOperationError("plugin_release_not_found");
            }
            return PluginAvailabilityReleaseReadActionOutputV1Schema.parse({
                availabilityCursor: account.seq,
                facts: releaseFactsFromRow(release),
            });
        });
    }

    async function publishRelease(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityReleasePublishActionOutputV1> {
        const input = PluginAvailabilityReleasePublishActionInputV1Schema.parse(params.input);
        const facts = normalizePluginReleaseFactsV1(input.facts);

        const publish = async (tx: Tx): Promise<PluginAvailabilityReleasePublishActionOutputV1> => {
            await materializeReleaseCollectionContractsTx(tx, facts);
            const existing = await resolveReleaseTx(tx, params.accountId, facts.ref);
            if (existing) {
                if (!pluginReleaseFactsEqualV1(releaseFactsFromRow(existing), facts)) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_release_content_conflict",
                    );
                }
                return { facts, outcome: "rejoined" };
            }

            await tx.accountPluginRelease.create({
                data: {
                    accountId: params.accountId,
                    pluginId: facts.ref.pluginId,
                    version: facts.ref.version,
                    archiveDigestSha256: facts.archiveDigestSha256,
                    normalizedManifest: toPrismaJson(facts.normalizedManifest),
                    collectionContracts: toPrismaJson(facts.collectionContracts),
                    uiSlots: toPrismaJson(facts.uiSlots),
                    packageAssetArchive: toPrismaJson(facts.packageAssetArchive),
                },
            });
            await markAvailabilityChangedTx(tx, params.accountId, facts.ref.pluginId);
            return { facts, outcome: "created" };
        };

        try {
            return await inTx(publish);
        } catch (error) {
            if (!isPrismaErrorCode(error, "P2002")) throw error;
            const existing = await db.accountPluginRelease.findUnique({
                where: {
                    accountId_pluginId_version: {
                        accountId: params.accountId,
                        pluginId: facts.ref.pluginId,
                        version: facts.ref.version,
                    },
                },
                select: {
                    id: true,
                    accountId: true,
                    pluginId: true,
                    version: true,
                    archiveDigestSha256: true,
                    normalizedManifest: true,
                    collectionContracts: true,
                    uiSlots: true,
                    packageAssetArchive: true,
                },
            });
            if (!existing) throw error;
            if (!pluginReleaseFactsEqualV1(releaseFactsFromRow(existing), facts)) {
                throw new PluginAvailabilityOperationError(
                    "plugin_release_content_conflict",
                );
            }
            return { facts, outcome: "rejoined" };
        }
    }

    async function reportMaterializations(params: Readonly<{
        accountId: string;
        publisherMachineId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityMaterializationsReportActionOutputV1> {
        const input = PluginAvailabilityMaterializationsReportActionInputV1Schema.parse(params.input);
        const snapshot = normalizePluginMachineMaterializationSnapshotV1(input.snapshot);
        if (snapshot.machineId !== params.publisherMachineId) {
            throw new PluginAvailabilityOperationError(
                "plugin_materialization_machine_mismatch",
            );
        }
        const serverIdentityId = await resolveServerIdentityId();
        if (snapshot.serverIdentityId !== serverIdentityId) {
            throw new PluginAvailabilityOperationError(
                "plugin_materialization_server_identity_mismatch",
            );
        }

        return await inTx(async (tx) => {
            const machine = await tx.machine.findFirst({
                where: {
                    accountId: params.accountId,
                    id: params.publisherMachineId,
                },
                select: { pluginMaterializationRevision: true },
            });
            if (!machine) {
                throw new PluginAvailabilityOperationError(
                    "plugin_materialization_machine_mismatch",
                );
            }
            const currentRows = await tx.pluginMachineMaterialization.findMany({
                where: {
                    accountId: params.accountId,
                    machineId: params.publisherMachineId,
                },
                select: {
                    serverIdentityId: true,
                    machineId: true,
                    materializationId: true,
                    pluginId: true,
                    version: true,
                    sourceClass: true,
                    portableRelease: true,
                    archiveDigestSha256: true,
                    uiArtifacts: true,
                    enabled: true,
                    trustState: true,
                    observedAt: true,
                },
            });
            const currentRevision = machine.pluginMaterializationRevision === null
                ? null
                : Number(machine.pluginMaterializationRevision);
            const parsedCurrentRows = currentRows.map((row) => ({
                row,
                parsed: safeMaterializationFromRow(row),
            }));
            const unreadablePluginIds = new Set(parsedCurrentRows
                .filter((entry) => !entry.parsed.success)
                .map((entry) => entry.row.pluginId));
            const currentMaterializations = parsedCurrentRows.flatMap((entry) => (
                entry.parsed.success ? [entry.parsed.data] : []
            ));
            // Persisted materializations are a refreshable daemon projection.
            // Do not interpret a superseded or corrupt row shape, but also do
            // not let it prevent the current authenticated full-body producer
            // from replacing it after the existing report CAS is satisfied.
            if (
                unreadablePluginIds.size > 0
                && input.expectedRevision !== currentRevision
            ) {
                return { revision: currentRevision, outcome: "conflict" };
            }
            const replacement = reconcileMaterializationReplacement({
                current: currentMaterializations,
                next: snapshot,
            });
            if (
                unreadablePluginIds.size === 0
                && currentRevision !== null
                && replacement.changedPluginIds.length === 0
            ) {
                return { revision: currentRevision, outcome: "rejoined" };
            }
            if (input.expectedRevision !== currentRevision) {
                return { revision: currentRevision, outcome: "conflict" };
            }
            const nextRevision = (currentRevision ?? 0) + 1;

            const retainedMaterializationIds = new Set(
                replacement.snapshot.materializations.map((row) => row.materializationId),
            );
            const replacedMaterializationIds = currentRows
                .map((row) => row.materializationId)
                .filter((materializationId) => !retainedMaterializationIds.has(materializationId));
            if (replacedMaterializationIds.length > 0) {
                await tx.automationEventSourceStatus.deleteMany({
                    where: {
                        reporterMachineId: params.publisherMachineId,
                        reporterMaterializationId: { in: replacedMaterializationIds },
                    },
                });
                await tx.automationEventSourceCatalogStatus.deleteMany({
                    where: {
                        accountId: params.accountId,
                        reporterMachineId: params.publisherMachineId,
                        reporterMaterializationId: { in: replacedMaterializationIds },
                    },
                });
            }
            await tx.pluginMachineMaterialization.deleteMany({
                where: {
                    accountId: params.accountId,
                    machineId: params.publisherMachineId,
                },
            });
            if (replacement.snapshot.materializations.length > 0) {
                await tx.pluginMachineMaterialization.createMany({
                    data: replacement.snapshot.materializations.map((row) => ({
                        accountId: params.accountId,
                        serverIdentityId: row.serverIdentityId,
                        machineId: row.machineId,
                        materializationId: row.materializationId,
                        pluginId: row.pluginId,
                        version: row.version,
                        sourceClass: row.sourceClass,
                        portableRelease: row.portableRelease,
                        archiveDigestSha256: row.archiveDigestSha256 ?? null,
                        uiArtifacts: toPrismaJson(row.uiArtifacts),
                        enabled: row.enabled,
                        trustState: row.trustState,
                        observedAt: new Date(row.observedAt),
                    })),
                });
            }
            await tx.machine.update({
                where: {
                    accountId_id: {
                        accountId: params.accountId,
                        id: params.publisherMachineId,
                    },
                },
                data: {
                    pluginMaterializationRevision: BigInt(nextRevision),
                },
            });
            const changedPluginIds = new Set([
                ...replacement.changedPluginIds,
                ...unreadablePluginIds,
            ]);
            for (const pluginId of [...changedPluginIds].sort(comparePluginIds)) {
                await markAvailabilityChangedTx(tx, params.accountId, pluginId);
            }
            return { revision: nextRevision, outcome: "replaced" };
        });
    }

    async function readMaterializations(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityMaterializationsReadActionOutputV1> {
        PluginAvailabilityMaterializationsReadActionInputV1Schema.parse(params.input);
        const serverIdentityId = await resolveServerIdentityId();
        // The cursor fences the whole UI projection, so it and its inventory
        // must come from one committed snapshot.
        const { availabilityCursor, machines } = await inTx(async (tx) => {
            const [account, machines] = await Promise.all([
                tx.account.findUnique({
                    where: { id: params.accountId },
                    select: { seq: true },
                }),
                tx.machine.findMany({
                    // Only machines the claim path would accept (`isClaimableMachineRowV1`):
                    // a revoked or replaced machine's retained rows are not current availability.
                    where: {
                        accountId: params.accountId,
                        pluginMaterializationRevision: { not: null },
                        revokedAt: null,
                        replacedByMachineId: null,
                    },
                    select: {
                        id: true,
                        pluginMaterializationRevision: true,
                        pluginMaterializations: {
                            select: {
                                serverIdentityId: true,
                                machineId: true,
                                materializationId: true,
                                pluginId: true,
                                version: true,
                                sourceClass: true,
                                portableRelease: true,
                                archiveDigestSha256: true,
                                uiArtifacts: true,
                                enabled: true,
                                trustState: true,
                                observedAt: true,
                            },
                            orderBy: [{ pluginId: "asc" }, { materializationId: "asc" }],
                        },
                    },
                    orderBy: { id: "asc" },
                }),
            ]);
            if (!account) {
                throw new PluginAvailabilityOperationError("plugin_account_not_found");
            }
            return { availabilityCursor: account.seq, machines };
        });
        const unreadableMachines: Array<Readonly<{
            machineId: string;
            materializationCount: number;
            pluginIds: readonly string[];
        }>> = [];
        const snapshots = machines.flatMap((machine) => {
            const parsedRows = machine.pluginMaterializations.map((row) => ({
                row,
                parsed: safeMaterializationFromRow(row),
            }));
            const unreadableRows = parsedRows.filter((entry) => !entry.parsed.success);
            if (unreadableRows.length > 0) {
                unreadableMachines.push({
                    machineId: machine.id,
                    materializationCount: unreadableRows.length,
                    pluginIds: [...new Set(unreadableRows.map((entry) => entry.row.pluginId))]
                        .sort(comparePluginIds),
                });
            }
            const materializations = parsedRows.flatMap((entry) => (
                entry.parsed.success ? [entry.parsed.data] : []
            ));
            if (materializations.length === 0 && unreadableRows.length > 0) return [];
            return [PluginMachineMaterializationSnapshotV1Schema.parse({
                serverIdentityId: materializations[0]?.serverIdentityId ?? serverIdentityId,
                machineId: machine.id,
                materializations,
            })];
        });
        if (unreadableMachines.length > 0) {
            warn({
                module: "plugin-availability",
                unreadableMachines,
            }, "Unreadable refreshable plugin materializations were omitted from Account availability");
        }
        return { availabilityCursor, snapshots };
    }

    async function listIntentIds(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityIntentsListActionOutputV1> {
        PluginAvailabilityIntentsListActionInputV1Schema.parse(params.input);
        return await inTx(async (tx) => {
            const [account, rows] = await Promise.all([
                tx.account.findUnique({
                    where: { id: params.accountId },
                    select: { seq: true },
                }),
                // Release-less claims are intents too: their Collection writer
                // pointers must be discoverable without a machine hint.
                tx.accountPluginIntent.findMany({
                    where: { accountId: params.accountId },
                    select: { pluginId: true },
                    orderBy: { pluginId: "asc" },
                    take: MAX_PLUGIN_ACCOUNT_AVAILABILITY_INTENT_IDS + 1,
                }),
            ]);
            if (!account) {
                throw new PluginAvailabilityOperationError("plugin_account_not_found");
            }
            if (rows.length > MAX_PLUGIN_ACCOUNT_AVAILABILITY_INTENT_IDS) {
                throw new PluginAvailabilityOperationError(
                    "plugin_availability_intent_discovery_limit_exceeded",
                );
            }
            const pluginIds = rows.map((row) => row.pluginId).sort(comparePluginIds);
            const output = {
                availabilityCursor: account.seq,
                pluginIds,
            };
            if (
                Buffer.byteLength(JSON.stringify(output), "utf8")
                > MAX_PLUGIN_ACCOUNT_AVAILABILITY_INTENT_LIST_BYTES
            ) {
                throw new PluginAvailabilityOperationError(
                    "plugin_availability_intent_discovery_limit_exceeded",
                );
            }
            return PluginAvailabilityIntentsListActionOutputV1Schema.parse(output);
        });
    }

    async function readIntent(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityIntentReadActionOutputV1> {
        const input = PluginAvailabilityIntentReadActionInputV1Schema.parse(params.input);
        const [capability, current] = await Promise.all([
            resolveHostingCapability(),
            // The cursor fences the whole UI projection, so it and the selected
            // intent/release facts must come from one committed snapshot.
            inTx(async (tx) => {
                const [account, intentRow] = await Promise.all([
                    tx.account.findUnique({
                        where: { id: params.accountId },
                        select: { seq: true },
                    }),
                    tx.accountPluginIntent.findUnique({
                        where: {
                            accountId_pluginId: {
                                accountId: params.accountId,
                                pluginId: input.pluginId,
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
                    }),
                ]);
                if (!account) {
                    throw new PluginAvailabilityOperationError("plugin_account_not_found");
                }
                const release = intentRow?.desiredVersion
                    ? await tx.accountPluginRelease.findUnique({
                        where: {
                            accountId_pluginId_version: {
                                accountId: params.accountId,
                                pluginId: input.pluginId,
                                version: intentRow.desiredVersion,
                            },
                        },
                        select: {
                            id: true,
                            accountId: true,
                            pluginId: true,
                            version: true,
                            archiveDigestSha256: true,
                            normalizedManifest: true,
                            collectionContracts: true,
                            uiSlots: true,
                            packageAssetArchive: true,
                            uiArtifacts: {
                                select: {
                                    contributionId: true,
                                    tier: true,
                                    platform: true,
                                    artifactId: true,
                                    artifactDigest: true,
                                    compatibility: true,
                                    release: {
                                        select: {
                                            accountId: true,
                                            pluginId: true,
                                            version: true,
                                        },
                                    },
                                },
                                orderBy: [{ contributionId: "asc" }, { tier: "asc" }, { platform: "asc" }],
                            },
                        },
                    })
                    : null;
                const packageAsset = release
                    ? await resolveStoredPackageAssetLinkTx(tx, release.id)
                    : null;
                return { availabilityCursor: account.seq, intentRow, release, packageAsset };
            }),
        ]);
        const intent = current.intentRow ? intentFromRow(current.intentRow) : null;
        // Releases written before package assets have no immutable descriptor.
        // They are intentionally unavailable to the current release-facts ABI
        // rather than being populated with a guessed empty archive.
        const facts = current.release?.packageAssetArchive === null
            ? null
            : current.release
                ? releaseFactsFromRow(current.release)
                : null;
        return {
            availabilityCursor: current.availabilityCursor,
            hostingCapability: capability,
            intent,
            release: facts,
            uiArtifacts: facts ? current.release!.uiArtifacts.map((row) => {
                const slot = facts.uiSlots.find((candidate) => (
                    candidate.contributionId === row.contributionId
                    && candidate.tier === row.tier
                    && candidate.platform === row.platform
                ));
                if (!slot || !isStoredLinkForDeclaredSlot(row, slot)) {
                    throw new PluginAvailabilityOperationError("plugin_release_content_conflict");
                }
                return linkFromRow(row, slot);
            }) : [],
            packageAssets: facts && current.packageAsset
                ? [packageAssetLinkFromRow(current.packageAsset, facts.packageAssetArchive)]
                    .filter((link): link is PluginAccountPluginPackageAssetLinkV1 => link !== null)
                : [],
        };
    }

    async function setIntent(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityIntentSetActionOutputV1> {
        const input = PluginAvailabilityIntentSetActionInputV1Schema.parse(params.input);
        const expectedRevision = parseExpectedIntentRevision(input.expectedRevision);

        try {
            const outcome = await inTx(async (tx) => {
                const release = input.desiredVersion === null
                    ? null
                    : await resolveReleaseTx(tx, params.accountId, {
                        pluginId: input.pluginId,
                        version: input.desiredVersion,
                    });
                if (input.desiredVersion !== null && !release) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_release_not_found",
                    );
                }
                if (
                    (release === null && input.writableCollections.length > 0)
                    || (release !== null && !collectionContractsEqual(
                        releaseFactsFromRow(release).collectionContracts,
                        input.writableCollections,
                    ))
                ) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_release_collection_contract_mismatch",
                    );
                }
                const current = await tx.accountPluginIntent.findUnique({
                    where: {
                        accountId_pluginId: {
                            accountId: params.accountId,
                            pluginId: input.pluginId,
                        },
                    },
                    select: INTENT_ROW_SELECT,
                });
                // Reject stale callers before asking Data to inspect or
                // promote candidate work. The final revision-fenced update
                // remains the concurrent CAS authority below.
                if (
                    (current === null && expectedRevision !== null)
                    || (
                        current !== null
                        && (expectedRevision === null || current.revision !== expectedRevision)
                    )
                ) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_intent_revision_conflict",
                    );
                }
                // An identical body is an idempotent rejoin: it is not a
                // semantic change, so it writes nothing, keeps the revision,
                // and does not advance Account.seq.
                if (current !== null) {
                    const currentIntent = intentFromRow(current);
                    if (
                        currentIntent.desiredVersion === input.desiredVersion
                        && currentIntent.enabled === input.enabled
                        && currentIntent.offlineUiHosting === input.offlineUiHosting
                        && collectionContractsEqual(currentIntent.writableCollections, input.writableCollections)
                    ) {
                        return { intent: currentIntent };
                    }
                }
                return await transitionIntentTx({
                    tx,
                    accountId: params.accountId,
                    pluginId: input.pluginId,
                    current,
                    next: {
                        desiredVersion: input.desiredVersion,
                        enabled: input.enabled,
                        offlineUiHosting: input.offlineUiHosting,
                        writableCollections: input.writableCollections,
                        // A present-user release selection displaces the
                        // claim; staying release-less keeps what the host
                        // claimed.
                        releaseLessDeclaration: input.desiredVersion === null
                            ? readCurrentReleaseLessDeclarationV1(current, input.pluginId)
                            : null,
                    },
                });
            });
            return outcome;
        } catch (error) {
            throw intentTransitionError(error);
        }
    }

    /**
     * The release-less arm of the intent owner. A daemon-selected plugin
     * (bundled, trusted development, drop-in) has no portable release, so its
     * host claims the Account intent with its own admitted manifest. The server
     * rebuilds every Collection contract and digest from that manifest and
     * stores it as the release-less declaration webhook and Event currentness
     * read. Both merge monotonically inside the transaction: Collections keep
     * the higher schemaVersion per collection, and a lower declaration version
     * never replaces the stored one, so a lagging machine never flips the
     * pointer back. An equal claim is an idempotent rejoin, and a present-user
     * release selection is never overridden.
     */
    async function claimCollectionWriters(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityCollectionWritersClaimActionOutputV1> {
        const { manifest } = PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse(params.input);
        const pluginId = manifest.id;
        try {
            return await inTx(async (tx) => {
                let claimed: readonly PluginCollectionContractRefV1[];
                try {
                    claimed = await materializePluginCollectionContractsTx({
                        tx,
                        pluginId,
                        contributions: manifest.contributes.accountCollections,
                    });
                } catch (error) {
                    if (
                        error instanceof PluginCollectionContractMaterializationError
                        && error.code === "collection_contract_invalid"
                    ) {
                        throw new PluginAvailabilityOperationError(
                            "plugin_availability_invalid_request",
                        );
                    }
                    throw error;
                }
                const current = await tx.accountPluginIntent.findUnique({
                    where: {
                        accountId_pluginId: {
                            accountId: params.accountId,
                            pluginId,
                        },
                    },
                    select: INTENT_ROW_SELECT,
                });
                const currentIntent = current ? intentFromRow(current) : null;
                if (currentIntent !== null && currentIntent.desiredVersion !== null) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_intent_release_selected",
                    );
                }
                const writers = new Map(
                    (currentIntent?.writableCollections ?? []).map((ref) => [ref.collectionId, ref]),
                );
                for (const ref of claimed) {
                    const incumbent = writers.get(ref.collectionId);
                    if (!incumbent || incumbent.schemaVersion < ref.schemaVersion) {
                        writers.set(ref.collectionId, ref);
                    } else if (
                        incumbent.schemaVersion === ref.schemaVersion
                        && incumbent.contractDigest !== ref.contractDigest
                    ) {
                        // The author changed a contract without bumping its
                        // schemaVersion; rows would silently mix schemas.
                        throw new PluginAvailabilityOperationError(
                            "plugin_collection_contract_conflict",
                        );
                    }
                }
                const writableCollections = [...writers.values()];
                const currentDeclaration = readCurrentReleaseLessDeclarationV1(current, pluginId);
                const releaseLessDeclaration = currentDeclaration !== null
                    && semver.lt(manifest.version, currentDeclaration.manifest.version)
                    ? currentDeclaration
                    : createReleaseLessDeclarationV1(manifest);
                if (
                    currentIntent !== null
                    && collectionContractsEqual(currentIntent.writableCollections, writableCollections)
                    && currentDeclaration?.manifestDigestSha256 === releaseLessDeclaration.manifestDigestSha256
                ) {
                    return { intent: currentIntent };
                }
                return await transitionIntentTx({
                    tx,
                    accountId: params.accountId,
                    pluginId,
                    current,
                    next: {
                        desiredVersion: null,
                        enabled: currentIntent?.enabled ?? true,
                        offlineUiHosting: currentIntent?.offlineUiHosting ?? "disabled",
                        writableCollections,
                        releaseLessDeclaration,
                    },
                });
            });
        } catch (error) {
            throw intentTransitionError(error);
        }
    }

    async function publishUiArtifact(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityUiArtifactPublishActionOutputV1> {
        const input = PluginAvailabilityUiArtifactPublishActionInputV1Schema.parse(params.input);
        const capability = await resolveHostingCapability();
        if (!capability.enabled) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_hosting_unsupported",
            );
        }
        const artifact = decodeArtifactEnvelope(input.artifact);
        if (!isExactPlainUiArtifactArchive({
            pluginId: input.release.pluginId,
            slot: input.slot,
            envelope: artifact,
        })) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_invalid_content",
            );
        }

        const publish = async (tx: Tx, rejoinOnly = false): Promise<PluginAvailabilityUiArtifactPublishActionOutputV1> => {
            const release = await resolveReleaseTx(tx, params.accountId, input.release);
            if (!release) {
                throw new PluginAvailabilityOperationError("plugin_release_not_found");
            }
            const facts = releaseFactsFromRow(release);
            const declaredSlot = facts.uiSlots.find((slot) => (
                slot.contributionId === input.slot.contributionId
                && slot.artifactId === input.slot.artifactId
                && slot.tier === input.slot.tier
                && slot.platform === input.slot.platform
            ));
            if (!declaredSlot || !slotsEqual(declaredSlot, input.slot)) {
                throw new PluginAvailabilityOperationError(
                    "plugin_release_content_conflict",
                );
            }
            await assertHostingIntentTx({
                tx,
                accountId: params.accountId,
                pluginId: release.pluginId,
                version: release.version,
                kind: "ui",
            });

            const existingLink = await resolveStoredSlotLinkTx(tx, release.id, input.slot);
            if (existingLink) {
                if (!isStoredLinkForDeclaredSlot(existingLink, declaredSlot)) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_release_content_conflict",
                    );
                }
                if (
                    !await isStoredHostedArtifactRejoin({
                        tx,
                        accountId: params.accountId,
                        artifactId: input.accountArtifactId,
                        link: existingLink,
                        envelope: artifact,
                    })
                ) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_ui_artifact_conflict",
                    );
                }
                return { outcome: "rejoined", link: linkFromRow(existingLink, declaredSlot) };
            }

            if (rejoinOnly) {
                throw new PluginAvailabilityOperationError("plugin_ui_artifact_conflict");
            }

            const existingArtifact = await tx.artifact.findUnique({
                where: { id: input.accountArtifactId },
                select: { id: true },
            });
            if (existingArtifact) {
                throw new PluginAvailabilityOperationError(
                    "plugin_ui_artifact_conflict",
                );
            }
            await assertHostingCapacityTx({
                tx,
                accountId: params.accountId,
                capability,
                candidateBytes: artifactEnvelopeByteLength(artifact),
                kind: "ui",
            });
            const created = await createArtifactTx(tx, {
                actorUserId: params.accountId,
                artifactId: input.accountArtifactId,
                header: artifact.header,
                body: artifact.body,
                dataEncryptionKey: artifact.dataEncryptionKey,
                markChanged: async (artifactId) => {
                    await tx.accountPluginUiArtifact.create({
                        data: {
                            releaseId: release.id,
                            ...slotCoordinates(declaredSlot),
                            artifactId,
                            artifactDigest: declaredSlot.artifactDigest,
                            compatibility: toPrismaJson({ hostUiApiRange: declaredSlot.hostUiApiRange }),
                        },
                    });
                    return await markAvailabilityChangedTx(
                        tx,
                        params.accountId,
                        release.pluginId,
                    );
                },
            });
            if (!created.ok) {
                if (created.error === "invalid-params") {
                    throw new PluginAvailabilityOperationError(
                        "plugin_ui_artifact_invalid_content",
                    );
                }
                throw new PluginAvailabilityOperationError(
                    "plugin_ui_artifact_conflict",
                );
            }
            if (!created.didWrite) {
                throw new PluginAvailabilityOperationError(
                    "plugin_ui_artifact_conflict",
                );
            }
            const createdLink = await resolveStoredSlotLinkTx(tx, release.id, declaredSlot);
            if (!createdLink || !isStoredLinkForDeclaredSlot(createdLink, declaredSlot)) {
                throw new PluginAvailabilityOperationError(
                    "plugin_ui_artifact_conflict",
                );
            }
            return { outcome: "created", link: linkFromRow(createdLink, declaredSlot) };
        };

        try {
            return await inTx(publish);
        } catch (error) {
            if (!isPrismaErrorCode(error, "P2002")) throw error;
            // A uniqueness race rejoins through the same transaction-local
            // release, intent, classification and Account-mode checks.
            return await inTx((tx) => publish(tx, true));
        }
    }

    async function readUiArtifact(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityUiArtifactReadActionOutputV1> {
        const input = PluginAvailabilityUiArtifactReadActionInputV1Schema.parse(params.input);
        const capability = await resolveHostingCapability();
        if (!capability.enabled) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_hosting_unsupported",
            );
        }
        const [release, account] = await Promise.all([
            db.accountPluginRelease.findUnique({
            where: {
                accountId_pluginId_version: {
                    accountId: params.accountId,
                    pluginId: input.release.pluginId,
                    version: input.release.version,
                },
            },
            select: {
                id: true,
                accountId: true,
                pluginId: true,
                version: true,
                archiveDigestSha256: true,
                normalizedManifest: true,
                collectionContracts: true,
                uiSlots: true,
                packageAssetArchive: true,
            },
            }),
            db.account.findUnique({
                where: { id: params.accountId },
                select: { encryptionMode: true },
            }),
        ]);
        if (!release) {
            throw new PluginAvailabilityOperationError("plugin_ui_artifact_not_found");
        }
        const accountMode = account
            ? resolveEffectiveAccountEncryptionModeFromAccountRow(account)
            : null;
        if (accountMode?.status !== "ready") {
            throw new PluginAvailabilityOperationError("plugin_ui_artifact_invalid_content");
        }
        if (!("purpose" in input)) {
            await inTx(async (tx) => {
                await assertHostingIntentTx({
                    tx,
                    accountId: params.accountId,
                    pluginId: release.pluginId,
                    version: release.version,
                    kind: "ui",
                });
            });
        }
        const link = await db.accountPluginUiArtifact.findUnique({
            where: {
                releaseId_contributionId_tier_platform: {
                    releaseId: release.id,
                    contributionId: input.contributionId,
                    tier: input.tier,
                    platform: input.platform,
                },
            },
            select: {
                contributionId: true,
                tier: true,
                platform: true,
                artifactId: true,
                artifactDigest: true,
                compatibility: true,
                release: {
                    select: {
                        accountId: true,
                        pluginId: true,
                        version: true,
                    },
                },
                artifact: {
                    select: {
                        id: true,
                        accountId: true,
                        header: true,
                        headerVersion: true,
                        body: true,
                        bodyVersion: true,
                        dataEncryptionKey: true,
                        seq: true,
                    },
                },
            },
        });
        if (!link || link.artifact.accountId !== params.accountId) {
            throw new PluginAvailabilityOperationError("plugin_ui_artifact_not_found");
        }
        const declaredSlot = releaseFactsFromRow(release).uiSlots.find((slot) => (
            slot.contributionId === input.contributionId
            && slot.artifactId === input.artifactId
            && slot.tier === input.tier
            && slot.platform === input.platform
        ));
        if (!declaredSlot || !isStoredLinkForDeclaredSlot(link, declaredSlot)) {
            throw new PluginAvailabilityOperationError(
                "plugin_release_content_conflict",
            );
        }
        if (
            "purpose" in input
            && input.expectedArtifactDigest !== link.artifactDigest
        ) {
            throw new PluginAvailabilityOperationError(
                "plugin_release_content_conflict",
            );
        }
        const opened = openArtifactStoredContentPair({
            accountId: params.accountId,
            artifactId: link.artifact.id,
            mode: accountMode.mode,
            dataEncryptionKey: link.artifact.dataEncryptionKey,
            header: link.artifact.header,
            body: link.artifact.body,
        });
        if (!opened) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_invalid_content",
            );
        }
        const artifact: PluginAvailabilityArtifactReadEnvelopeV1 = {
            header: privacyKit.encodeBase64(opened.header),
            headerVersion: link.artifact.headerVersion,
            body: privacyKit.encodeBase64(opened.body),
            bodyVersion: link.artifact.bodyVersion,
            dataEncryptionKey: privacyKit.encodeBase64(link.artifact.dataEncryptionKey),
            seq: link.artifact.seq,
        };
        return { link: linkFromRow(link, declaredSlot), artifact };
    }

    /**
     * Binds the release-authorized package archive to exactly one protected
     * Account Artifact. A fresh publisher rejoins the existing immutable link;
     * same-ID retries remain byte-exact and never replace accepted content.
     */
    async function publishPackageAsset(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityPackageAssetPublishActionOutputV1> {
        const input = PluginAvailabilityPackageAssetPublishActionInputV1Schema.parse(params.input);
        const capability = await resolveHostingCapability();
        if (!capability.enabled) {
            throw new PluginAvailabilityOperationError(
                hostedArtifactPolicyError("packageAsset", "unsupported"),
            );
        }

        const publish = async (tx: Tx): Promise<PluginAvailabilityPackageAssetPublishActionOutputV1> => {
            const release = await resolveReleaseTx(tx, params.accountId, input.release);
            if (!release) {
                throw new PluginAvailabilityOperationError("plugin_package_asset_not_found");
            }
            const facts = packageAssetFactsFromRow(release);
            await assertHostingIntentTx({
                tx,
                accountId: params.accountId,
                pluginId: release.pluginId,
                version: release.version,
                kind: "packageAsset",
            });
            const existing = await resolveStoredPackageAssetLinkTx(tx, release.id);
            if (!existing) {
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_conflict",
                );
            }
            const envelope = decodeArtifactEnvelope(
                input.artifact,
                "plugin_package_asset_invalid_content",
            );
            if (
                existing.packageAssetArtifactId !== null
                || existing.packageAssetArtifact !== null
            ) {
                const link = packageAssetLinkFromRow(
                    existing,
                    facts.packageAssetArchive,
                );
                if (
                    !link
                    || !await isStoredHostedArtifactRejoin({
                        tx,
                        accountId: params.accountId,
                        artifactId: input.artifactId,
                        link: { artifactId: link.artifactId, artifact: existing.packageAssetArtifact! },
                        envelope,
                    })
                ) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_package_asset_conflict",
                    );
                }
                if (!isExactPlainPackageAssetArchive({
                    descriptor: facts.packageAssetArchive,
                    envelope,
                })) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_package_asset_invalid_content",
                    );
                }
                return { outcome: "rejoined", link };
            }

            if (!isExactPlainPackageAssetArchive({
                descriptor: facts.packageAssetArchive,
                envelope,
            })) {
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_invalid_content",
                );
            }
            const existingArtifact = await tx.artifact.findUnique({
                where: { id: input.artifactId },
                select: { id: true },
            });
            if (existingArtifact) {
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_conflict",
                );
            }
            await assertHostingCapacityTx({
                tx,
                accountId: params.accountId,
                capability,
                candidateBytes: artifactEnvelopeByteLength(envelope),
                kind: "packageAsset",
            });
            const created = await createArtifactTx(tx, {
                actorUserId: params.accountId,
                artifactId: input.artifactId,
                header: envelope.header,
                body: envelope.body,
                dataEncryptionKey: envelope.dataEncryptionKey,
                markChanged: async (artifactId) => {
                    const linked = await tx.accountPluginRelease.updateMany({
                        where: {
                            id: release.id,
                            accountId: params.accountId,
                            packageAssetArtifactId: null,
                        },
                        data: { packageAssetArtifactId: artifactId },
                    });
                    if (linked.count !== 1) {
                        throw new PluginAvailabilityOperationError(
                            "plugin_package_asset_conflict",
                        );
                    }
                    return await markAvailabilityChangedTx(
                        tx,
                        params.accountId,
                        release.pluginId,
                    );
                },
            });
            if (!created.ok) {
                if (created.error === "invalid-params") {
                    throw new PluginAvailabilityOperationError(
                        "plugin_package_asset_invalid_content",
                    );
                }
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_conflict",
                );
            }
            if (!created.didWrite) {
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_conflict",
                );
            }
            const linked = await resolveStoredPackageAssetLinkTx(tx, release.id);
            const link = linked
                ? packageAssetLinkFromRow(linked, facts.packageAssetArchive)
                : null;
            if (!link || link.artifactId !== input.artifactId) {
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_conflict",
                );
            }
            return { outcome: "created", link };
        };

        try {
            return await inTx(publish);
        } catch (error) {
            if (!isPrismaErrorCode(error, "P2002")) throw error;
            // Re-enter the same transaction owner: a uniqueness race grants
            // no exemption from current hosting, Account mode or ID checks.
            return await inTx(publish);
        }
    }

    /**
     * Reopens a package Asset only after selected-release/hosting currentness
     * and its release-owned descriptor agree in one Availability transaction.
     */
    async function readPackageAsset(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityPackageAssetReadActionOutputV1> {
        const input = PluginAvailabilityPackageAssetReadActionInputV1Schema.parse(params.input);
        const capability = await resolveHostingCapability();
        if (!capability.enabled) {
            throw new PluginAvailabilityOperationError(
                hostedArtifactPolicyError("packageAsset", "unsupported"),
            );
        }
        return await inTx(async (tx) => {
            const account = await tx.account.findUnique({
                where: { id: params.accountId },
                select: { encryptionMode: true },
            });
            const accountMode = account
                ? resolveEffectiveAccountEncryptionModeFromAccountRow(account)
                : null;
            if (accountMode?.status !== "ready") {
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_invalid_content",
                );
            }
            const release = await resolveReleaseTx(tx, params.accountId, input.release);
            if (!release) {
                throw new PluginAvailabilityOperationError("plugin_package_asset_not_found");
            }
            const facts = packageAssetFactsFromRow(release);
            await assertHostingIntentTx({
                tx,
                accountId: params.accountId,
                pluginId: release.pluginId,
                version: release.version,
                kind: "packageAsset",
            });
            const stored = await resolveStoredPackageAssetLinkTx(tx, release.id);
            if (!stored) {
                throw new PluginAvailabilityOperationError("plugin_package_asset_not_found");
            }
            const link = packageAssetLinkFromRow(stored, facts.packageAssetArchive);
            if (!link) {
                if (
                    stored.packageAssetArtifactId === null
                    && stored.packageAssetArtifact === null
                ) {
                    throw new PluginAvailabilityOperationError("plugin_package_asset_not_found");
                }
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_conflict",
                );
            }
            const artifact = stored.packageAssetArtifact!;
            const opened = openArtifactStoredContentPair({
                accountId: params.accountId,
                artifactId: artifact.id,
                mode: accountMode.mode,
                dataEncryptionKey: artifact.dataEncryptionKey,
                header: artifact.header,
                body: artifact.body,
            });
            if (!opened) {
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_invalid_content",
                );
            }
            const envelope = {
                header: opened.header,
                body: opened.body,
                dataEncryptionKey: artifact.dataEncryptionKey,
            };
            if (!isExactPlainPackageAssetArchive({
                descriptor: facts.packageAssetArchive,
                envelope,
            })) {
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_invalid_content",
                );
            }
            return {
                link,
                artifact: {
                    header: privacyKit.encodeBase64(opened.header),
                    headerVersion: artifact.headerVersion,
                    body: privacyKit.encodeBase64(opened.body),
                    bodyVersion: artifact.bodyVersion,
                    dataEncryptionKey: privacyKit.encodeBase64(
                        copyArtifactBytes(artifact.dataEncryptionKey),
                    ),
                    seq: artifact.seq,
                },
            };
        });
    }

    /**
     * Reopens one current plain generated Artifact through the qualified
     * Availability reader. Issuance and every anonymous byte request share
     * this owner so withdrawal, selected-release, link, and archive checks
     * cannot drift into a one-time issuance decision.
     */
    async function openCurrentPlainBrowserArtifactFrame(params: Readonly<{
        accountId: string;
        input: PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1;
    }>): Promise<CurrentPlainBrowserArtifactFrame> {
        const input = params.input;
        const account = await db.account.findUnique({
            where: { id: params.accountId },
            select: { encryptionMode: true },
        });
        if (!account) {
            throw new PluginAvailabilityOperationError("plugin_account_not_found");
        }
        if (account.encryptionMode !== "plain") {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_browser_e2ee_unavailable",
            );
        }

        const read = await readUiArtifact({
            accountId: params.accountId,
            input: {
                release: input.release,
                contributionId: input.contributionId,
                artifactId: input.artifactId,
                tier: input.tier,
                platform: input.platform,
            },
        });
        if (read.link.artifactDigest !== input.expectedArtifactDigest) {
            throw new PluginAvailabilityOperationError(
                "plugin_release_content_conflict",
            );
        }

        const envelope = decodeArtifactEnvelope(read.artifact);
        if (!artifactStoredContentMatchesAccountMode({
            mode: "plain",
            header: envelope.header,
            body: envelope.body,
            dataEncryptionKey: envelope.dataEncryptionKey,
        })) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_invalid_content",
            );
        }

        const archiveHeader = decodePlainArtifactStoredContent(read.artifact.header);
        const archiveBodyEnvelope = decodePlainArtifactStoredContent(read.artifact.body);
        const archiveBodyEncoded = readArtifactArchiveBodyString(archiveBodyEnvelope);
        const archiveBody = archiveBodyEncoded
            ? decodePluginUiArtifactArchiveBodyV1(archiveBodyEncoded)
            : null;
        if (archiveHeader === null || !archiveBody) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_invalid_content",
            );
        }
        const archive = archiveBody
            ? openPluginUiArtifactArchiveV1({
                pluginId: input.release.pluginId,
                expectedArtifactDigest: input.expectedArtifactDigest,
                header: archiveHeader,
                body: archiveBody,
            })
            : null;
        if (
            !archive
            || archive.artifactGraph.artifactId !== input.artifactId
            || archive.artifactGraph.tier !== input.tier
            || archive.artifactGraph.hostUiApiRange !== read.link.hostUiApiRange
        ) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_invalid_content",
            );
        }
        const hostedWebPolicy = deriveGeneratedHostedWebAssetPolicyV1(
            archive.artifactGraph,
        );
        if (
            !hostedWebPolicy
            || hostedWebPolicy.digest !== input.expectedArtifactDigest
        ) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_invalid_content",
            );
        }

        return {
            link: read.link,
            archive,
            hostedWebPolicy,
        };
    }

    /**
     * Issues the one browser-only stateless source capability after reusing the
     * qualified Artifact read owner. It never accepts renderer policy, URL,
     * bytes, cache, or bridge authority: the persisted graph and deployment
     * configuration are the only inputs to the sealed exact scope.
     */
    async function issueBrowserArtifactFrame(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1> {
        const input = PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema.parse(
            params.input,
        );
        const current = await openCurrentPlainBrowserArtifactFrame({
            accountId: params.accountId,
            input,
        });

        const config = resolveBrowserArtifactCapabilityConfig();
        if (!config) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_hosting_unsupported",
            );
        }
        const minted = mintBrowserArtifactCapability({
            config,
            claim: {
                accountId: params.accountId,
                release: input.release,
                contributionId: input.contributionId,
                tier: input.tier,
                platform: input.platform,
                artifactId: current.link.artifactId,
                artifactDigest: input.expectedArtifactDigest,
                hostedWebScope: {
                    profile: current.hostedWebPolicy.profile,
                    assetRootId: current.hostedWebPolicy.assetRootId,
                    entryPath: current.hostedWebPolicy.entryPath,
                },
            },
            nowMs: Date.now(),
        });
        if (!minted) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_invalid_content",
            );
        }
        const url = createBrowserArtifactCapabilityUrl({
            artifactOrigin: config.artifactOrigin,
            capability: minted.capability,
        });
        if (!url) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_hosting_unsupported",
            );
        }
        return PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1Schema.parse({
            url,
            expiresAt: minted.expiresAt,
        });
    }

    /**
     * Resolves one anonymous static response from a verified stateless frame
     * capability. The bearer path is never enough by itself: current Account
     * mode, hosting intent, exact Artifact link, archive integrity, deployment
     * origins, and the canonical generated-Web policy are all rechecked here.
     */
    async function readBrowserArtifactFrame(params: Readonly<{
        capability: string;
        requestPath: string;
        request: Readonly<{
            protocol?: unknown;
            host?: unknown;
        }>;
    }>): Promise<PluginAvailabilityBrowserArtifactFrameResponse> {
        const config = resolveBrowserArtifactCapabilityConfig();
        if (!config || !isBrowserArtifactCapabilityRequestOnArtifactOrigin({
            config,
            request: params.request,
        })) {
            throw new PluginAvailabilityOperationError("plugin_ui_artifact_not_found");
        }
        const claim = verifyBrowserArtifactCapability({
            capability: params.capability,
            signingSecret: config.signingSecret,
            nowMs: Date.now(),
        });
        if (
            !claim
            || claim.artifactOrigin !== config.artifactOrigin
            || claim.embeddingOrigin !== config.embeddingOrigin
        ) {
            throw new PluginAvailabilityOperationError("plugin_ui_artifact_not_found");
        }

        const current = await openCurrentPlainBrowserArtifactFrame({
            accountId: claim.accountId,
            input: {
                release: claim.release,
                contributionId: claim.contributionId,
                artifactId: claim.artifactId,
                tier: claim.tier,
                platform: claim.platform,
                expectedArtifactDigest: claim.artifactDigest,
            },
        });
        if (
            current.link.artifactId !== claim.artifactId
            || current.link.artifactDigest !== claim.artifactDigest
            || current.hostedWebPolicy.digest !== claim.artifactDigest
            || current.hostedWebPolicy.profile !== claim.hostedWebScope.profile
            || current.hostedWebPolicy.assetRootId !== claim.hostedWebScope.assetRootId
            || current.hostedWebPolicy.entryPath !== claim.hostedWebScope.entryPath
        ) {
            throw new PluginAvailabilityOperationError("plugin_ui_artifact_not_found");
        }

        const policy = resolveHostedWebAssetPolicy({
            assetRootId: current.hostedWebPolicy.assetRootId,
            entryPath: current.hostedWebPolicy.entryPath,
            files: current.hostedWebPolicy.files,
            digest: current.hostedWebPolicy.digest,
            routeMode: current.hostedWebPolicy.routeMode,
            requestPath: params.requestPath,
            security: current.hostedWebPolicy.security,
            frameAncestors: [claim.embeddingOrigin],
            sourceMaps: current.hostedWebPolicy.sourceMaps,
            delivery: "ephemeralCapability",
        });
        if (!policy.ok) {
            throw new PluginAvailabilityOperationError("plugin_ui_artifact_not_found");
        }
        const bytes = current.archive.files.get(policy.relativePath);
        if (!bytes) {
            throw new PluginAvailabilityOperationError("plugin_ui_artifact_invalid_content");
        }
        return {
            bytes,
            contentType: policy.contentType,
            headers: policy.headers,
        };
    }

    /** Explicit Account-scoped removal retires the classification and its Artifact atomically. */
    async function removePackageAsset(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityPackageAssetRemoveActionOutputV1> {
        const input = PluginAvailabilityPackageAssetRemoveActionInputV1Schema.parse(params.input);
        return await inTx(async (tx) => {
            const account = await tx.account.findUnique({
                where: { id: params.accountId },
                select: {
                    encryptionMode: true,
                    publicKey: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                },
            });
            const currentness = account
                ? deriveAccountEncryptionCurrentnessFromRow(account)
                : null;
            const release = await resolveReleaseTx(tx, params.accountId, input.release);
            if (!release) throw new PluginAvailabilityOperationError("plugin_package_asset_not_found");
            const facts = packageAssetFactsFromRow(release);
            const stored = await resolveStoredPackageAssetLinkTx(tx, release.id);
            const link = stored ? packageAssetLinkFromRow(stored, facts.packageAssetArchive) : null;
            const artifact = stored?.packageAssetArtifact;
            if (!artifact || !link) {
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_not_found",
                );
            }
            if (
                currentness?.status !== "ready"
                || !artifactDataKeyMatchesAccountMode({
                    mode: currentness.currentness.encryptionMode,
                    dataEncryptionKey: artifact.dataEncryptionKey,
                })
            ) {
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_invalid_content",
                );
            }
            const unlinked = await tx.accountPluginRelease.updateMany({
                where: { id: release.id, accountId: params.accountId, packageAssetArtifactId: link.artifactId },
                data: { packageAssetArtifactId: null },
            });
            if (unlinked.count !== 1) throw new PluginAvailabilityOperationError("plugin_package_asset_conflict");
            const deleted = await tx.artifact.deleteMany({
                where: { id: link.artifactId, accountId: params.accountId },
            });
            if (deleted.count !== 1) throw new PluginAvailabilityOperationError("plugin_package_asset_conflict");
            await markAvailabilityChangedTx(tx, params.accountId, release.pluginId);
            return { removed: true, link };
        });
    }

    async function removeUiArtifact(params: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityUiArtifactRemoveActionOutputV1> {
        const input = PluginAvailabilityUiArtifactRemoveActionInputV1Schema.parse(params.input);
        return await inTx(async (tx) => {
            const release = await resolveReleaseTx(tx, params.accountId, input.release);
            if (!release) {
                throw new PluginAvailabilityOperationError("plugin_ui_artifact_not_found");
            }
            const link = await tx.accountPluginUiArtifact.findUnique({
                where: {
                    releaseId_contributionId_tier_platform: {
                        releaseId: release.id,
                        contributionId: input.contributionId,
                        tier: input.tier,
                        platform: input.platform,
                    },
                },
                select: {
                    contributionId: true,
                    tier: true,
                    platform: true,
                    artifactId: true,
                    artifactDigest: true,
                    compatibility: true,
                    release: {
                        select: {
                            accountId: true,
                            pluginId: true,
                            version: true,
                        },
                    },
                    artifact: {
                        select: { accountId: true, dataEncryptionKey: true },
                    },
                },
            });
            if (!link || link.artifact.accountId !== params.accountId) {
                throw new PluginAvailabilityOperationError("plugin_ui_artifact_not_found");
            }
            const declaredSlot = releaseFactsFromRow(release).uiSlots.find((slot) => (
                slot.contributionId === input.contributionId
                && slot.artifactId === input.artifactId
                && slot.tier === input.tier
                && slot.platform === input.platform
            ));
            if (!declaredSlot || !isStoredLinkForDeclaredSlot(link, declaredSlot)) {
                throw new PluginAvailabilityOperationError("plugin_ui_artifact_not_found");
            }
            const account = await tx.account.findUnique({
                where: { id: params.accountId },
                select: {
                    encryptionMode: true,
                    publicKey: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                },
            });
            const currentness = account
                ? deriveAccountEncryptionCurrentnessFromRow(account)
                : null;
            if (
                currentness?.status !== "ready"
                || !artifactDataKeyMatchesAccountMode({
                    mode: currentness.currentness.encryptionMode,
                    dataEncryptionKey: link.artifact.dataEncryptionKey,
                })
            ) {
                throw new PluginAvailabilityOperationError(
                    "plugin_ui_artifact_invalid_content",
                );
            }
            const projected = linkFromRow(link, declaredSlot);
            await tx.accountPluginUiArtifact.delete({
                where: { artifactId: link.artifactId },
            });
            const deleted = await tx.artifact.deleteMany({
                where: {
                    id: link.artifactId,
                    accountId: params.accountId,
                },
            });
            if (deleted.count !== 1) {
                throw new PluginAvailabilityOperationError(
                    "plugin_ui_artifact_conflict",
                );
            }
            await markAvailabilityChangedTx(tx, params.accountId, release.pluginId);
            return { removed: true, link: projected };
        });
    }

    return {
        readRelease,
        publishRelease,
        reportMaterializations,
        readMaterializations,
        listIntentIds,
        readIntent,
        setIntent,
        claimCollectionWriters,
        publishUiArtifact,
        readUiArtifact,
        publishPackageAsset,
        readPackageAsset,
        removePackageAsset,
        issueBrowserArtifactFrame,
        readBrowserArtifactFrame,
        removeUiArtifact,
    };
}
