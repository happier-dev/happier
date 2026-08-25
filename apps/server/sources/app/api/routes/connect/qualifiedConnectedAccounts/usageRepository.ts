import { createHash } from "node:crypto";

import {
    buildProviderAccountUsageRecordId,
    ProviderAccountUsageSnapshotV1Schema,
    QualifiedConnectedAccountRefSchema,
    projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4,
    QualifiedConnectedServiceUsageSourceV4Schema,
    readAccountScopedCiphertextKindByte,
    type ConnectedServiceId,
    type ConnectedServiceQuotaSnapshotV1,
    type QualifiedConnectedAccountRef,
    type QualifiedConnectedServiceUsageSourceResolutionV4,
    type QualifiedConnectedServiceUsageSourceV4,
    type SealedConnectedServiceQuotaSnapshotV1,
} from "@happier-dev/protocol";
import { isConnectedServiceUsageProviderCompatible } from "@happier-dev/agents";

import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import {
    deleteProviderAccountUsageRecord,
    deleteProviderAccountUsageRecordsForAccount,
    readProviderAccountUsageRecord,
    requestProviderAccountUsageRefresh,
} from "../providerAccountUsage/recordStorage";
import {
    writeProviderAccountUsageRecordWithPolicy,
    type ProviderAccountUsageWritePolicyParams,
} from "../providerAccountUsage/routeWritePolicy";
import {
    ConnectedServiceUsageSourceBindingError,
    ConnectedServiceUsageSourceOwnershipError,
    ProviderAccountUsagePayloadInvariantError,
    type ProviderAccountUsageSourceLinkOutcome,
    type StoredProviderAccountUsageRecord,
} from "../providerAccountUsage/types";
import {
    resolveQualifiedConnectedAccountStoredMetadata,
} from "./credentialStoredMetadataAdapter";
import {
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountIdentityDigest,
    parseStoredQualifiedConnectedAccountGroupRef,
    parseStoredQualifiedConnectedAccountRef,
    resolveLegacyQualifiedConnectedAccountService,
    resolveLegacyServiceIdForQualifiedConnectedAccountService,
} from "./identity";

type QualifiedUsageStorage = Pick<
    Tx,
    | "serviceAccountToken"
    | "connectedServiceAuthGroup"
    | "connectedServiceAuthGroupMember"
    | "connectedServiceUsageSource"
    | "providerAccountUsageRecord"
>;

export class QualifiedConnectedAccountUsageBasisError extends Error {
    readonly reason:
        | "credential_revision_mismatch"
        | "configuration_revision_mismatch"
        | "concurrent_mutation";
    readonly credentialRevision: string | null;
    readonly configurationRevision: string | null;

    constructor(params: Readonly<{
        reason:
            | "credential_revision_mismatch"
            | "configuration_revision_mismatch"
            | "concurrent_mutation";
        credentialRevision: string | null;
        configurationRevision: string | null;
    }>) {
        super(params.reason);
        this.name = "QualifiedConnectedAccountUsageBasisError";
        this.reason = params.reason;
        this.credentialRevision = params.credentialRevision;
        this.configurationRevision = params.configurationRevision;
    }
}

function buildQualifiedUsageSourceKey(
    source: QualifiedConnectedServiceUsageSourceV4,
): string {
    const tuple = source.bindingKind === "group_member"
        ? [
            "qualified-group",
            source.ref.service.pluginId,
            source.ref.service.localId,
            source.ref.accountId,
            source.groupId,
            source.groupGeneration ?? "current",
        ]
        : [
            "qualified-account",
            source.ref.service.pluginId,
            source.ref.service.localId,
            source.ref.accountId,
        ];
    return `qcsus_v4_${createHash("sha256")
        .update(JSON.stringify(tuple))
        .digest("base64url")}`;
}

function qualifiedConnectedAccountRefsEqual(
    left: QualifiedConnectedAccountRef,
    right: QualifiedConnectedAccountRef,
): boolean {
    return left.service.pluginId === right.service.pluginId
        && left.service.localId === right.service.localId
        && left.accountId === right.accountId;
}

function parseStoredQualifiedUsageAccountRef(
    row: Readonly<{
        accountId: string;
        servicePluginId: string;
        serviceLocalId: string;
        qualifiedServiceDigest: string;
        connectedAccountId: string;
        qualifiedIdentityDigest: string;
        credentialId: string;
        credential: Readonly<{
            id: string;
            accountId: string;
            servicePluginId: string;
            serviceLocalId: string;
            qualifiedServiceDigest: string;
            connectedAccountId: string;
            qualifiedIdentityDigest: string;
        }>;
    }>,
): QualifiedConnectedAccountRef {
    try {
        const sourceRef =
            parseStoredQualifiedConnectedAccountRef(row);
        const credentialRef =
            parseStoredQualifiedConnectedAccountRef(
                row.credential,
            );
        if (
            row.accountId !== row.credential.accountId
            || row.credentialId !== row.credential.id
            || row.qualifiedServiceDigest
                !== row.credential.qualifiedServiceDigest
            || row.qualifiedIdentityDigest
                !== row.credential.qualifiedIdentityDigest
            || !qualifiedConnectedAccountRefsEqual(
                sourceRef,
                credentialRef,
            )
        ) {
            throw new Error("usage source credential mismatch");
        }
        return sourceRef;
    } catch {
        throw new ConnectedServiceUsageSourceBindingError(
            "Stored qualified Connected Account usage identity mismatch",
        );
    }
}

