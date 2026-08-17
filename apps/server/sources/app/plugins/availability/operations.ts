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
    PluginAvailabilityMaterializationsReadActionInputV1Schema,
    PluginAvailabilityMaterializationsReportActionInputV1Schema,
    PluginAvailabilityReleaseReadActionInputV1Schema,
    PluginAvailabilityReleaseReadActionOutputV1Schema,
    PluginAvailabilityReleasePublishActionInputV1Schema,
    PluginAvailabilityPackageAssetPublishActionInputV1Schema,
    PluginAvailabilityPackageAssetReadActionInputV1Schema,
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
    normalizePluginReleaseFactsV1,
    pluginReleaseFactsEqualV1,
    reconcilePluginMachineMaterializationSnapshotV1,
    supportsMachineOperationProtocolCapabilityV1,
    type PluginAccountPluginUiArtifactLinkV1,
    type PluginAccountPluginPackageAssetLinkV1,
    type PluginAvailabilityArtifactReadEnvelopeV1,
    type PluginAvailabilityIntentReadActionOutputV1,
    type PluginAvailabilityIntentsListActionOutputV1,
    type PluginAvailabilityIntentSetActionOutputV1,
    type PluginAvailabilityMaterializationsReadActionOutputV1,
    type PluginAvailabilityMaterializationsReportActionOutputV1,
    type PluginAvailabilityReleaseReadActionOutputV1,
    type PluginAvailabilityReleasePublishActionOutputV1,
    type PluginAvailabilityPackageAssetPublishActionOutputV1,
    type PluginAvailabilityPackageAssetReadActionOutputV1,
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
} from "@happier-dev/protocol";
import {
    decodePackageAssetArchiveBodyV1,
    openPackageAssetArchiveV1,
} from "@happier-dev/protocol/plugins/availability";
import * as privacyKit from "privacy-kit";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { resolvePluginUiArtifactHostingCapability } from "@/app/features/pluginsFeature";
import {
    createArtifactTx,
} from "@/app/artifacts/artifactWriteService";
import {
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
} from "@happier-dev/protocol/plugins/ui";
import {
    PluginCollectionContractMaterializationError,
    PluginCollectionWriterReadinessError,
    materializePluginCollectionContractsFromManifestTx,
    preparePluginCollectionWritableContractsTx,
} from "@/app/plugins/data/collections/contracts";
import { promotePluginCollectionCandidatePreparationInTx } from "@/app/plugins/data/collections/candidatePreparation";
import { retirePluginCollectionCandidatePreparationStagesTx } from "@/app/plugins/data/collections/candidatePreparationLifecycle";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { db, isPrismaErrorCode } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import {
    createBrowserArtifactCapabilityUrl,
    isBrowserArtifactCapabilityRequestOnArtifactOrigin,
    mintBrowserArtifactCapability,
    resolveBrowserArtifactCapabilityConfig,
    verifyBrowserArtifactCapability,
} from "./browserArtifactCapability";

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
    | "collection_quota_incompatible"
    | "plugin_materialization_machine_mismatch"
    | "plugin_materialization_server_identity_mismatch"
    | "plugin_materialization_snapshot_conflict"
    | "plugin_materialization_snapshot_stale"
    | "plugin_ui_artifact_hosting_unsupported"
    | "plugin_ui_artifact_hosting_not_opted_in"
    | "plugin_ui_artifact_hosting_limit_exceeded"
    | "plugin_ui_artifact_invalid_content"
    | "plugin_ui_artifact_client_upgrade_required"
    | "plugin_ui_artifact_conflict"
    | "plugin_ui_artifact_not_found"
    | "plugin_ui_artifact_browser_e2ee_unavailable"
    | "plugin_package_asset_hosting_unsupported"
    | "plugin_package_asset_hosting_not_opted_in"
    | "plugin_package_asset_hosting_limit_exceeded"
    | "plugin_package_asset_invalid_content"
    | "plugin_package_asset_client_upgrade_required"
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

