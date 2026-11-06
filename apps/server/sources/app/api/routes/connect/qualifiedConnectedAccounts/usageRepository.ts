import { createHash } from "node:crypto";
import { buildProviderAccountUsageRefreshChangeV1 } from '@happier-dev/protocol/changes';
import { acquireAccountChangePublicationLocksInTx, markAccountChanged } from '@/app/changes/markAccountChanged';

import { isProviderAccountUsageOrganizationContextMatch } from '@happier-dev/protocol/connect/accountUsage';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema, ProviderAccountUsageRecordKeyV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { QualifiedConnectedAccountRefSchema, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4, type QualifiedConnectedServiceUsageSourceResolutionV4, type QualifiedConnectedServiceUsageSourceV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedServiceUsageSourceV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { readAccountScopedCiphertextKindByte, isAccountScopedBlobCiphertextForKind } from '@happier-dev/protocol/crypto/accountScopedCipherEnvelope';
import type { ProviderAccountUsagePageProjectionWriteV1Schema } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { readProviderAccountUsagePageProjection, writeProviderAccountUsagePageProjection } from '../providerAccountUsage/pageProjectionStorage';
import { type ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import { type ConnectedServiceQuotaSnapshotV1, type SealedConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { isConnectedServiceUsageProviderCompatible } from "@happier-dev/agents";

import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { db } from "@/storage/db";
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import {
    deleteProviderAccountUsageRecord,
    deleteProviderAccountUsageRecordsForAccount,
    readProviderAccountUsageRecord,
    readProviderAccountUsageHistoryWitness,
    readProviderAccountUsageHistoryPageRows,
    readProviderAccountUsageHistoryWitnessRow,
    parseProviderAccountUsageHistoryEntry,
    projectSealedProviderAccountUsageContentV4,
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
import { deleteReleasedConnectedServiceQuotaSnapshotInStorage } from "./legacyQuotaSnapshotCompatibility";
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
    | "account"
    | "serviceAccountToken"
    | "connectedServiceAuthGroup"
    | "connectedServiceAuthGroupMember"
    | "connectedServiceUsageSource"
    | "providerAccountUsageRecord"
    | "serviceAccountQuotaSnapshot"
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
        providerOrganizationId:
            metadata.presentation.providerIdentity?.organizationId ?? null,
    };
}

async function resolveQualifiedUsageBinding(
    tx: QualifiedUsageStorage,
    params: Readonly<{
        accountId: string;
        source: QualifiedConnectedServiceUsageSourceV4;
        allowLegacyUnfencedCredential?: boolean;
        fenceGroupMembership?: boolean;
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
                    updatedAt: true,
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
        let admittedGeneration = group.generation;
        if (params.fenceGroupMembership) {
            const fenced = await tx.connectedServiceAuthGroupMember.updateMany({
                where: {
                    groupDbId: group.id,
                    credentialId: binding.credential.id,
                    accountId: params.accountId,
                    enabled: true,
                    updatedAt: member.updatedAt,
                },
                // Like credential admission, retain the tuple lock without
                // changing metadata. Lifecycle removal waits for source insertion
                // and then removes its committed sources in its current statement view.
                data: { updatedAt: member.updatedAt },
            });
            if (fenced.count !== 1) {
                throw new ConnectedServiceUsageSourceBindingError(
                    "Qualified Connected Account group member is unavailable",
                    "unavailable",
                );
            }
            const currentGroup = await tx.connectedServiceAuthGroup.findUnique({
                where: { id: group.id }, select: { generation: true },
            });
            if (!currentGroup) {
                throw new ConnectedServiceUsageSourceBindingError(
                    "Qualified Connected Account group binding does not exist",
                    "unavailable",
                );
            }
            admittedGeneration = currentGroup.generation;
        }
        if (
            source.groupGeneration !== undefined
            && source.groupGeneration !== admittedGeneration
        ) {
            throw new ConnectedServiceUsageSourceBindingError(
                "Qualified Connected Account group generation is stale",
                "unavailable",
            );
        }
        groupGeneration = source.groupGeneration ?? admittedGeneration;
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
            providerOrganizationId: binding.providerOrganizationId,
        };
    }
    return {
        source,
        credential: binding.credential,
        providerAccountId: binding.providerAccountId,
        providerOrganizationId: binding.providerOrganizationId,
    };
}

function assertQualifiedUsageOwnership(params: Readonly<{
    providerAccountId: string | null;
    providerOrganizationId: string | null;
    recordAccountSubjectId: string;
    recordSubjectKind: string;
    recordQuotaScope: string;
    recordQuotaScopeId: string | null;
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
    if ((params.providerOrganizationId !== null || params.recordQuotaScope === 'organization')
        && !isProviderAccountUsageOrganizationContextMatch({
        accountSubjectId: params.recordAccountSubjectId,
        subjectKind: params.recordSubjectKind,
        quotaScope: ProviderAccountUsageRecordKeyV1Schema.shape.quotaScope.parse(params.recordQuotaScope),
        ...(params.recordQuotaScopeId ? { quotaScopeId: params.recordQuotaScopeId } : {}),
    }, { providerAccountId: params.providerAccountId, providerOrganizationId: params.providerOrganizationId })) {
        throw new ConnectedServiceUsageSourceOwnershipError(
            'Qualified Connected Account does not match the provider usage organization context',
            params.providerOrganizationId !== null ? 'mismatch' : 'unproven',
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
        return await inReadSnapshot(async (tx) => {
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
                        quotaScope: true,
                        quotaScopeId: true,
                        fetchedAt: true,
                        staleAfterMs: true,
                    },
                });
            if (!record) return null;
            assertQualifiedUsageOwnership({
                providerAccountId: binding.providerAccountId,
                providerOrganizationId: binding.providerOrganizationId,
                recordAccountSubjectId: record.accountSubjectId,
                recordSubjectKind: record.subjectKind,
                recordQuotaScope: record.quotaScope,
                recordQuotaScopeId: record.quotaScopeId,
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
        beforeWrite?: () => Promise<void>;
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
            quotaScope: true,
            quotaScopeId: true,
        },
    });
    if (!record) {
        throw new ConnectedServiceUsageSourceOwnershipError(
            "Provider usage record does not belong to account",
        );
    }
    assertQualifiedUsageOwnership({
        providerAccountId: binding.providerAccountId,
        providerOrganizationId: binding.providerOrganizationId,
        recordAccountSubjectId: record.accountSubjectId,
        recordSubjectKind: record.subjectKind,
        recordQuotaScope: record.quotaScope,
        recordQuotaScopeId: record.quotaScopeId,
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
    const obsoleteWhere = {
        accountId: params.accountId,
        credentialId: binding.credential.id,
        ...(source.bindingKind === 'group_member'
            ? { bindingKind: 'group_member', groupId: source.groupId }
            : { bindingKind: { in: ['account', 'profile'] } }),
        sourceKey: { not: sourceKey },
    };
    const obsolete = await tx.connectedServiceUsageSource.findFirst({ where: obsoleteWhere, select: { id: true } });
    const linkChanged = !existing || existing.providerAccountUsageRecordId !== params.providerAccountUsageRecordId;
    if (!linkChanged && !obsolete) return;
    await params.beforeWrite?.();
    if (linkChanged) {
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
    }
    if (obsolete) await tx.connectedServiceUsageSource.deleteMany({ where: obsoleteWhere });
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
            beforeWrite: params.beforeWrite,
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
        ), { /* Compatibility writes reuse the Account-admitted PAU content CAS. */ isolationLevel: "ReadCommitted" });
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
        let needsFence = false;
        const fenceWrite = async () => {
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
            if (params.source.bindingKind === "group_member") {
                await resolveQualifiedUsageBinding(tx, {
                    accountId: params.accountId,
                    source: params.source,
                    fenceGroupMembership: true,
                });
            }
        };
        const {
            source: _source,
            expectedCredentialRevision: _expectedCredentialRevision,
            expectedConfigurationRevision:
                _expectedConfigurationRevision,
            ...write
        } = params;
        const result = await writeQualifiedProviderAccountUsageRecordInTx(
            tx,
            {
                ...write,
                source: params.source,
                beforeWrite: async () => { needsFence = true; },
            },
        );
        // Publication can wait on the shared Account row. Do not hold the
        // credential/member tuples across that wait: their lifecycle writers
        // acquire Account first. A failed final CAS still rolls back the entire
        // observation/source write, while a no-op takes no credential lock.
        if (needsFence) await fenceWrite();
        return result;
    }, { transactionClass: "qualified-provider-account-usage.write" });
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
            ...(params.snapshot.recoveryCreditDetails
                ? { recoveryCreditDetails: params.snapshot.recoveryCreditDetails }
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
            await deleteReleasedConnectedServiceQuotaSnapshotInStorage(tx, params);
            await assertLegacyConnectedServiceQuotaCredentialCurrentInTx(tx, {
                accountId: params.accountId,
                credential: binding.credential,
            });
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
        await deleteReleasedConnectedServiceQuotaSnapshotInStorage(tx, params);
        // Match the qualified writer: validate the captured credential last so
        // Account publication never waits while holding its credential tuple.
        await assertLegacyConnectedServiceQuotaCredentialCurrentInTx(tx, {
            accountId: params.accountId,
            credential: binding.credential,
        });
    }, { /* Account admission, the usage content CAS and the final credential fence protect this account source. */ isolationLevel: "ReadCommitted" });
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
                    metadata: true,
                },
            },
            providerAccountUsageRecord: {
                select: { accountSubjectId: true, subjectKind: true, quotaScope: true, quotaScopeId: true },
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
    // membership — and must still match that credential's current provider context.
    // Sources carry no capacity of their own, and this reader also
    // decides whether the record's DELETE and refresh routes can see it at all.
    return rows.flatMap(row => {
        const source = mapQualifiedSourceRow(row);
        const metadata = resolveQualifiedConnectedAccountStoredMetadata({ rowId: row.credential.id, metadata: row.credential.metadata });
        try {
            assertQualifiedUsageOwnership({
                providerAccountId: metadata.presentation.providerIdentity?.accountId ?? null,
                providerOrganizationId: metadata.presentation.providerIdentity?.organizationId ?? null,
                recordAccountSubjectId: row.providerAccountUsageRecord.accountSubjectId,
                recordSubjectKind: row.providerAccountUsageRecord.subjectKind,
                recordQuotaScope: row.providerAccountUsageRecord.quotaScope,
                recordQuotaScopeId: row.providerAccountUsageRecord.quotaScopeId,
            });
        } catch (error) {
            if (error instanceof ConnectedServiceUsageSourceOwnershipError) return [];
            throw error;
        }
        return [source];
    });
}