async function resolveQualifiedCredential(
    tx: QualifiedUsageStorage,
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
        allowLegacyUnfencedCredential?: boolean;
    }>,
) {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const qualifiedIdentityDigest =
        createQualifiedConnectedAccountIdentityDigest(ref);
    const credential = await tx.serviceAccountToken.findUnique({
        where: {
            accountId_qualifiedIdentityDigest: {
                accountId: params.accountId,
                qualifiedIdentityDigest,
            },
        },
    });
    if (!credential) {
        throw new ConnectedServiceUsageSourceBindingError(
            "Qualified Connected Account binding does not exist",
            "unavailable",
        );
    }
    let storedRef: QualifiedConnectedAccountRef;
    try {
        storedRef =
            parseStoredQualifiedConnectedAccountRef(credential);
    } catch {
        throw new ConnectedServiceUsageSourceBindingError(
            "Qualified Connected Account binding identity mismatch",
        );
    }
    if (
        !qualifiedConnectedAccountRefsEqual(storedRef, ref)
        || credential.qualifiedIdentityDigest
            !== qualifiedIdentityDigest
    ) {
        throw new ConnectedServiceUsageSourceBindingError(
            "Qualified Connected Account binding identity mismatch",
        );
    }
    const metadata = resolveQualifiedConnectedAccountStoredMetadata({
        rowId: credential.id,
        metadata: credential.metadata,
    });
    if (
        metadata.revisionSemantics === "legacy_unfenced"
        && !params.allowLegacyUnfencedCredential
    ) {
        throw new ConnectedServiceUsageSourceBindingError(
            "Qualified Connected Account usage requires a revisioned credential",
            "unavailable",
        );
    }
    return {
        credential,
        providerAccountId:
            metadata.presentation.providerIdentity?.accountId ?? null,
    };
}

async function resolveQualifiedUsageBinding(
    tx: QualifiedUsageStorage,
    params: Readonly<{
        accountId: string;
        source: QualifiedConnectedServiceUsageSourceV4;
        allowLegacyUnfencedCredential?: boolean;
    }>,
) {
    const source =
        QualifiedConnectedServiceUsageSourceV4Schema.parse(params.source);
    const binding = await resolveQualifiedCredential(tx, {
        accountId: params.accountId,
        ref: source.ref,
        allowLegacyUnfencedCredential:
            params.allowLegacyUnfencedCredential,
    });
    let groupGeneration: number | null = null;
    if (source.bindingKind === "group_member") {
        const qualifiedGroupDigest =
            createQualifiedConnectedAccountGroupDigest({
                service: source.ref.service,
                groupId: source.groupId,
            });
        const group = await tx.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_qualifiedGroupDigest: {
                    accountId: params.accountId,
                    qualifiedGroupDigest,
                },
            },
            select: {
                id: true,
                accountId: true,
                servicePluginId: true,
                serviceLocalId: true,
                generation: true,
                qualifiedServiceDigest: true,
                qualifiedGroupDigest: true,
                groupId: true,
            },
        });
        if (!group) {
            throw new ConnectedServiceUsageSourceBindingError(
                "Qualified Connected Account group binding does not exist",
                "unavailable",
            );
        }
        try {
            const storedGroupRef =
                parseStoredQualifiedConnectedAccountGroupRef(group);
            if (
                group.accountId !== params.accountId
                || storedGroupRef.service.pluginId
                    !== source.ref.service.pluginId
                || storedGroupRef.service.localId
                    !== source.ref.service.localId
                || storedGroupRef.groupId !== source.groupId
                || group.qualifiedServiceDigest
                    !== binding.credential.qualifiedServiceDigest
                || group.qualifiedGroupDigest
                    !== qualifiedGroupDigest
            ) {
                throw new Error("group binding mismatch");
            }
        } catch {
            throw new ConnectedServiceUsageSourceBindingError(
                "Qualified Connected Account group binding identity mismatch",
            );
        }
        const member =
            await tx.connectedServiceAuthGroupMember.findUnique({
                where: {
                    groupDbId_credentialId: {
                        groupDbId: group.id,
                        credentialId: binding.credential.id,
                    },
                },
                select: {
                    accountId: true,
                    credentialId: true,
                    qualifiedServiceDigest: true,
                    qualifiedGroupDigest: true,
                    qualifiedIdentityDigest: true,
                    enabled: true,
                },
            });
        if (!member) {
            throw new ConnectedServiceUsageSourceBindingError(
                "Qualified Connected Account group member is unavailable",
                "unavailable",
            );
        }
        if (
            member.accountId !== params.accountId
            || member.credentialId
                !== binding.credential.id
            || member.qualifiedServiceDigest
                !== group.qualifiedServiceDigest
            || member.qualifiedGroupDigest
                !== group.qualifiedGroupDigest
            || member.qualifiedIdentityDigest
                !== binding.credential.qualifiedIdentityDigest
        ) {
            throw new ConnectedServiceUsageSourceBindingError(
                "Qualified Connected Account group member identity mismatch",
            );
        }
        if (!member.enabled) {
            throw new ConnectedServiceUsageSourceBindingError(
                "Qualified Connected Account group member is unavailable",
                "unavailable",
            );
        }
        if (
            source.groupGeneration !== undefined
            && source.groupGeneration !== group.generation
        ) {
            throw new ConnectedServiceUsageSourceBindingError(
                "Qualified Connected Account group generation is stale",
                "unavailable",
            );
        }
        groupGeneration = source.groupGeneration ?? group.generation;
    }
    if (source.bindingKind === "group_member") {
        if (groupGeneration === null) {
            throw new ConnectedServiceUsageSourceBindingError(
                "Qualified Connected Account group generation is unavailable",
                "unavailable",
            );
        }
        return {
            source: { ...source, groupGeneration },
            credential: binding.credential,
            providerAccountId: binding.providerAccountId,
        };
    }
    return {
        source,
        credential: binding.credential,
        providerAccountId: binding.providerAccountId,
    };
}

function assertQualifiedUsageOwnership(params: Readonly<{
    providerAccountId: string | null;
    recordAccountSubjectId: string;
    recordSubjectKind: string;
}>): void {
    if (
        params.providerAccountId === null
        || params.recordSubjectKind !== "account"
    ) {
        throw new ConnectedServiceUsageSourceOwnershipError(
            "Qualified Connected Account ownership is unproven",
            "unproven",
        );
    }
    if (params.providerAccountId !== params.recordAccountSubjectId) {
        throw new ConnectedServiceUsageSourceOwnershipError(
            "Qualified Connected Account does not match provider usage account",
            "mismatch",
        );
    }
}