function intentFromRow(row: StoredIntentRow) {
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

function linkFromRow(row: StoredUiArtifactLinkRow): PluginAccountPluginUiArtifactLinkV1 {
    return PluginAccountPluginUiArtifactLinkV1Schema.parse({
        release: {
            pluginId: row.release.pluginId,
            version: row.release.version,
        },
        contributionId: row.contributionId,
        tier: row.tier,
        platform: row.platform,
        artifactId: row.artifactId,
        artifactDigest: row.artifactDigest,
        compatibility: row.compatibility,
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
): Promise<StoredUiArtifactLinkRow | null> {
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
        const stored = linkFromRow(row);
        return stored.artifactDigest === slot.artifactDigest
            && stored.contributionId === slot.contributionId
            && stored.tier === slot.tier
            && stored.platform === slot.platform
            && isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(
                slot,
                stored.compatibility,
            );
    } catch {
        return false;
    }
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

function materializationFromRow(row: Readonly<{
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
}>) {
    return PluginMachineMaterializationV1Schema.parse({
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
    });
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
    }>
    | Readonly<{ kind: "notCurrent" }>;

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
    if (
        machine === null
        || machine.pluginMaterializationRevision === null
        || classifyMachineAvailabilityState(machine) !== "available"
        || (
            params.requiredMachineOperationCapability !== undefined
            && (
                typeof machine.operationProtocolCapabilitiesRevision !== "number"
                || machine.operationProtocolCapabilitiesRevision < 1
                || !supportsMachineOperationProtocolCapabilityV1(
                    machine.operationProtocolCapabilities,
                    params.requiredMachineOperationCapability,
                )
            )
        )
    ) {
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
    if (
        materialization.enabled
        && materialization.trustState === "trusted"
        && await hasExactAccountReleaseCorrespondenceTx({
            tx: params.tx,
            accountId: params.accountId,
            materialization,
        })
    ) {
        return { kind: "current", materialization };
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
    publishUiArtifact(input: Readonly<{
        accountId: string;
        supportsCurrentStoredContentProtocol: boolean;
        input: unknown;
    }>): Promise<PluginAvailabilityUiArtifactPublishActionOutputV1>;
    readUiArtifact(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityUiArtifactReadActionOutputV1>;
    publishPackageAsset(input: Readonly<{
        accountId: string;
        supportsCurrentStoredContentProtocol: boolean;
        input: unknown;
    }>): Promise<PluginAvailabilityPackageAssetPublishActionOutputV1>;
    readPackageAsset(input: Readonly<{
        accountId: string;
        input: unknown;
    }>): Promise<PluginAvailabilityPackageAssetReadActionOutputV1>;
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
        const snapshot = PluginMachineMaterializationSnapshotV1Schema.parse(input.snapshot);
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
            const reconciliation = reconcilePluginMachineMaterializationSnapshotV1({
                currentRevision: machine.pluginMaterializationRevision === null
                    ? null
                    : Number(machine.pluginMaterializationRevision),
                current: currentRows.map(materializationFromRow),
                report: snapshot,
            });
            if (reconciliation.kind === "stale") {
                throw new PluginAvailabilityOperationError(
                    "plugin_materialization_snapshot_stale",
                );
            }
            if (reconciliation.kind === "conflict") {
                throw new PluginAvailabilityOperationError(
                    "plugin_materialization_snapshot_conflict",
                );
            }
            if (reconciliation.kind === "rejoin") {
                return { snapshot: reconciliation.snapshot, outcome: "rejoined" };
            }

            const changedPluginIds = new Set([
                ...currentRows.map((row) => row.pluginId),
                ...reconciliation.snapshot.materializations.map((row) => row.pluginId),
            ]);
            await tx.pluginMachineMaterialization.deleteMany({
                where: {
                    accountId: params.accountId,
                    machineId: params.publisherMachineId,
                },
            });
            if (reconciliation.snapshot.materializations.length > 0) {
                await tx.pluginMachineMaterialization.createMany({
                    data: reconciliation.snapshot.materializations.map((row) => ({
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
                    pluginMaterializationRevision: BigInt(reconciliation.snapshot.revision),
                },
            });
            for (const pluginId of changedPluginIds) {
                await markAvailabilityChangedTx(tx, params.accountId, pluginId);
            }
            return { snapshot: reconciliation.snapshot, outcome: "replaced" };
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
                    where: {
                        accountId: params.accountId,
                        pluginMaterializationRevision: { not: null },
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
        const snapshots = machines.map((machine) => {
            const materializations = machine.pluginMaterializations.map(materializationFromRow);
            return PluginMachineMaterializationSnapshotV1Schema.parse({
                serverIdentityId: materializations[0]?.serverIdentityId ?? serverIdentityId,
                machineId: machine.id,
                revision: Number(machine.pluginMaterializationRevision),
                materializations,
            });
        });
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
                tx.accountPluginIntent.findMany({
                    where: {
                        accountId: params.accountId,
                        desiredVersion: { not: null },
                    },
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
                return { availabilityCursor: account.seq, intentRow, release };
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
            uiArtifacts: facts ? current.release!.uiArtifacts.map(linkFromRow) : [],
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
                    select: {
                        pluginId: true,
                        desiredVersion: true,
                        enabled: true,
                        offlineUiHosting: true,
                        writableCollections: true,
                        revision: true,
                    },
                });
                // Availability remains the release/currentness and final CAS
                // owner. Data can only consume this current source plus the
                // selected target inside this existing transaction, then
                // return a readiness result before this intent is published.
                await promotePluginCollectionCandidatePreparationInTx({
                    tx,
                    accountId: params.accountId,
                    pluginId: input.pluginId,
                    currentIntent: current,
                    targetReleaseVersion: input.desiredVersion,
                    targetContracts: input.writableCollections,
                });
                const prepared = await preparePluginCollectionWritableContractsTx({
                    tx,
                    accountId: params.accountId,
                    pluginId: input.pluginId,
                    contracts: input.writableCollections,
                });
                // Any successful intent transition retires residual candidate
                // outputs. Promotion removed its exact source stages above;
                // this broad lifecycle cleanup covers cancelled/replaced and
                // no-row bindings without making stages an activation owner.
                await retirePluginCollectionCandidatePreparationStagesTx({
                    tx,
                    accountId: params.accountId,
                    pluginId: input.pluginId,
                });
                if (!current) {
                    if (expectedRevision !== null) {
                        throw new PluginAvailabilityOperationError(
                            "plugin_intent_revision_conflict",
                        );
                    }
                    const created = await tx.accountPluginIntent.create({
                        data: {
                            accountId: params.accountId,
                            pluginId: input.pluginId,
                            desiredVersion: input.desiredVersion,
                            enabled: input.enabled,
                            offlineUiHosting: input.offlineUiHosting,
                            writableCollections: toPrismaJson(prepared.contracts),
                            revision: BigInt(0),
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
                    await markAvailabilityChangedTx(
                        tx,
                        params.accountId,
                        input.pluginId,
                    );
                    return { intent: intentFromRow(created) };
                }
                if (
                    expectedRevision === null
                    || current.revision !== expectedRevision
                ) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_intent_revision_conflict",
                    );
                }
                const updated = await tx.accountPluginIntent.updateMany({
                    where: {
                        accountId: params.accountId,
                        pluginId: input.pluginId,
                        revision: expectedRevision,
                    },
                    data: {
                        desiredVersion: input.desiredVersion,
                        enabled: input.enabled,
                        offlineUiHosting: input.offlineUiHosting,
                        writableCollections: toPrismaJson(prepared.contracts),
                        revision: { increment: BigInt(1) },
                    },
                });
                if (updated.count !== 1) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_intent_revision_conflict",
                    );
                }
                const next = await tx.accountPluginIntent.findUnique({
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
                });
                if (!next) {
                    throw new PluginAvailabilityOperationError(
                        "plugin_intent_revision_conflict",
                    );
                }
                await markAvailabilityChangedTx(
                    tx,
                    params.accountId,
                    input.pluginId,
                );
                return { intent: intentFromRow(next) };
            });
            return outcome;
        } catch (error) {
            if (error instanceof PluginCollectionWriterReadinessError) {
                if (
                    error.code === "collection_quota_incompatible"
                    && error.dimension !== undefined
                    && error.effectiveMaximum !== undefined
                ) {
                    throw new PluginAvailabilityOperationError(
                        "collection_quota_incompatible",
                        {
                            dimension: error.dimension,
                            effectiveMaximum: error.effectiveMaximum,
                        },
                    );
                }
                throw new PluginAvailabilityOperationError(
                    "plugin_intent_writable_collections_not_ready",
                );
            }
            if (isPrismaErrorCode(error, "P2002")) {
                throw new PluginAvailabilityOperationError(
                    "plugin_intent_revision_conflict",
                );
            }
            throw error;
        }
    }

    async function publishUiArtifact(params: Readonly<{
        accountId: string;
        supportsCurrentStoredContentProtocol: boolean;
        input: unknown;
    }>): Promise<PluginAvailabilityUiArtifactPublishActionOutputV1> {
        const input = PluginAvailabilityUiArtifactPublishActionInputV1Schema.parse(params.input);
        const capability = await resolveHostingCapability();
        if (!capability.enabled) {
            throw new PluginAvailabilityOperationError(
                "plugin_ui_artifact_hosting_unsupported",
            );
        }

        const publish = async (tx: Tx): Promise<PluginAvailabilityUiArtifactPublishActionOutputV1> => {
            const release = await resolveReleaseTx(tx, params.accountId, input.release);
            if (!release) {
                throw new PluginAvailabilityOperationError("plugin_release_not_found");
            }
            const facts = releaseFactsFromRow(release);
            const declaredSlot = facts.uiSlots.find((slot) => (
                slot.contributionId === input.slot.contributionId
                && slot.tier === input.slot.tier
                && slot.platform === input.slot.platform
            ));
            if (!declaredSlot || !slotsEqual(declaredSlot, input.slot)) {
                throw new PluginAvailabilityOperationError(
                    "plugin_release_content_conflict",
                );
            }
            if (!isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(
                declaredSlot,
                input.hostCompatibility,
            )) {
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
                return { outcome: "rejoined", link: linkFromRow(existingLink) };
            }

            const existingArtifact = await tx.artifact.findUnique({
                where: { id: input.artifactId },
                select: { id: true },
            });
            if (existingArtifact) {
                throw new PluginAvailabilityOperationError(
                    "plugin_ui_artifact_conflict",
                );
            }
            const artifact = decodeArtifactEnvelope(input.artifact);
            await assertHostingCapacityTx({
                tx,
                accountId: params.accountId,
                capability,
                candidateBytes: artifactEnvelopeByteLength(artifact),
                kind: "ui",
            });
            const created = await createArtifactTx(tx, {
                actorUserId: params.accountId,
                artifactId: input.artifactId,
                header: artifact.header,
                body: artifact.body,
                dataEncryptionKey: artifact.dataEncryptionKey,
                supportsCurrentStoredContentProtocol:
                    params.supportsCurrentStoredContentProtocol,
                markChanged: async (artifactId) => {
                    await tx.accountPluginUiArtifact.create({
                        data: {
                            releaseId: release.id,
                            ...slotCoordinates(declaredSlot),
                            artifactId,
                            artifactDigest: declaredSlot.artifactDigest,
                            compatibility: toPrismaJson(input.hostCompatibility),
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
                if (created.error === "client-upgrade-required") {
                    throw new PluginAvailabilityOperationError(
                        "plugin_ui_artifact_client_upgrade_required",
                    );
                }
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
            return { outcome: "created", link: linkFromRow(createdLink) };
        };

        try {
            return await inTx(publish);
        } catch (error) {
            if (!isPrismaErrorCode(error, "P2002")) throw error;
            const release = await resolveReleaseTx(db, params.accountId, input.release);
            if (!release) throw error;
            const existingLink = await resolveStoredSlotLinkTx(
                db,
                release.id,
                input.slot,
            );
            if (!existingLink || !isStoredLinkForDeclaredSlot(existingLink, input.slot)) {
                throw new PluginAvailabilityOperationError(
                    "plugin_ui_artifact_conflict",
                );
            }
            return { outcome: "rejoined", link: linkFromRow(existingLink) };
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
        const release = await db.accountPluginRelease.findUnique({
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
        });
        if (!release) {
            throw new PluginAvailabilityOperationError("plugin_ui_artifact_not_found");
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
        return { link: linkFromRow(link), artifact };
    }

    /**
     * Binds the release-authorized package archive to exactly one protected
     * Account Artifact. Rejoining is deliberately byte-exact: a retry cannot
     * replace an already accepted archive or repurpose its Artifact id.
     */
    async function publishPackageAsset(params: Readonly<{
        accountId: string;
        supportsCurrentStoredContentProtocol: boolean;
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
                    || link.artifactId !== input.artifactId
                    || !storedArtifactMatchesEnvelope({
                        accountId: params.accountId,
                        artifact: existing.packageAssetArtifact!,
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
                supportsCurrentStoredContentProtocol:
                    params.supportsCurrentStoredContentProtocol,
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
                if (created.error === "client-upgrade-required") {
                    throw new PluginAvailabilityOperationError(
                        "plugin_package_asset_client_upgrade_required",
                    );
                }
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
            const release = await resolveReleaseTx(db, params.accountId, input.release);
            if (!release) throw error;
            const facts = packageAssetFactsFromRow(release);
            const existing = await resolveStoredPackageAssetLinkTx(db, release.id);
            const link = existing
                ? packageAssetLinkFromRow(existing, facts.packageAssetArchive)
                : null;
            const envelope = decodeArtifactEnvelope(
                input.artifact,
                "plugin_package_asset_invalid_content",
            );
            if (
                !link
                || !existing?.packageAssetArtifact
                || link.artifactId !== input.artifactId
                || !storedArtifactMatchesEnvelope({
                    accountId: params.accountId,
                    artifact: existing.packageAssetArtifact,
                    envelope,
                })
            ) {
                throw new PluginAvailabilityOperationError(
                    "plugin_package_asset_conflict",
                );
            }
            return { outcome: "rejoined", link };
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
            || archive.artifactGraph.contributionId !== input.contributionId
            || archive.artifactGraph.tier !== input.tier
            || archive.artifactGraph.platform !== input.platform
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
                        select: { accountId: true },
                    },
                },
            });
            if (!link || link.artifact.accountId !== params.accountId) {
                throw new PluginAvailabilityOperationError("plugin_ui_artifact_not_found");
            }
            const projected = linkFromRow(link);
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
        publishUiArtifact,
        readUiArtifact,
        publishPackageAsset,
        readPackageAsset,
        issueBrowserArtifactFrame,
        readBrowserArtifactFrame,
        removeUiArtifact,
    };
}