export async function listQualifiedUsageSourcesForRecord(
    params: Readonly<{ accountId: string; recordId: string }>,
): Promise<QualifiedConnectedServiceUsageSourceV4[]> {
    return await listQualifiedUsageSourcesForRecordInStorage(db, params);
}

export async function readQualifiedProviderAccountUsageRecord(
    params: Readonly<{ accountId: string; recordId: string }>,
): Promise<QualifiedProviderAccountUsageAdmission> {
    return await inReadSnapshot(async (tx) =>
        await admitQualifiedProviderAccountUsageRecordInTx(tx, params));
}

export async function readQualifiedProviderAccountUsageHistory(params: Readonly<{ accountId: string }> & ReturnType<typeof import('@happier-dev/protocol/connect/providerAccountUsageHistory').QualifiedProviderAccountUsageHistoryRequestV4Schema.parse>): Promise<
    Exclude<QualifiedProviderAccountUsageAdmission, { status: 'resolved' }>
    | ({ status: 'resolved' } & Awaited<ReturnType<typeof readProviderAccountUsagePageProjection>>)
    | Readonly<{ status: 'resolved'; entries: ReturnType<typeof parseProviderAccountUsageHistoryEntry>[];
        nextCursor: Awaited<ReturnType<typeof readProviderAccountUsageHistoryPageRows>>['nextCursor']; sources: QualifiedConnectedServiceUsageSourceV4[] }>