function mapQualifiedSourceRow(row: Readonly<{
    accountId: string;
    servicePluginId: string;
    serviceLocalId: string;
    qualifiedServiceDigest: string;
    connectedAccountId: string;
    qualifiedIdentityDigest: string;
    credentialId: string;
    bindingKind: string;
    groupId: string | null;
    groupGeneration: number | null;
    credential: Readonly<{
        id: string;
        accountId: string;
        servicePluginId: string;
        serviceLocalId: string;
        qualifiedServiceDigest: string;
        connectedAccountId: string;
        qualifiedIdentityDigest: string;
    }>;
}>): QualifiedConnectedServiceUsageSourceV4 {
    if (
        row.bindingKind !== "account"
        && row.bindingKind !== "profile"
        && row.bindingKind !== "group_member"
    ) {
        throw new ConnectedServiceUsageSourceBindingError(
            "Stored qualified Connected Account usage source has an invalid binding kind",
        );
    }
    const ref = parseStoredQualifiedUsageAccountRef(row);
    try {
        return QualifiedConnectedServiceUsageSourceV4Schema.parse({
            ref,
            bindingKind:
                row.bindingKind === "group_member"
                    ? "group_member"
                    : "account",
            ...(row.bindingKind === "group_member" && row.groupId
                ? {
                    groupId: row.groupId,
                    ...(row.groupGeneration !== null
                        ? { groupGeneration: row.groupGeneration }
                        : {}),
                }
                : {}),
        });
    } catch {
        throw new ConnectedServiceUsageSourceBindingError(
            "Stored qualified Connected Account usage source identity is invalid",
        );
    }
}

function qualifiedUsageSourcesEqual(
    left: QualifiedConnectedServiceUsageSourceV4,
    right: QualifiedConnectedServiceUsageSourceV4,
): boolean {
    if (
        !qualifiedConnectedAccountRefsEqual(
            left.ref,
            right.ref,
        )
        || left.bindingKind !== right.bindingKind
    ) {
        return false;
    }
    if (
        left.bindingKind === "group_member"
        && right.bindingKind === "group_member"
    ) {
        return left.groupId === right.groupId
            && left.groupGeneration
                === right.groupGeneration;
    }
    return true;
}

async function findQualifiedSourceRows(
    tx: QualifiedUsageStorage,
    params: Readonly<{
        accountId: string;
        source: QualifiedConnectedServiceUsageSourceV4;
    }>,
) {
    const source =
        QualifiedConnectedServiceUsageSourceV4Schema.parse(params.source);
    const qualifiedIdentityDigest =
        createQualifiedConnectedAccountIdentityDigest(source.ref);
    return await tx.connectedServiceUsageSource.findMany({
        where: {
            accountId: params.accountId,
            qualifiedIdentityDigest,
            bindingKind: source.bindingKind === "account"
                ? { in: ["account", "profile"] }
                : "group_member",
            ...(source.bindingKind === "group_member"
                ? {
                    groupId: source.groupId,
                    ...(source.groupGeneration !== undefined
                        ? { groupGeneration: source.groupGeneration }
                        : {}),
                }
                : {}),
        },
        include: {
            credential: {
                select: {
                    id: true,
                    accountId: true,
                    servicePluginId: true,
                    serviceLocalId: true,
                    qualifiedServiceDigest: true,
                    connectedAccountId: true,
                    qualifiedIdentityDigest: true,
                },
            },
        },
        orderBy: [
            { updatedAt: "desc" },
            { id: "asc" },
        ],
        take: 2,
    });
}

type ExactQualifiedConnectedServiceUsageSource = Readonly<{
    source: QualifiedConnectedServiceUsageSourceV4;
    recordId: string;
    providerAccountId: string;
    fetchedAt: number | null;
    staleAfterMs: number | null;
}>;

async function readExactQualifiedConnectedServiceUsageSourceWithCredentialAdmission(
    params: Readonly<{
        accountId: string;
        source: QualifiedConnectedServiceUsageSourceV4;
    }>,
    options: Readonly<{
        allowLegacyUnfencedCredential?: boolean;
    }> = {},
): Promise<ExactQualifiedConnectedServiceUsageSource | null> {
    try {
        return await inTx(async (tx) => {
            const binding =
                await resolveQualifiedUsageBinding(tx, {
                    ...params,
                    allowLegacyUnfencedCredential:
                        options.allowLegacyUnfencedCredential,
                });
            const rows = await findQualifiedSourceRows(tx, {
                accountId: params.accountId,
                source: binding.source,
            });
            if (rows.length === 0) return null;
            if (rows.length > 1) {
                throw new Error(
                    "Ambiguous qualified Connected Account usage source",
                );
            }
            const row = rows[0]!;
            const record =
                await tx.providerAccountUsageRecord.findUnique({
                    where: {
                        accountId_recordId: {
                            accountId: params.accountId,
                            recordId:
                                row.providerAccountUsageRecordId,
                        },
                    },
                    select: {
                        accountSubjectId: true,
                        subjectKind: true,
                        fetchedAt: true,
                        staleAfterMs: true,
                    },
                });
            if (!record) return null;
            assertQualifiedUsageOwnership({
                providerAccountId: binding.providerAccountId,
                recordAccountSubjectId: record.accountSubjectId,
                recordSubjectKind: record.subjectKind,
            });
            return {
                source: mapQualifiedSourceRow(row),
                recordId: row.providerAccountUsageRecordId,
                providerAccountId: record.accountSubjectId,
                fetchedAt: record.fetchedAt?.getTime() ?? null,
                staleAfterMs: record.staleAfterMs,
            };
        });
    } catch (error) {
        if (
            error instanceof ConnectedServiceUsageSourceBindingError
            && error.kind === "unavailable"
        ) {
            return null;
        }
        if (
            error instanceof ConnectedServiceUsageSourceOwnershipError
            && error.kind === "unproven"
        ) {
            return null;
        }
        throw error;
    }
}

export async function readExactQualifiedConnectedServiceUsageSource(
    params: Readonly<{
        accountId: string;
        source: QualifiedConnectedServiceUsageSourceV4;
    }>,
): Promise<ExactQualifiedConnectedServiceUsageSource | null> {
    return await readExactQualifiedConnectedServiceUsageSourceWithCredentialAdmission(
        params,
    );
}

