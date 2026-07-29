import { createHash } from "node:crypto";

import {
    QualifiedConnectedAccountRefSchema,
    projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4,
    QualifiedConnectedServiceUsageSourceV4Schema,
    type QualifiedConnectedAccountRef,
    type QualifiedConnectedServiceUsageSourceResolutionV4,
    type QualifiedConnectedServiceUsageSourceV4,
} from "@happier-dev/protocol";
import { AGENTS_CORE } from "@happier-dev/agents";

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
    type ProviderAccountUsageSourceLinkOutcome,
    type StoredProviderAccountUsageRecord,
} from "../providerAccountUsage/types";
import {
    resolveQualifiedConnectedAccountStoredMetadata,
} from "./credentialStoredMetadataAdapter";
import {
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountIdentityDigest,
    createQualifiedConnectedAccountServiceDigest,
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

async function resolveQualifiedCredential(
    tx: QualifiedUsageStorage,
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
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
    if (
        credential.servicePluginId !== ref.service.pluginId
        || credential.serviceLocalId !== ref.service.localId
        || credential.connectedAccountId !== ref.accountId
        || credential.qualifiedServiceDigest
            !== createQualifiedConnectedAccountServiceDigest(ref.service)
        || credential.qualifiedIdentityDigest !== qualifiedIdentityDigest
    ) {
        throw new ConnectedServiceUsageSourceBindingError(
            "Qualified Connected Account binding identity mismatch",
        );
    }
    const metadata = resolveQualifiedConnectedAccountStoredMetadata({
        rowId: credential.id,
        metadata: credential.metadata,
    });
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
    }>,
) {
    const source =
        QualifiedConnectedServiceUsageSourceV4Schema.parse(params.source);
    const binding = await resolveQualifiedCredential(tx, {
        accountId: params.accountId,
        ref: source.ref,
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
                generation: true,
                qualifiedServiceDigest: true,
            },
        });
        if (
            !group
            || group.qualifiedServiceDigest
                !== binding.credential.qualifiedServiceDigest
        ) {
            throw new ConnectedServiceUsageSourceBindingError(
                "Qualified Connected Account group binding does not exist",
                "unavailable",
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
                select: { enabled: true },
            });
        if (!member?.enabled) {
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
    bindingKind: string;
    groupId: string | null;
    groupGeneration: number | null;
    credential: Readonly<{
        servicePluginId: string;
        serviceLocalId: string;
        connectedAccountId: string;
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
    return QualifiedConnectedServiceUsageSourceV4Schema.parse({
        ref: {
            service: {
                pluginId: row.credential.servicePluginId,
                localId: row.credential.serviceLocalId,
            },
            accountId: row.credential.connectedAccountId,
        },
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
                    servicePluginId: true,
                    serviceLocalId: true,
                    connectedAccountId: true,
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

export async function readExactQualifiedConnectedServiceUsageSource(
    params: Readonly<{
        accountId: string;
        source: QualifiedConnectedServiceUsageSourceV4;
    }>,
): Promise<Readonly<{
    source: QualifiedConnectedServiceUsageSourceV4;
    recordId: string;
    providerAccountId: string;
    fetchedAt: number | null;
    staleAfterMs: number | null;
}> | null> {
    try {
        return await inTx(async (tx) => {
            const binding =
                await resolveQualifiedUsageBinding(tx, params);
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

async function upsertQualifiedSourceInTx(
    tx: QualifiedUsageStorage,
    params: Readonly<{
        accountId: string;
        providerAccountUsageRecordId: string;
        source: QualifiedConnectedServiceUsageSourceV4;
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

async function writeQualifiedProviderAccountUsageRecordInTx(
    tx: Tx,
    params: QualifiedProviderAccountUsageWriteParams,
): Promise<Readonly<{
    record: StoredProviderAccountUsageRecord;
    sourceOutcome: ProviderAccountUsageSourceLinkOutcome;
}>> {
    const { source, ...write } = params;
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
    const providerId = params.recordKey.providerId.trim();
    const provider = Object.entries(AGENTS_CORE).find(
        ([agentId]) => agentId === providerId,
    )?.[1];
    if (
        providerId !== serviceId
        && provider?.connectedServices?.supportedServiceIds.includes(
            serviceId,
        ) !== true
    ) {
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
                    servicePluginId: true,
                    serviceLocalId: true,
                    connectedAccountId: true,
                },
            },
        },
        orderBy: [
            { qualifiedServiceDigest: "asc" },
            { qualifiedIdentityDigest: "asc" },
            { sourceKey: "asc" },
        ],
        take: 501,
    });
    if (rows.length > 500) {
        throw new Error(
            "Qualified provider usage source list limit exceeded",
        );
    }
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
        return await requestProviderAccountUsageRefresh(params, tx);
    });
}

async function readFirstQualifiedSourceForRef(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
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
                            servicePluginId: true,
                            serviceLocalId: true,
                            connectedAccountId: true,
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

export async function unlinkQualifiedConnectedAccountQuota(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<"removed" | "not_found"> {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const deleted = await db.connectedServiceUsageSource.deleteMany({
        where: {
            accountId: params.accountId,
            qualifiedIdentityDigest:
                createQualifiedConnectedAccountIdentityDigest(ref),
        },
    });
    return deleted.count > 0 ? "removed" : "not_found";
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