> {
    const captured = await inReadSnapshot(async tx => {
        let admitted;
        try { admitted = await admitQualifiedProviderAccountUsageRecordInTx(tx, params); }
        catch (error) {
            if ('projection' in params && error instanceof ProviderAccountUsagePayloadInvariantError) return { status: 'storage_mode_mismatch' as const };
            throw error;
        }
        if (admitted.status !== 'resolved') return admitted;
        if ('projection' in params) {
            const stored = admitted.record.metadata?.pageProjection;
            if (stored && !projectionMatchesMode(stored, admitted.record)) return { status: 'storage_mode_mismatch' as const };
            try { return { status: 'resolved' as const, ...await readProviderAccountUsagePageProjection(params, tx, admitted.record) }; }
            catch (error) {
                if (error instanceof ProviderAccountUsagePayloadInvariantError) return { status: 'storage_mode_mismatch' as const };
                throw error;
            }
        }
        const historyPage = 'history' in params
            ? await readProviderAccountUsageHistoryPageRows(params, tx)
            : { entries: [await readProviderAccountUsageHistoryWitnessRow(params, tx)].filter((entry): entry is NonNullable<typeof entry> => entry !== null), nextCursor: null };
        return { status: 'resolved' as const, historyPage, payloadMode: admitted.record.payloadMode, sources: admitted.sources };
    });
    if (!('historyPage' in captured) || captured.historyPage === undefined) return captured;
    // Admission and row capture share one database snapshot. Decoding large
    // pages must not hold that connection through CPU work or HTTP delivery.
    const entries = captured.historyPage.entries.map(parseProviderAccountUsageHistoryEntry);
    if (entries.some(entry => entry.record.accountId !== params.accountId || entry.record.recordId !== params.recordId || entry.record.payloadMode !== captured.payloadMode)) return { status: 'storage_mode_mismatch' as const };
    return { status: 'resolved' as const, entries, nextCursor: captured.historyPage.nextCursor, sources: captured.sources };
}