export async function readLegacyConnectedServiceQuotaCompatibilitySource(
    params: Readonly<{
        accountId: string;
        source: QualifiedConnectedServiceUsageSourceV4;
    }>,
): Promise<ExactQualifiedConnectedServiceUsageSource | null> {
    return await readExactQualifiedConnectedServiceUsageSourceWithCredentialAdmission(
        params,
        { allowLegacyUnfencedCredential: true },
    );
}

async function upsertQualifiedSourceInTx(
    tx: QualifiedUsageStorage,
    params: Readonly<{
        accountId: string;
        providerAccountUsageRecordId: string;
        source: QualifiedConnectedServiceUsageSourceV4;
        allowLegacyUnfencedCredential?: boolean;
    }>,
) {
    const binding = await resolveQualifiedUsageBinding(tx, params);
    const record = await tx.providerAccountUsageRecord.findUnique({
        where: {
            accountId_recordId: {
                accountId: params.accountId,
                recordId: params.providerAccountUsageRecordId,
            },
        },
        select: {
            accountSubjectId: true,
            subjectKind: true,
        },
    });
    if (!record) {
        throw new ConnectedServiceUsageSourceOwnershipError(
            "Provider usage record does not belong to account",
        );
    }
    assertQualifiedUsageOwnership({
        providerAccountId: binding.providerAccountId,
        recordAccountSubjectId: record.accountSubjectId,
        recordSubjectKind: record.subjectKind,
    });
    const sourceKey = buildQualifiedUsageSourceKey(binding.source);
    const source = binding.source;
    const existing =
        await tx.connectedServiceUsageSource.findUnique({
            where: {
                accountId_sourceKey: {
                    accountId: params.accountId,
                    sourceKey,
                },
            },
            include: {
                credential: {
                    select: {
                        id: true,
                        accountId: true,
                        servicePluginId: true,
                        serviceLocalId: true,
                        qualifiedServiceDigest: true,
                        connectedAccountId: true,
                        qualifiedIdentityDigest: true,
                    },
                },
            },
        });
    if (
        existing
        && !qualifiedUsageSourcesEqual(
            mapQualifiedSourceRow(existing),
            source,
        )
    ) {
        throw new ConnectedServiceUsageSourceBindingError(
            "Stored qualified Connected Account usage source does not match its lookup identity",
        );
    }
    await tx.connectedServiceUsageSource.upsert({
        where: {
            accountId_sourceKey: {
                accountId: params.accountId,
                sourceKey,
            },
        },
        create: {
            accountId: params.accountId,
            serviceId: binding.credential.vendor,
            profileId: binding.credential.profileId,
            servicePluginId: binding.credential.servicePluginId,
            serviceLocalId: binding.credential.serviceLocalId,
            qualifiedServiceDigest:
                binding.credential.qualifiedServiceDigest,
            connectedAccountId:
                binding.credential.connectedAccountId,
            qualifiedIdentityDigest:
                binding.credential.qualifiedIdentityDigest,
            credentialId: binding.credential.id,
            sourceKey,
            providerAccountUsageRecordId:
                params.providerAccountUsageRecordId,
            bindingKind: source.bindingKind,
            ...(source.bindingKind === "group_member"
                ? {
                    groupId: source.groupId,
                    groupGeneration: source.groupGeneration ?? null,
                }
                : {}),
        },
        update: {
            providerAccountUsageRecordId:
                params.providerAccountUsageRecordId,
            bindingKind: source.bindingKind,
            groupId: source.bindingKind === "group_member"
                ? source.groupId
                : null,
            groupGeneration: source.bindingKind === "group_member"
                ? source.groupGeneration ?? null
                : null,
            servicePluginId: binding.credential.servicePluginId,
            serviceLocalId: binding.credential.serviceLocalId,
            qualifiedServiceDigest:
                binding.credential.qualifiedServiceDigest,
            connectedAccountId:
                binding.credential.connectedAccountId,
            qualifiedIdentityDigest:
                binding.credential.qualifiedIdentityDigest,
            credentialId: binding.credential.id,
        },
    });
    if (source.bindingKind === "group_member") {
        await tx.connectedServiceUsageSource.deleteMany({
            where: {
                accountId: params.accountId,
                credentialId: binding.credential.id,
                bindingKind: "group_member",
                groupId: source.groupId,
                sourceKey: { not: sourceKey },
            },
        });
    } else {
        await tx.connectedServiceUsageSource.deleteMany({
            where: {
                accountId: params.accountId,
                credentialId: binding.credential.id,
                bindingKind: { in: ["account", "profile"] },
                sourceKey: { not: sourceKey },
            },
        });
    }
}

type QualifiedProviderAccountUsageWriteParams =
    ProviderAccountUsageWritePolicyParams & Readonly<{
        source: QualifiedConnectedServiceUsageSourceV4;
    }>;

type QualifiedProviderAccountUsageWriteInTxParams =
    QualifiedProviderAccountUsageWriteParams & Readonly<{
        allowLegacyUnfencedCredential?: boolean;
    }>;

async function writeQualifiedProviderAccountUsageRecordInTx(
    tx: Tx,
    params: QualifiedProviderAccountUsageWriteInTxParams,
): Promise<Readonly<{
    record: StoredProviderAccountUsageRecord;
    sourceOutcome: ProviderAccountUsageSourceLinkOutcome;
}>> {
    const {
        source,
        allowLegacyUnfencedCredential,
        ...write
    } = params;
    // Source resolution owns revision/currentness admission. Run it before the
    // PAU write so an unfenced credential cannot create usage history.
    await resolveQualifiedUsageBinding(tx, {
        accountId: params.accountId,
        source,
        allowLegacyUnfencedCredential,
    });
    await writeProviderAccountUsageRecordWithPolicy({
        ...write,
        client: tx,
    });
    let sourceOutcome: ProviderAccountUsageSourceLinkOutcome;
    try {
        await upsertQualifiedSourceInTx(tx, {
            accountId: params.accountId,
            providerAccountUsageRecordId: params.recordId,
            source,
            allowLegacyUnfencedCredential,
        });
        sourceOutcome = { status: "linked" };
    } catch (error) {
        if (
            error instanceof ConnectedServiceUsageSourceBindingError
            && error.kind === "unavailable"
        ) {
            sourceOutcome = {
                status: "skipped",
                reason: "binding_unavailable",
            };
        } else if (
            error instanceof ConnectedServiceUsageSourceOwnershipError
            && error.kind === "unproven"
        ) {
            sourceOutcome = {
                status: "skipped",
                reason: "ownership_unproven",
            };
        } else {
            throw error;
        }
    }
    const record = await readProviderAccountUsageRecord({
        accountId: params.accountId,
        recordId: params.recordId,
    }, tx);
    if (!record) {
        throw new Error(
            "Provider usage record disappeared during qualified write",
        );
    }
    return { record, sourceOutcome };
}

export async function writeQualifiedProviderAccountUsageRecordFromLegacyBoundary(
    params: QualifiedProviderAccountUsageWriteParams,
): Promise<Readonly<{
    record: StoredProviderAccountUsageRecord;
    sourceOutcome: ProviderAccountUsageSourceLinkOutcome;
}>> {
    const serviceId =
        resolveLegacyServiceIdForQualifiedConnectedAccountService(
            params.source.ref.service,
        );
    if (!serviceId) {
        throw new ConnectedServiceUsageSourceBindingError(
            "Legacy usage source does not map to a built-in service",
        );
    }
    if (!isConnectedServiceUsageProviderCompatible({
        providerId: params.recordKey.providerId,
        serviceId,
    })) {
        throw new ConnectedServiceUsageSourceOwnershipError(
            "Provider account usage record is not compatible with the connected-service source",
        );
    }
    return await inTx(async (tx) =>
        await writeQualifiedProviderAccountUsageRecordInTx(
            tx,
            params,
        ));
}

export async function writeQualifiedProviderAccountUsageRecord(
    params: ProviderAccountUsageWritePolicyParams & Readonly<{
        source: QualifiedConnectedServiceUsageSourceV4;
        expectedCredentialRevision: string;
        expectedConfigurationRevision: string | null;
    }>,
): Promise<Readonly<{
    record: StoredProviderAccountUsageRecord;
    sourceOutcome: ProviderAccountUsageSourceLinkOutcome;
}>> {
    return await inTx(async (tx) => {
        const binding = await resolveQualifiedCredential(tx, {
            accountId: params.accountId,
            ref: params.source.ref,
        });
        const projection = resolveQualifiedConnectedAccountStoredMetadata({
            rowId: binding.credential.id,
            metadata: binding.credential.metadata,
        });
        if (
            projection.credentialRevision
                !== params.expectedCredentialRevision
        ) {
            throw new QualifiedConnectedAccountUsageBasisError({
                reason: "credential_revision_mismatch",
                credentialRevision: projection.credentialRevision,
                configurationRevision:
                    binding.credential.configurationRevision,
            });
        }
        if (
            binding.credential.configurationRevision
                !== params.expectedConfigurationRevision
        ) {
            throw new QualifiedConnectedAccountUsageBasisError({
                reason: "configuration_revision_mismatch",
                credentialRevision: projection.credentialRevision,
                configurationRevision:
                    binding.credential.configurationRevision,
            });
        }
        const locked = await tx.serviceAccountToken.updateMany({
            where: {
                id: binding.credential.id,
                updatedAt: binding.credential.updatedAt,
                configurationRevision:
                    params.expectedConfigurationRevision,
            },
            data: { updatedAt: binding.credential.updatedAt },
        });
        if (locked.count !== 1) {
            const latest = await resolveQualifiedCredential(tx, {
                accountId: params.accountId,
                ref: params.source.ref,
            });
            const latestProjection =
                resolveQualifiedConnectedAccountStoredMetadata({
                    rowId: latest.credential.id,
                    metadata: latest.credential.metadata,
                });
            throw new QualifiedConnectedAccountUsageBasisError({
                reason: "concurrent_mutation",
                credentialRevision:
                    latestProjection.credentialRevision,
                configurationRevision:
                    latest.credential.configurationRevision,
            });
        }
        const {
            source: _source,
            expectedCredentialRevision: _expectedCredentialRevision,
            expectedConfigurationRevision:
                _expectedConfigurationRevision,
            ...write
        } = params;
        return await writeQualifiedProviderAccountUsageRecordInTx(
            tx,
            {
                ...write,
                source: params.source,
            },
        );
    });
}

type LegacyConnectedServiceQuotaCompatibilityWriteParams = Readonly<{
    accountId: string;
    serviceId: ConnectedServiceId;
    profileId: string;
    status: ProviderAccountUsageWritePolicyParams["status"];
    fetchedAt: number;
    staleAfterMs: number;
}> & (
    | Readonly<{
        payloadMode: "plain_json_v1";
        snapshot: ConnectedServiceQuotaSnapshotV1;
    }>
    | Readonly<{
        payloadMode: "sealed_account_scoped_v1";
        sealed: SealedConnectedServiceQuotaSnapshotV1;
    }>
);

function projectLegacyQuotaSourceToProviderAccountUsage(
    source: ConnectedServiceQuotaSnapshotV1["source"],
) {
    switch (source) {
        case "in_band_provider_snapshot":
            return "runtimeSignal" as const;
        case "provider_api":
            return "providerHttp" as const;
        case "background_fetch":
            return "proxy" as const;
        case "user_probe":
            return "connectedServiceProbe" as const;
        case "cached":
            return "cached" as const;
        case "manual_refresh":
            return "manual" as const;
        default:
            return "unknown" as const;
    }
}

function projectLegacyQuotaConfidenceToProviderAccountUsage(
    confidence: ConnectedServiceQuotaSnapshotV1["confidence"],
) {
    if (confidence === "exact") return "confirmed" as const;
    if (confidence === "estimated") return "estimated" as const;
    return "unknown" as const;
}