function projectionMatchesMode(value: Pick<ReturnType<typeof ProviderAccountUsagePageProjectionWriteV1Schema.parse>, 'content'>, record: StoredProviderAccountUsageRecord) {
    return record.payloadMode === 'plain_json_v1' ? value.content.t === 'plain'
        : value.content.t === 'encrypted' && isAccountScopedBlobCiphertextForKind({ kind: 'provider_account_usage_page_projection', ciphertext: value.content.c });
}

/** Derived B materialization; accepted history and qualified source admission remain authoritative. */
export async function writeQualifiedProviderAccountUsagePageProjection(params: Readonly<{ accountId: string }> & ReturnType<typeof ProviderAccountUsagePageProjectionWriteV1Schema.parse>) {
    return await inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [params.accountId], { intent: 'content' });
        const admitted = await admitQualifiedProviderAccountUsageRecordInTx(tx, params);
        if (admitted.status !== 'resolved') return admitted.status;
        if (!projectionMatchesMode(params, admitted.record)) return 'storage_mode_mismatch' as const;
        const { accountId, ...value } = params;
        // Writes merge the raw persisted metadata, including unknown retained
        // fields that the admitted read projection intentionally drops.
        const projection = await writeProviderAccountUsagePageProjection({ accountId, value }, tx);
        if (!projection) return 'projection_conflict' as const;
        // A no-op can retain another writer's ciphertext. Acknowledge the
        // actual stored representation returned by the same admitted write,
        // without transferring its multi-MB metadata through Prisma again.
        const submittedCoverage = projection.recordId === value.recordId && projection.encoding === value.encoding
            && projection.demand.range.startAtMs === value.demand.range.startAtMs
            && projection.demand.range.endAtMs === value.demand.range.endAtMs
            && projection.observationCount === value.observationCount
            && projection.frontier?.id === value.frontier?.id
            && projection.frontier?.observedAtMs === value.frontier?.observedAtMs;
        // A concurrently retained wider document is not held by this producer.
        return { status: 'written' as const, projection: submittedCoverage ? projection : null };
    }, { /* Account mode admission and the full-content parent CAS protect the projection. */ isolationLevel: 'ReadCommitted' });
}