function buildLegacyConnectedServiceQuotaProviderAccountUsageSnapshot(
    params: Readonly<{
        serviceId: ConnectedServiceId;
        providerAccountId: string;
        snapshot: ConnectedServiceQuotaSnapshotV1;
    }>,
) {
    const recordKey = {
        providerId: params.serviceId,
        accountSubjectId: params.providerAccountId,
        subjectKind: "account",
        quotaScope: "account",
    } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    return {
        recordId,
        recordKey,
        snapshot: ProviderAccountUsageSnapshotV1Schema.parse({
            v: 1,
            recordId,
            recordKey,
            providerId: params.serviceId,
            accountSubject: {
                kind: "providerSubject",
                id: params.providerAccountId,
            },
            observedAtMs: params.snapshot.fetchedAt,
            fetchedAtMs: params.snapshot.fetchedAt,
            staleAfterMs: params.snapshot.staleAfterMs,
            source: projectLegacyQuotaSourceToProviderAccountUsage(
                params.snapshot.source,
            ),
            confidence: projectLegacyQuotaConfidenceToProviderAccountUsage(
                params.snapshot.confidence,
            ),
            planLabel: params.snapshot.planLabel,
            accountLabel: params.snapshot.accountLabel,
            ...(params.snapshot.recoveryCredits
                ? { recoveryCredits: params.snapshot.recoveryCredits }
                : {}),
            meters: params.snapshot.meters,
        }),
    };
}

async function assertLegacyConnectedServiceQuotaCredentialCurrentInTx(
    tx: QualifiedUsageStorage,
    params: Readonly<{
        accountId: string;
        credential: Readonly<{
            id: string;
            accountId: string;
            updatedAt: Date;
            configurationRevision: string | null;
        }>;
    }>,
): Promise<void> {
    const locked = await tx.serviceAccountToken.updateMany({
        where: {
            id: params.credential.id,
            accountId: params.accountId,
            updatedAt: params.credential.updatedAt,
            configurationRevision: params.credential.configurationRevision,
        },
        // This is a compare-and-swap fence only: it preserves the stored
        // credential bytes and metadata while proving the resolved binding is
        // still the current row that owns this compatibility write.
        data: { updatedAt: params.credential.updatedAt },
    });
    if (locked.count !== 1) {
        throw new ConnectedServiceUsageSourceBindingError(
            "Legacy connected-service quota credential changed before write",
            "unavailable",
        );
    }
}

export async function writeLegacyConnectedServiceQuotaCompatibilityRecord(
    params: LegacyConnectedServiceQuotaCompatibilityWriteParams,
): Promise<void> {
    const source = {
        ref: {
            service: resolveLegacyQualifiedConnectedAccountService(
                params.serviceId,
            ),
            accountId: params.profileId,
        },
        bindingKind: "account" as const,
    };
    await inTx(async (tx) => {
        const binding = await resolveQualifiedUsageBinding(tx, {
            accountId: params.accountId,
            source,
            allowLegacyUnfencedCredential: true,
        });
        if (binding.providerAccountId === null) {
            throw new ConnectedServiceUsageSourceOwnershipError(
                "Legacy connected-service quota lacks a provider account identity",
                "unproven",
            );
        }
        await assertLegacyConnectedServiceQuotaCredentialCurrentInTx(tx, {
            accountId: params.accountId,
            credential: binding.credential,
        });

        if (params.payloadMode === "plain_json_v1") {
            if (
                params.snapshot.fetchedAt !== params.fetchedAt
                || params.snapshot.staleAfterMs !== params.staleAfterMs
            ) {
                throw new ProviderAccountUsagePayloadInvariantError(
                    "Legacy connected-service quota metadata does not match snapshot timing",
                );
            }
            const providerUsage =
                buildLegacyConnectedServiceQuotaProviderAccountUsageSnapshot({
                    serviceId: params.serviceId,
                    providerAccountId: binding.providerAccountId,
                    snapshot: params.snapshot,
                });
            const result =
                await writeQualifiedProviderAccountUsageRecordInTx(tx, {
                    accountId: params.accountId,
                    recordId: providerUsage.recordId,
                    recordKey: providerUsage.recordKey,
                    payloadMode: "plain_json_v1",
                    status: params.status,
                    fetchedAt: params.fetchedAt,
                    staleAfterMs: params.staleAfterMs,
                    snapshot: providerUsage.snapshot,
                    source,
                    allowLegacyUnfencedCredential: true,
                });
            if (result.sourceOutcome.status !== "linked") {
                throw new ConnectedServiceUsageSourceBindingError(
                    "Legacy connected-service quota source could not be linked",
                    "unavailable",
                );
            }
            return;
        }

        if (readAccountScopedCiphertextKindByte(params.sealed.ciphertext) !== 4) {
            throw new ProviderAccountUsagePayloadInvariantError(
                "Legacy connected-service quota ciphertext has an unsupported kind",
            );
        }
        const recordKey = {
            providerId: params.serviceId,
            accountSubjectId: binding.providerAccountId,
            subjectKind: "account",
            quotaScope: "account",
        } as const;
        const result =
            await writeQualifiedProviderAccountUsageRecordInTx(tx, {
                accountId: params.accountId,
                recordId: buildProviderAccountUsageRecordId(recordKey),
                recordKey,
                payloadMode: "sealed_account_scoped_v1",
                status: params.status,
                fetchedAt: params.fetchedAt,
                staleAfterMs: params.staleAfterMs,
                sealedPayload: params.sealed,
                legacyQuotaCompatibility: {
                    source: {
                        serviceId: params.serviceId,
                        profileId: params.profileId,
                        bindingKind: "profile",
                    },
                    sealed: params.sealed,
                },
                source,
                allowLegacyUnfencedCredential: true,
            });
        if (result.sourceOutcome.status !== "linked") {
            throw new ConnectedServiceUsageSourceBindingError(
                "Legacy connected-service quota source could not be linked",
                "unavailable",
            );
        }
    });
}