export async function deleteQualifiedProviderAccountUsageRecord(
    params: Readonly<{ accountId: string; recordId: string }>,
): Promise<"deleted" | "not_found" | "storage_mode_mismatch"> {
    return await inTx(async (tx) => {
        const admitted = await admitQualifiedProviderAccountUsageRecordInTx(
            tx,
            params,
        );
        if (admitted.status !== "resolved") return admitted.status;
        for (const source of admitted.sources) {
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
    }, { /* The keyed delete and its FK cascades are atomic; no prior value is written back. */ isolationLevel: "ReadCommitted" });
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
): Promise<"written" | "not_found" | "storage_mode_mismatch"> {
    return await inTx(async (tx) => {
        const admitted = await admitQualifiedProviderAccountUsageRecordInTx(
            tx,
            params,
        );
        if (admitted.status !== "resolved") return admitted.status;
        for (const source of admitted.sources) {
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
        return await requestProviderAccountUsageRefreshAndNotify(tx, params);
    }, { /* Refresh changes one scalar atomically and publishes only after a successful update. */ isolationLevel: "ReadCommitted" });
}

async function requestProviderAccountUsageRefreshAndNotify(
    tx: Tx,
    params: Readonly<{ accountId: string; recordId: string }>,
) {
    const result = await requestProviderAccountUsageRefresh(params, tx);
    if (result === 'written') {
        await markAccountChanged(tx, { accountId: params.accountId,
            ...buildProviderAccountUsageRefreshChangeV1(params.recordId) });
    }
    return result;
}

async function readFirstQualifiedSourceForRef(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
        allowLegacyUnfencedCredential?: boolean;
    }>,
    storage?: QualifiedUsageStorage,
) {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const qualifiedIdentityDigest =
        createQualifiedConnectedAccountIdentityDigest(ref);
    try {
        const readInStorage = async (tx: QualifiedUsageStorage) => {
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
                    providerAccountUsageRecord: {
                        select: {
                            accountSubjectId: true,
                            subjectKind: true,
                            quotaScope: true,
                            quotaScopeId: true,
                            fetchedAt: true,
                            staleAfterMs: true,
                        },
                    },
                },
                orderBy: [
                    { bindingKind: "asc" },
                    { updatedAt: "desc" },
                    { id: "asc" },
                ],
            });
            for (const row of rows) {
                const record = row.providerAccountUsageRecord;
                try {
                    assertQualifiedUsageOwnership({
                        providerAccountId: binding.providerAccountId,
                        providerOrganizationId: binding.providerOrganizationId,
                        recordAccountSubjectId: record.accountSubjectId,
                        recordSubjectKind: record.subjectKind,
                        recordQuotaScope: record.quotaScope,
                        recordQuotaScopeId: record.quotaScopeId,
                    });
                } catch (error) {
                    if (
                        error instanceof ConnectedServiceUsageSourceOwnershipError
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
        };
        return await (storage ? readInStorage(storage) : inReadSnapshot(readInStorage));
    } catch (error) {
        if (
            error instanceof ConnectedServiceUsageSourceBindingError
            && error.kind === "unavailable"
        ) {
            return null;
        }
        if (
            error instanceof ConnectedServiceUsageSourceOwnershipError
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
    return resolved.status === "resolved" ? resolved.record : null;
}

export async function readQualifiedConnectedAccountUsageRecordWithSource(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<Readonly<{
    status: "resolved";
    sourceResolution: QualifiedConnectedServiceUsageSourceResolutionV4;
    record: StoredProviderAccountUsageRecord;
}> | Readonly<{ status: "not_found" }> | Readonly<{ status: "storage_mode_mismatch" }>> {
    return await inReadSnapshot(async (tx) => {
        const source = await readFirstQualifiedSourceForRef(params, tx);
        if (!source) return { status: "not_found" as const };
        const admitted = await admitQualifiedProviderAccountUsageRecordInTx(tx, {
            accountId: params.accountId,
            recordId: source.recordId,
        });
        if (admitted.status !== "resolved") return admitted;
        return {
            status: "resolved" as const,
            sourceResolution: source,
            record: admitted.record,
        };
    });
}

/**
 * Reads the released V2 quota projection through the canonical PAU admission
 * owner. The adapter keeps the historical not-found surface while preserving
 * a typed storage-mode mismatch for the route to map to that same 404.
 */
export async function readLegacyConnectedServiceQuotaCompatibilityRecordWithSource(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<Readonly<{
    status: "resolved";
    sourceResolution: ExactQualifiedConnectedServiceUsageSource;
    record: StoredProviderAccountUsageRecord;
}> | Readonly<{ status: "not_found" }> | Readonly<{ status: "storage_mode_mismatch" }>> {
    return await inReadSnapshot(async (tx) => {
        const source = await readFirstQualifiedSourceForRef({
            ...params,
            allowLegacyUnfencedCredential: true,
        }, tx);
        if (!source) return { status: "not_found" as const };
        const admitted = await admitQualifiedProviderAccountUsageRecordInTx(
            tx,
            {
                accountId: params.accountId,
                recordId: source.recordId,
            },
        );
        if (admitted.status !== "resolved") return admitted;
        return {
            status: "resolved" as const,
            sourceResolution: source,
            record: admitted.record,
        };
    });
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
    if (resolved.status !== "resolved") return resolved;
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
            content: projectSealedProviderAccountUsageContentV4(record.sealedPayload),
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
): Promise<"removed" | "not_found" | "storage_mode_mismatch"> {
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
        const admittedRecordIds = new Set(rows.map((row) => row.providerAccountUsageRecordId));
        for (const recordId of admittedRecordIds) {
            const admitted = await admitQualifiedProviderAccountUsageRecordInTx(tx, {
                accountId: params.accountId,
                recordId,
            });
            if (admitted.status !== "resolved") return admitted.status;
        }
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
    }, { /* Exact source IDs and the affected-row check protect unlink without replacing shared usage. */ isolationLevel: "ReadCommitted" });
}

export async function unlinkQualifiedConnectedAccountQuota(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<"removed" | "not_found" | "storage_mode_mismatch"> {
    return await unlinkQualifiedConnectedAccountQuotaWithCredentialAdmission(
        params,
    );
}

export async function unlinkLegacyConnectedServiceQuotaCompatibilitySource(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<"removed" | "not_found" | "storage_mode_mismatch"> {
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
): Promise<"written" | "not_found" | "storage_mode_mismatch"> {
    return await inTx(async (tx) => {
        const source = await readFirstQualifiedSourceForRef(params, tx);
        if (!source) return "not_found";
        const admitted = await admitQualifiedProviderAccountUsageRecordInTx(tx, {
            accountId: params.accountId,
            recordId: source.recordId,
        });
        if (admitted.status !== "resolved") return admitted.status;
        return await requestProviderAccountUsageRefreshAndNotify(tx, {
            accountId: params.accountId,
            recordId: source.recordId,
        });
    }, { /* The admitted source selects an atomic scalar refresh, not a read-modify-write. */ isolationLevel: "ReadCommitted" });
}


export async function requestLegacyConnectedServiceQuotaCompatibilityRefresh(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<"written" | "not_found" | "storage_mode_mismatch"> {
    return await inTx(async (tx) => {
        const source = await readFirstQualifiedSourceForRef({
            ...params,
            allowLegacyUnfencedCredential: true,
        }, tx);
        if (!source) return "not_found";
        const admitted = await admitQualifiedProviderAccountUsageRecordInTx(tx, {
            accountId: params.accountId,
            recordId: source.recordId,
        });
        if (admitted.status !== "resolved") return admitted.status;
        return await requestProviderAccountUsageRefreshAndNotify(tx, {
            accountId: params.accountId,
            recordId: source.recordId,
        });
    }, { /* The legacy source adapter uses the same atomic refresh owner. */ isolationLevel: "ReadCommitted" });
}
type QualifiedProviderAccountUsageAdmission =
    | Readonly<{
        status: "resolved";
        record: StoredProviderAccountUsageRecord;
        sources: QualifiedConnectedServiceUsageSourceV4[];
    }>
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "storage_mode_mismatch" }>;

async function admitQualifiedProviderAccountUsageRecordInTx(
    tx: QualifiedUsageStorage,
    params: Readonly<{ accountId: string; recordId: string }>,
): Promise<QualifiedProviderAccountUsageAdmission> {
    const account = await tx.account.findUnique({
        where: { id: params.accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const currentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    if (currentness?.status !== "ready") {
        return { status: "storage_mode_mismatch" };
    }
    const sources = await listQualifiedUsageSourcesForRecordInStorage(
        tx,
        params,
    );
    if (sources.length === 0) return { status: "not_found" };
    const record = await readProviderAccountUsageRecord(params, tx);
    if (!record) return { status: "not_found" };
    const expectedPayloadMode =
        currentness.currentness.encryptionMode === "plain"
            ? "plain_json_v1"
            : "sealed_account_scoped_v1";
    if (record.payloadMode !== expectedPayloadMode) {
        return { status: "storage_mode_mismatch" };
    }
    return { status: "resolved", record, sources };
}