async function listQualifiedUsageSourcesForRecordInStorage(
    storage: QualifiedUsageStorage,
    params: Readonly<{ accountId: string; recordId: string }>,
): Promise<QualifiedConnectedServiceUsageSourceV4[]> {
    const rows = await storage.connectedServiceUsageSource.findMany({
        where: {
            accountId: params.accountId,
            providerAccountUsageRecordId: params.recordId,
            bindingKind: {
                in: ["account", "profile", "group_member"],
            },
        },
        include: {
            credential: {
                select: {
                    id: true,
                    accountId: true,
                    servicePluginId: true,
                    serviceLocalId: true,
                    qualifiedServiceDigest: true,
                    connectedAccountId: true,
                    qualifiedIdentityDigest: true,
                },
            },
        },
        orderBy: [
            { qualifiedServiceDigest: "asc" },
            { qualifiedIdentityDigest: "asc" },
            { sourceKey: "asc" },
        ],
    });
    // Every source the record is linked through. Sources are derived from the
    // credential and group lists — one per account binding plus one per group
    // membership — so they carry no capacity of their own, and this reader also
    // decides whether the record's DELETE and refresh routes can see it at all.
    return rows.map(mapQualifiedSourceRow);
}

export async function listQualifiedUsageSourcesForRecord(
    params: Readonly<{ accountId: string; recordId: string }>,
): Promise<QualifiedConnectedServiceUsageSourceV4[]> {
    return await listQualifiedUsageSourcesForRecordInStorage(db, params);
}

export async function readQualifiedProviderAccountUsageRecord(
    params: Readonly<{ accountId: string; recordId: string }>,
): Promise<Readonly<{
    record: StoredProviderAccountUsageRecord;
    sources: QualifiedConnectedServiceUsageSourceV4[];
}> | null> {
    return await inTx(async (tx) => {
        const sources = await listQualifiedUsageSourcesForRecordInStorage(
            tx,
            params,
        );
        if (sources.length === 0) return null;
        const record = await readProviderAccountUsageRecord(params, tx);
        return record ? { record, sources } : null;
    });
}

export async function deleteQualifiedProviderAccountUsageRecord(
    params: Readonly<{ accountId: string; recordId: string }>,
): Promise<"deleted" | "not_found"> {
    return await inTx(async (tx) => {
        const sources = await listQualifiedUsageSourcesForRecordInStorage(
            tx,
            params,
        );
        if (sources.length === 0) return "not_found";
        for (const source of sources) {
            try {
                await resolveQualifiedCredential(tx, {
                    accountId: params.accountId,
                    ref: source.ref,
                });
            } catch (error) {
                if (
                    error instanceof ConnectedServiceUsageSourceBindingError
                    && error.kind === "unavailable"
                ) {
                    return "not_found";
                }
                throw error;
            }
        }
        return await deleteProviderAccountUsageRecord(params, tx);
    });
}

export async function clearQualifiedConnectedAccountUsageForAccountInTx(
    tx: QualifiedUsageStorage,
    params: Readonly<{ accountId: string }>,
): Promise<Readonly<{
    deletedSources: number;
    deletedRecords: number;
}>> {
    const deletedSources = await tx.connectedServiceUsageSource.deleteMany({
        where: { accountId: params.accountId },
    });
    const deletedRecords =
        await deleteProviderAccountUsageRecordsForAccount(params, tx);
    return {
        deletedSources: deletedSources.count,
        deletedRecords,
    };
}

export async function requestQualifiedProviderAccountUsageRefresh(
    params: Readonly<{ accountId: string; recordId: string }>,
): Promise<"written" | "not_found"> {
    return await inTx(async (tx) => {
        const sources = await listQualifiedUsageSourcesForRecordInStorage(
            tx,
            params,
        );
        if (sources.length === 0) return "not_found";
        for (const source of sources) {
            try {
                await resolveQualifiedCredential(tx, {
                    accountId: params.accountId,
                    ref: source.ref,
                });
            } catch (error) {
                if (
                    error instanceof ConnectedServiceUsageSourceBindingError
                    && error.kind === "unavailable"
                ) {
                    return "not_found";
                }
                throw error;
            }
        }
        return await requestProviderAccountUsageRefresh(params, tx);
    });
}

async function readFirstQualifiedSourceForRef(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
        allowLegacyUnfencedCredential?: boolean;
    }>,
) {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const qualifiedIdentityDigest =
        createQualifiedConnectedAccountIdentityDigest(ref);
    try {
        return await inTx(async (tx) => {
            const binding = await resolveQualifiedCredential(tx, {
                accountId: params.accountId,
                ref,
                allowLegacyUnfencedCredential:
                    params.allowLegacyUnfencedCredential,
            });
            // Account-level quota reads remain owned by the current credential
            // and provider subject. A stored group generation is provenance;
            // exact group-context reads validate it separately.
            const rows = await tx.connectedServiceUsageSource.findMany({
                where: {
                    accountId: params.accountId,
                    qualifiedIdentityDigest,
                    credentialId: binding.credential.id,
                    bindingKind: {
                        in: ["account", "profile", "group_member"],
                    },
                },
                include: {
                    credential: {
                        select: {
                            id: true,
                            accountId: true,
                            servicePluginId: true,
                            serviceLocalId: true,
                            qualifiedServiceDigest: true,
                            connectedAccountId: true,
                            qualifiedIdentityDigest: true,
                        },
                    },
                },
                orderBy: [
                    { bindingKind: "asc" },
                    { updatedAt: "desc" },
                    { id: "asc" },
                ],
                take: 50,
            });
            for (const row of rows) {
                const record =
                    await tx.providerAccountUsageRecord.findUnique({
                        where: {
                            accountId_recordId: {
                                accountId: params.accountId,
                                recordId:
                                    row.providerAccountUsageRecordId,
                            },
                        },
                        select: {
                            accountSubjectId: true,
                            subjectKind: true,
                            fetchedAt: true,
                            staleAfterMs: true,
                        },
                    });
                if (!record) continue;
                try {
                    assertQualifiedUsageOwnership({
                        providerAccountId: binding.providerAccountId,
                        recordAccountSubjectId: record.accountSubjectId,
                        recordSubjectKind: record.subjectKind,
                    });
                } catch (error) {
                    if (
                        error instanceof ConnectedServiceUsageSourceOwnershipError
                        && error.kind === "unproven"
                    ) {
                        continue;
                    }
                    throw error;
                }
                return {
                    source: mapQualifiedSourceRow(row),
                    recordId: row.providerAccountUsageRecordId,
                    providerAccountId: record.accountSubjectId,
                    fetchedAt: record.fetchedAt?.getTime() ?? null,
                    staleAfterMs: record.staleAfterMs,
                };
            }
            return null;
        });
    } catch (error) {
        if (
            error instanceof ConnectedServiceUsageSourceBindingError
            && error.kind === "unavailable"
        ) {
            return null;
        }
        if (
            error instanceof ConnectedServiceUsageSourceOwnershipError
            && error.kind === "unproven"
        ) {
            return null;
        }
        throw error;
    }
}

export async function readQualifiedConnectedAccountUsageRecord(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<StoredProviderAccountUsageRecord | null> {
    const resolved =
        await readQualifiedConnectedAccountUsageRecordWithSource(params);
    return resolved?.record ?? null;
}

async function readQualifiedConnectedAccountUsageRecordWithSource(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<Readonly<{
    sourceResolution:
        QualifiedConnectedServiceUsageSourceResolutionV4;
    record: StoredProviderAccountUsageRecord;
}> | null> {
    const source = await readFirstQualifiedSourceForRef(params);
    if (!source) return null;
    const record = await readProviderAccountUsageRecord({
        accountId: params.accountId,
        recordId: source.recordId,
    });
    if (!record || record.recordId !== source.recordId) return null;
    return {
        sourceResolution: source,
        record,
    };
}

export async function readQualifiedConnectedAccountQuota(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
) {
    const resolved =
        await readQualifiedConnectedAccountUsageRecordWithSource(
            params,
        );
    if (!resolved) return null;
    const { record, sourceResolution } = resolved;
    const metadata = {
        fetchedAt:
            record.fetchedAt
            ?? record.snapshot?.fetchedAtMs
            ?? 0,
        staleAfterMs:
            record.staleAfterMs
            ?? record.snapshot?.staleAfterMs
            ?? 0,
        status: record.status === "unavailable"
            || record.status === "estimated"
            || record.status === "error"
            ? record.status
            : "ok" as const,
        ...(record.refreshRequestedAt !== undefined
            ? { refreshRequestedAt: record.refreshRequestedAt }
            : {}),
    };
    if (record.payloadMode === "sealed_account_scoped_v1") {
        if (!record.sealedPayload) return null;
        return {
            ref: params.ref,
            sourceResolution,
            content: {
                t: "encrypted" as const,
                c: record.sealedPayload.ciphertext,
            },
            metadata,
        };
    }
    if (!record.snapshot) return null;
    const quota =
        projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4({
        ref: params.ref,
        snapshot: record.snapshot,
    });
    return {
        ref: params.ref,
        sourceResolution,
        content: {
            t: "plain" as const,
            v: quota,
        },
        metadata,
    };
}

async function unlinkQualifiedConnectedAccountQuotaWithCredentialAdmission(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
        allowLegacyUnfencedCredential?: boolean;
    }>,
): Promise<"removed" | "not_found"> {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const qualifiedIdentityDigest =
        createQualifiedConnectedAccountIdentityDigest(ref);
    return await inTx(async (tx) => {
        try {
            await resolveQualifiedCredential(tx, {
                accountId: params.accountId,
                ref,
                allowLegacyUnfencedCredential:
                    params.allowLegacyUnfencedCredential,
            });
        } catch (error) {
            if (
                error instanceof ConnectedServiceUsageSourceBindingError
                && error.kind === "unavailable"
            ) {
                return "not_found";
            }
            throw error;
        }
        const rows = await tx.connectedServiceUsageSource.findMany({
            where: {
                accountId: params.accountId,
                qualifiedIdentityDigest,
            },
            include: {
                credential: {
                    select: {
                        id: true,
                        accountId: true,
                        servicePluginId: true,
                        serviceLocalId: true,
                        qualifiedServiceDigest: true,
                        connectedAccountId: true,
                        qualifiedIdentityDigest: true,
                    },
                },
            },
        });
        if (rows.length === 0) return "not_found";
        for (const row of rows) {
            const source = mapQualifiedSourceRow(row);
            if (!qualifiedConnectedAccountRefsEqual(source.ref, ref)) {
                throw new ConnectedServiceUsageSourceBindingError(
                    "Stored qualified Connected Account usage source does not match its unlink identity",
                );
            }
        }
        const deleted =
            await tx.connectedServiceUsageSource.deleteMany({
                where: {
                    accountId: params.accountId,
                    id: { in: rows.map((row) => row.id) },
                },
            });
        if (deleted.count !== rows.length) {
            throw new ConnectedServiceUsageSourceBindingError(
                "Qualified Connected Account usage sources changed during unlink",
            );
        }
        return "removed";
    });
}

export async function unlinkQualifiedConnectedAccountQuota(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<"removed" | "not_found"> {
    return await unlinkQualifiedConnectedAccountQuotaWithCredentialAdmission(
        params,
    );
}

export async function unlinkLegacyConnectedServiceQuotaCompatibilitySource(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<"removed" | "not_found"> {
    return await unlinkQualifiedConnectedAccountQuotaWithCredentialAdmission({
        ...params,
        allowLegacyUnfencedCredential: true,
    });
}

export async function requestQualifiedConnectedAccountQuotaRefresh(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<"written" | "not_found"> {
    const source = await readFirstQualifiedSourceForRef(params);
    if (!source) return "not_found";
    return await requestProviderAccountUsageRefresh({
        accountId: params.accountId,
        recordId: source.recordId,
    });
}

export async function requestLegacyConnectedServiceQuotaCompatibilityRefresh(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<"written" | "not_found"> {
    const source = await readFirstQualifiedSourceForRef({
        ...params,
        allowLegacyUnfencedCredential: true,
    });
    if (!source) return "not_found";
    return await requestProviderAccountUsageRefresh({
        accountId: params.accountId,
        recordId: source.recordId,
    });
}
