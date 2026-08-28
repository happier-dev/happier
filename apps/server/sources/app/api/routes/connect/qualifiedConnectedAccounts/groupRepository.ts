import {
    ConnectedServiceAuthGroupMemberStateV1Schema,
    ConnectedServiceAuthGroupPolicyV1Schema,
    ConnectedServiceAuthGroupStateV1Schema,
    QualifiedConnectedAccountGroupCreateV4Schema,
    QualifiedConnectedAccountGroupMemberDeleteV4Schema,
    QualifiedConnectedAccountGroupMemberMutationV4Schema,
    QualifiedConnectedAccountGroupPatchV4Schema,
    QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema,
    QualifiedConnectedAccountGroupActiveAccountV4Schema,
    QualifiedConnectedAccountGroupRefSchema,
    QualifiedConnectedAccountGroupV4Schema,
    QualifiedConnectedAccountServiceRefSchema,
    readConnectedServiceManualActiveProfileRuntimeBlocker,
    type QualifiedConnectedAccountGroupV4,
    type QualifiedConnectedAccountServiceRef,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import {
    isPrismaErrorCode,
} from "@/storage/prisma";
import { recordConnectedServiceAccountProfileChange } from "../connectedServicesAccountProfileChange";
import {
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountIdentityDigest,
    createQualifiedConnectedAccountServiceDigest,
    parseStoredQualifiedConnectedAccountGroupRef,
    resolveLegacyServiceIdForQualifiedConnectedAccountService,
} from "./identity";
import {
    resolveQualifiedConnectedAccountStoredMetadata,
} from "./credentialStoredMetadataAdapter";

type QualifiedGroupRow = Readonly<{
    id: string;
    accountId: string;
    servicePluginId: string;
    serviceLocalId: string;
    qualifiedServiceDigest: string;
    qualifiedGroupDigest: string;
    groupId: string;
    displayName: string | null;
    policyJson: string;
    activeProfileId: string | null;
    activeConnectedAccountId: string | null;
    generation: number;
    runtimeStateRevision: number;
    stateJson: string | null;
    createdAt: Date;
    updatedAt: Date;
    members: ReadonlyArray<Readonly<{
        id?: string;
        credentialId?: string;
        profileId?: string | null;
        accountId: string;
        qualifiedServiceDigest: string;
        qualifiedGroupDigest: string;
        qualifiedIdentityDigest: string;
        priority: number;
        enabled: boolean;
        stateJson: string | null;
        createdAt: Date;
        updatedAt: Date;
        credential: Readonly<{
            id?: string;
            accountId: string;
            servicePluginId: string;
            serviceLocalId: string;
            qualifiedServiceDigest: string;
            connectedAccountId: string;
            qualifiedIdentityDigest: string;
            metadata?: unknown;
            configurationRevision?: string | null;
        }>;
    }>>;
}>;

function parseStoredJson<T>(
    schema: Readonly<{ parse(value: unknown): T }>,
    raw: string | null,
): T {
    return schema.parse(raw === null ? {} : JSON.parse(raw));
}

export function toQualifiedConnectedAccountGroup(
    row: QualifiedGroupRow,
): QualifiedConnectedAccountGroupV4 {
    const groupRef =
        parseStoredQualifiedConnectedAccountGroupRef(row);
    const service = groupRef.service;
    const serviceDigest =
        createQualifiedConnectedAccountServiceDigest(service);
    const groupDigest =
        createQualifiedConnectedAccountGroupDigest(groupRef);
    const members = row.members.map((member) => {
        const credential = member.credential;
        if (
            member.accountId !== row.accountId
            || credential.accountId !== row.accountId
            || member.qualifiedServiceDigest !== serviceDigest
            || credential.qualifiedServiceDigest !== serviceDigest
            || credential.servicePluginId !== service.pluginId
            || credential.serviceLocalId !== service.localId
        ) {
            throw new Error(
                "Qualified Connected Account group member service mismatch",
            );
        }
        if (
            member.qualifiedGroupDigest !== groupDigest
            || member.qualifiedIdentityDigest
                !== credential.qualifiedIdentityDigest
        ) {
            throw new Error(
                "Qualified Connected Account group member identity mismatch",
            );
        }
        const accountRef = {
            service,
            accountId: credential.connectedAccountId,
        };
        if (
            credential.qualifiedIdentityDigest
            !== createQualifiedConnectedAccountIdentityDigest(accountRef)
        ) {
            throw new Error(
                "Qualified Connected Account group member credential mismatch",
            );
        }
        return {
            v: 1 as const,
            connectedAccountId: credential.connectedAccountId,
            priority: member.priority,
            enabled: member.enabled,
            state: parseStoredJson(
                ConnectedServiceAuthGroupMemberStateV1Schema,
                member.stateJson,
            ),
            createdAt: member.createdAt.getTime(),
            updatedAt: member.updatedAt.getTime(),
        };
    });
    if (
        row.activeConnectedAccountId !== null
        && !members.some((member) =>
            member.connectedAccountId === row.activeConnectedAccountId
            && member.enabled)
    ) {
        throw new Error(
            "Qualified Connected Account group active account is not an enabled member",
        );
    }
    return QualifiedConnectedAccountGroupV4Schema.parse({
        v: 1,
        ref: groupRef,
        incarnation: row.id,
        displayName: row.displayName,
        policy: parseStoredJson(
            ConnectedServiceAuthGroupPolicyV1Schema,
            row.policyJson,
        ),
        activeConnectedAccountId: row.activeConnectedAccountId,
        generation: row.generation,
        runtimeStateRevision: row.runtimeStateRevision,
        state: parseStoredJson(
            ConnectedServiceAuthGroupStateV1Schema,
            row.stateJson,
        ),
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
        members,
    });
}

type QualifiedGroupListStorage = Pick<
    Tx,
    "connectedServiceAuthGroup"
>;

async function listQualifiedConnectedAccountGroupsByFilter(
    tx: QualifiedGroupListStorage,
    params: Readonly<{
        accountId: string;
        service?: QualifiedConnectedAccountServiceRef;
    }>,
): Promise<Array<Readonly<{
    group: QualifiedConnectedAccountGroupV4;
    activeProfileId: string | null;
}>>> {
    const service = params.service
        ? QualifiedConnectedAccountServiceRefSchema.parse(params.service)
        : null;
    const serviceDigest = service
        ? createQualifiedConnectedAccountServiceDigest(service)
        : null;
    const rows = await tx.connectedServiceAuthGroup.findMany({
        where: {
            accountId: params.accountId,
            ...(serviceDigest
                ? { qualifiedServiceDigest: serviceDigest }
                : {}),
        },
        include: {
            members: {
                orderBy: [
                    { priority: "asc" },
                    { createdAt: "asc" },
                    { id: "asc" },
                ],
                include: {
                    credential: {
                        select: {
                            accountId: true,
                            servicePluginId: true,
                            serviceLocalId: true,
                            qualifiedServiceDigest: true,
                            connectedAccountId: true,
                            qualifiedIdentityDigest: true,
                        },
                    },
                },
            },
        },
        orderBy: [
            { servicePluginId: "asc" },
            { serviceLocalId: "asc" },
            { groupId: "asc" },
            { id: "asc" },
        ],
    });
    const preparedRows = rows.filter((row) => {
        const canonicalValues = [
            row.servicePluginId,
            row.serviceLocalId,
            row.qualifiedServiceDigest,
            row.qualifiedGroupDigest,
        ];
        const presentCount = canonicalValues.filter(
            (value) => typeof value === "string" && value.length > 0,
        ).length;
        if (presentCount === 0 && service === null) return false;
        if (presentCount !== canonicalValues.length) {
            throw new Error(
                "Qualified Connected Account group identity is incomplete",
            );
        }
        return true;
    });
    return preparedRows.map((row) => ({
        group: toQualifiedConnectedAccountGroup(row),
        activeProfileId: row.activeProfileId,
    }));
}

export async function listAllQualifiedConnectedAccountGroupsInTx(
    tx: QualifiedGroupListStorage,
    params: Readonly<{ accountId: string }>,
): Promise<QualifiedConnectedAccountGroupV4[]> {
    const projections =
        await listQualifiedConnectedAccountGroupsByFilter(tx, params);
    return projections.map((projection) => projection.group);
}

export async function listAllQualifiedConnectedAccountGroupsForLegacyProjectionInTx(
    tx: QualifiedGroupListStorage,
    params: Readonly<{ accountId: string }>,
): Promise<Array<Readonly<{
    group: QualifiedConnectedAccountGroupV4;
    activeProfileId: string | null;
}>>> {
    return await listQualifiedConnectedAccountGroupsByFilter(tx, params);
}

export async function listQualifiedConnectedAccountGroups(
    params: Readonly<{
        accountId: string;
        service: QualifiedConnectedAccountServiceRef;
    }>,
): Promise<QualifiedConnectedAccountGroupV4[]> {
    const projections =
        await listQualifiedConnectedAccountGroupsByFilter(db, params);
    return projections.map((projection) => projection.group);
}

const qualifiedGroupInclude = {
    members: {
        orderBy: [
            { priority: "asc" as const },
            { createdAt: "asc" as const },
            { id: "asc" as const },
        ],
        include: {
            credential: {
                select: {
                    accountId: true,
                    servicePluginId: true,
                    serviceLocalId: true,
                    qualifiedServiceDigest: true,
                    connectedAccountId: true,
                    qualifiedIdentityDigest: true,
                    profileId: true,
                    id: true,
                    metadata: true,
                    configurationRevision: true,
                },
            },
        },
    },
} satisfies Prisma.ConnectedServiceAuthGroupInclude;

async function readQualifiedGroupRowInTx(
    tx: QualifiedGroupListStorage,
    params: Readonly<{
        accountId: string;
        service: QualifiedConnectedAccountServiceRef;
        groupId: string;
    }>,
) {
    const service =
        QualifiedConnectedAccountServiceRefSchema.parse(params.service);
    const groupRef = QualifiedConnectedAccountGroupRefSchema.parse({
        service,
        groupId: params.groupId,
    });
    const qualifiedGroupDigest =
        createQualifiedConnectedAccountGroupDigest(groupRef);
    const row = await tx.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_qualifiedGroupDigest: {
                accountId: params.accountId,
                qualifiedGroupDigest,
            },
        },
        include: qualifiedGroupInclude,
    });
    if (!row) return null;
    const storedRef =
        parseStoredQualifiedConnectedAccountGroupRef(row);
    if (
        storedRef.service.pluginId !== service.pluginId
        || storedRef.service.localId !== service.localId
        || storedRef.groupId !== params.groupId
    ) {
        throw new Error(
            "Qualified Connected Account group identity digest collision",
        );
    }
    return row;
}

type QualifiedGroupStoredRow = NonNullable<
    Awaited<ReturnType<typeof readQualifiedGroupRowInTx>>
>;

export async function readQualifiedConnectedAccountGroup(
    params: Readonly<{
        accountId: string;
        service: QualifiedConnectedAccountServiceRef;
        groupId: string;
    }>,
): Promise<QualifiedConnectedAccountGroupV4 | null> {
    const row = await readQualifiedGroupRowInTx(db, params);
    return row ? toQualifiedConnectedAccountGroup(row) : null;
}

export async function readQualifiedConnectedAccountGroupForLegacyProjection(
    params: Readonly<{
        accountId: string;
        service: QualifiedConnectedAccountServiceRef;
        groupId: string;
    }>,
): Promise<Readonly<{
    group: QualifiedConnectedAccountGroupV4;
    activeProfileId: string | null;
}> | null> {
    const row = await readQualifiedGroupRowInTx(db, params);
    return row
        ? {
            group: toQualifiedConnectedAccountGroup(row),
            activeProfileId: row.activeProfileId,
        }
        : null;
}

export type QualifiedConnectedAccountGroupMutationResult =
    | Readonly<{
        status: "written";
        group: QualifiedConnectedAccountGroupV4;
    }>
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "deleted" }>
    | Readonly<{ status: "already_exists" }>
    | Readonly<{
        status: "superseded";
        runtimeStateRevision: number | null;
    }>
    | Readonly<{
        status: "generation_superseded";
        generation: number;
    }>
    | Readonly<{ status: "incarnation_superseded" }>
    | Readonly<{ status: "source_superseded" }>
    | Readonly<{ status: "member_not_found" }>
    | Readonly<{ status: "member_disabled" }>
    | Readonly<{
        status: "runtime_cooldown";
        resetAtMs?: number;
    }>;

class QualifiedGroupMemberCasConflictError extends Error {
    constructor() {
        super("Qualified Connected Account group member CAS lost");
        this.name = "QualifiedGroupMemberCasConflictError";
    }
}

type QualifiedGroupMutationAdmissionStorage = QualifiedGroupListStorage;

type QualifiedGroupMutationAdmissionResult =
    | Readonly<{ status: "current"; current: QualifiedGroupStoredRow }>
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "incarnation_superseded" }>;

/** Owns exact-incarnation mutation admission for the canonical V4 group. */
async function readQualifiedGroupMutationAdmissionInTx(
    tx: QualifiedGroupMutationAdmissionStorage,
    params: Readonly<{
        accountId: string;
        service: QualifiedConnectedAccountServiceRef;
        groupId: string;
        expectedIncarnation?: string | null;
    }>,
): Promise<QualifiedGroupMutationAdmissionResult> {
    const current = await readQualifiedGroupRowInTx(tx, params);
    if (!current) return { status: "not_found" };
    if (
        params.expectedIncarnation !== undefined
        && params.expectedIncarnation !== current.id
    ) {
        return { status: "incarnation_superseded" };
    }
    return { status: "current", current };
}

async function settleQualifiedGroupMemberCasConflict(
    params: Readonly<{
        accountId: string;
        service: QualifiedConnectedAccountServiceRef;
        groupId: string;
        expectedGeneration: number;
        expectedIncarnation?: string | null;
    }>,
): Promise<QualifiedConnectedAccountGroupMutationResult> {
    const admission = await readQualifiedGroupMutationAdmissionInTx(db, params);
    if (admission.status !== "current") return admission;
    const latest = admission.current;
    if (latest.generation === params.expectedGeneration) {
        return {
            status: "superseded",
            runtimeStateRevision: latest.runtimeStateRevision,
        };
    }
    return {
        status: "generation_superseded",
        generation: latest.generation,
    };
}

function encodeStoredState(
    schema: Readonly<{ parse(value: unknown): unknown }>,
    value: unknown,
): string {
    return JSON.stringify(schema.parse(value));
}

async function finishQualifiedGroupMutation(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        service: QualifiedConnectedAccountServiceRef;
        groupId: string;
        recordProfileChange?: boolean;
    }>,
): Promise<QualifiedConnectedAccountGroupMutationResult> {
    const row = await readQualifiedGroupRowInTx(tx, params);
    if (!row) return { status: "not_found" };
    if (params.recordProfileChange !== false) {
        await recordConnectedServiceAccountProfileChange({
            tx,
            accountId: params.accountId,
        });
    }
    return {
        status: "written",
        group: toQualifiedConnectedAccountGroup(row),
    };
}

export async function createQualifiedConnectedAccountGroup(
    params: Readonly<{
        accountId: string;
        service: QualifiedConnectedAccountServiceRef;
        group: {
            groupId: string;
            displayName?: string | null;
            state?: unknown;
            policy?: unknown;
        };
        initialMembers?: ReadonlyArray<Readonly<{
            connectedAccountId: string;
            priority?: number;
            enabled?: boolean;
            state?: unknown;
        }>>;
        activeConnectedAccountId?: string | null;
    }>,
): Promise<QualifiedConnectedAccountGroupMutationResult> {
    const parsed = QualifiedConnectedAccountGroupCreateV4Schema.parse({
        service: params.service,
        group: params.group,
    });
    return await inTx(async (tx) => {
        const serviceDigest =
            createQualifiedConnectedAccountServiceDigest(parsed.service);
        const groupDigest =
            createQualifiedConnectedAccountGroupDigest({
                service: parsed.service,
                groupId: parsed.group.groupId,
            });
        const existing = await readQualifiedGroupRowInTx(tx, {
            accountId: params.accountId,
            service: parsed.service,
            groupId: parsed.group.groupId,
        });
        if (existing) return { status: "already_exists" };
        const legacyServiceId =
            resolveLegacyServiceIdForQualifiedConnectedAccountService(
                parsed.service,
            );
        const initialMembers = params.initialMembers ?? [];
        const memberIds = initialMembers.map(
            (member) => member.connectedAccountId,
        );
        if (new Set(memberIds).size !== memberIds.length) {
            return { status: "already_exists" };
        }
        const credentials = new Map<string, Awaited<ReturnType<
            typeof tx.serviceAccountToken.findUnique
        >>>();
        for (const member of initialMembers) {
            const qualifiedIdentityDigest =
                createQualifiedConnectedAccountIdentityDigest({
                    service: parsed.service,
                    accountId: member.connectedAccountId,
                });
            const credential = await tx.serviceAccountToken.findUnique({
                where: {
                    accountId_qualifiedIdentityDigest: {
                        accountId: params.accountId,
                        qualifiedIdentityDigest,
                    },
                },
            });
            if (
                !credential
                || credential.servicePluginId !== parsed.service.pluginId
                || credential.serviceLocalId !== parsed.service.localId
                || credential.qualifiedServiceDigest !== serviceDigest
                || credential.connectedAccountId
                    !== member.connectedAccountId
                || credential.qualifiedIdentityDigest
                    !== qualifiedIdentityDigest
            ) {
                return { status: "member_not_found" };
            }
            if (
                resolveQualifiedConnectedAccountStoredMetadata({
                    rowId: credential.id,
                    metadata: credential.metadata,
                }).revisionSemantics === "legacy_unfenced"
            ) {
                return { status: "source_superseded" };
            }
            credentials.set(member.connectedAccountId, credential);
        }
        if (params.activeConnectedAccountId !== undefined
            && params.activeConnectedAccountId !== null) {
            const activeMember = initialMembers.find((member) =>
                member.connectedAccountId
                    === params.activeConnectedAccountId);
            if (!activeMember || activeMember.enabled === false) {
                return { status: "member_disabled" };
            }
        }
        const created = await tx.connectedServiceAuthGroup.create({
            data: {
                accountId: params.accountId,
                vendor: legacyServiceId,
                servicePluginId: parsed.service.pluginId,
                serviceLocalId: parsed.service.localId,
                qualifiedServiceDigest: serviceDigest,
                qualifiedGroupDigest: groupDigest,
                groupId: parsed.group.groupId,
                displayName: parsed.group.displayName ?? null,
                policyJson: encodeStoredState(
                    ConnectedServiceAuthGroupPolicyV1Schema,
                    parsed.group.policy ?? {},
                ),
                stateJson: encodeStoredState(
                    ConnectedServiceAuthGroupStateV1Schema,
                    parsed.group.state ?? {},
                ),
                activeConnectedAccountId:
                    params.activeConnectedAccountId ?? null,
                activeProfileId: legacyServiceId === null
                    ? null
                    : params.activeConnectedAccountId ?? null,
            },
            select: { id: true },
        }).catch((error: unknown) => {
            if (isPrismaErrorCode(error, "P2002")) return null;
            throw error;
        });
        if (created === null) return { status: "already_exists" };
        if (initialMembers.length > 0) {
            await tx.connectedServiceAuthGroupMember.createMany({
                data: initialMembers.map((member) => {
                    const credential =
                        credentials.get(member.connectedAccountId);
                    if (!credential) {
                        throw new Error(
                            "Qualified Connected Account group credential disappeared",
                        );
                    }
                    return {
                        groupDbId: created.id,
                        accountId: params.accountId,
                        credentialId: credential.id,
                        qualifiedServiceDigest: serviceDigest,
                        qualifiedGroupDigest: groupDigest,
                        qualifiedIdentityDigest:
                            credential.qualifiedIdentityDigest,
                        vendor: legacyServiceId,
                        groupId: legacyServiceId === null
                            ? null
                            : parsed.group.groupId,
                        profileId: legacyServiceId === null
                            ? null
                            : credential.profileId,
                        priority: member.priority ?? 100,
                        enabled: member.enabled ?? true,
                        stateJson: encodeStoredState(
                            ConnectedServiceAuthGroupMemberStateV1Schema,
                            member.state ?? {},
                        ),
                    };
                }),
            });
        }
        return await finishQualifiedGroupMutation(tx, {
            accountId: params.accountId,
            service: parsed.service,
            groupId: parsed.group.groupId,
        });
    });
}

export async function patchQualifiedConnectedAccountGroup(
    params: Readonly<{
        accountId: string;
        patch: unknown;
        expectedIncarnation?: string | null;
        activeConnectedAccountId?: string | null;
    }>,
): Promise<QualifiedConnectedAccountGroupMutationResult> {
    const patch = QualifiedConnectedAccountGroupPatchV4Schema.parse(
        params.patch,
    );
    return await inTx(async (tx) => {
        const admission = await readQualifiedGroupMutationAdmissionInTx(tx, {
            accountId: params.accountId,
            service: patch.service,
            groupId: patch.groupId,
            expectedIncarnation: params.expectedIncarnation,
        });
        if (admission.status !== "current") return admission;
        const current = admission.current;
        if (
            patch.expectedGeneration !== current.generation
        ) {
            return {
                status: "generation_superseded",
                generation: current.generation,
            };
        }
        if (
            patch.expectedRuntimeStateRevision !== undefined
            && patch.expectedRuntimeStateRevision
                !== current.runtimeStateRevision
        ) {
            return {
                status: "superseded",
                runtimeStateRevision: current.runtimeStateRevision,
            };
        }
        const nextPolicyJson = patch.policy === undefined
            ? null
            : encodeStoredState(
                ConnectedServiceAuthGroupPolicyV1Schema,
                patch.policy,
            );
        const nextStateJson = patch.state === undefined
            ? null
            : encodeStoredState(
                ConnectedServiceAuthGroupStateV1Schema,
                patch.state,
            );
        const runtimeStateChanged = nextStateJson !== null
            && nextStateJson !== current.stateJson;
        const activeAccountChanged =
            params.activeConnectedAccountId !== undefined
            && params.activeConnectedAccountId
                !== current.activeConnectedAccountId;
        if (
            params.activeConnectedAccountId !== undefined
            && params.activeConnectedAccountId !== null
        ) {
            const activeMember = current.members.find((member) =>
                member.credential.connectedAccountId
                    === params.activeConnectedAccountId);
            if (!activeMember) return { status: "member_not_found" };
            if (!activeMember.enabled) return { status: "member_disabled" };
            if (
                typeof activeMember.credential.id !== "string"
                || resolveQualifiedConnectedAccountStoredMetadata({
                    rowId: activeMember.credential.id,
                    metadata: activeMember.credential.metadata,
                }).revisionSemantics === "legacy_unfenced"
            ) {
                return { status: "source_superseded" };
            }
            const runtimeBlocker =
                readConnectedServiceManualActiveProfileRuntimeBlocker(
                    parseStoredJson(
                        ConnectedServiceAuthGroupMemberStateV1Schema,
                        activeMember.stateJson,
                    ),
                    Date.now(),
                );
            if (
                runtimeBlocker !== null
                && patch.overrideRuntimeCooldown !== true
            ) {
                return {
                    status: "runtime_cooldown",
                    ...runtimeBlocker,
                };
            }
        }
        const structuralChanged =
            patch.displayName !== undefined || patch.policy !== undefined;
        const updated = await tx.connectedServiceAuthGroup.updateMany({
            where: {
                id: current.id,
                generation: current.generation,
                runtimeStateRevision: current.runtimeStateRevision,
            },
            data: {
                ...(patch.displayName !== undefined
                    ? { displayName: patch.displayName }
                    : {}),
                ...(nextPolicyJson !== null
                    ? {
                        policyJson: nextPolicyJson,
                    }
                    : {}),
                ...(nextStateJson !== null
                    ? {
                        stateJson: nextStateJson,
                    }
                    : {}),
                ...(activeAccountChanged
                    ? {
                        activeConnectedAccountId:
                            params.activeConnectedAccountId,
                        activeProfileId: current.vendor === null
                            ? null
                            : params.activeConnectedAccountId,
                    }
                    : {}),
                ...(structuralChanged
                    ? { generation: { increment: 1 } }
                    : {}),
                ...(runtimeStateChanged
                    ? { runtimeStateRevision: { increment: 1 } }
                    : {}),
            },
        });
        if (updated.count !== 1) {
            const latestAdmission =
                await readQualifiedGroupMutationAdmissionInTx(tx, {
                    accountId: params.accountId,
                    service: patch.service,
                    groupId: patch.groupId,
                    expectedIncarnation: params.expectedIncarnation,
                });
            if (latestAdmission.status === "incarnation_superseded") {
                return { status: "incarnation_superseded" };
            }
            const latest = latestAdmission.status === "current"
                ? latestAdmission.current
                : null;
            if (
                latest
                && latest.generation !== current.generation
            ) {
                return {
                    status: "generation_superseded",
                    generation: latest.generation,
                };
            }
            return {
                status: "superseded",
                runtimeStateRevision:
                    latest?.runtimeStateRevision ?? null,
            };
        }
        return await finishQualifiedGroupMutation(tx, {
            accountId: params.accountId,
            service: patch.service,
            groupId: patch.groupId,
        });
    });
}

export async function deleteQualifiedConnectedAccountGroup(
    params: Readonly<{
        accountId: string;
        service: QualifiedConnectedAccountServiceRef;
        groupId: string;
        expectedGeneration: number;
        expectedRuntimeStateRevision?: number;
        expectedIncarnation?: string | null;
    }>,
): Promise<QualifiedConnectedAccountGroupMutationResult> {
    const service =
        QualifiedConnectedAccountServiceRefSchema.parse(params.service);
    return await inTx(async (tx) => {
        const admission = await readQualifiedGroupMutationAdmissionInTx(tx, {
            accountId: params.accountId,
            service,
            groupId: params.groupId,
            expectedIncarnation: params.expectedIncarnation,
        });
        if (admission.status !== "current") return admission;
        const current = admission.current;
        if (params.expectedGeneration !== current.generation) {
            return {
                status: "generation_superseded",
                generation: current.generation,
            };
        }
        if (
            params.expectedRuntimeStateRevision !== undefined
            && params.expectedRuntimeStateRevision
                !== current.runtimeStateRevision
        ) {
            return {
                status: "superseded",
                runtimeStateRevision: current.runtimeStateRevision,
            };
        }
        const deleted = await tx.connectedServiceAuthGroup.deleteMany({
            where: {
                id: current.id,
                generation: current.generation,
                runtimeStateRevision: current.runtimeStateRevision,
            },
        });
        if (deleted.count !== 1) {
            const latestAdmission =
                await readQualifiedGroupMutationAdmissionInTx(tx, {
                    accountId: params.accountId,
                    service,
                    groupId: params.groupId,
                    expectedIncarnation: params.expectedIncarnation,
                });
            if (latestAdmission.status === "incarnation_superseded") {
                return { status: "incarnation_superseded" };
            }
            const latest = latestAdmission.status === "current"
                ? latestAdmission.current
                : null;
            if (
                latest
                && latest.generation !== current.generation
            ) {
                return {
                    status: "generation_superseded",
                    generation: latest.generation,
                };
            }
            return {
                status: "superseded",
                runtimeStateRevision:
                    latest?.runtimeStateRevision
                    ?? current.runtimeStateRevision,
            };
        }
        await tx.connectedServiceUsageSource.deleteMany({
            where: {
                accountId: params.accountId,
                qualifiedServiceDigest: current.qualifiedServiceDigest,
                bindingKind: "group_member",
                groupId: params.groupId,
            },
        });
        await recordConnectedServiceAccountProfileChange({
            tx,
            accountId: params.accountId,
        });
        return { status: "deleted" };
    });
}

export async function patchQualifiedConnectedAccountGroupRuntimeState(
    params: Readonly<{
        accountId: string;
        patch: unknown;
        expectedIncarnation?: string | null;
    }>,
): Promise<QualifiedConnectedAccountGroupMutationResult> {
    const patch =
        QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema.parse(
            params.patch,
        );
    return await inTx(async (tx) => {
        const admission = await readQualifiedGroupMutationAdmissionInTx(tx, {
            accountId: params.accountId,
            service: patch.service,
            groupId: patch.groupId,
            expectedIncarnation: params.expectedIncarnation,
        });
        if (admission.status !== "current") return admission;
        const current = admission.current;
        if (
            patch.expectedGeneration !== current.generation
        ) {
            return {
                status: "generation_superseded",
                generation: current.generation,
            };
        }
        if (
            current.runtimeStateRevision
                !== patch.expectedRuntimeStateRevision
        ) {
            return {
                status: "superseded",
                runtimeStateRevision: current.runtimeStateRevision,
            };
        }
        const membersByConnectedAccountId = new Map(
            current.members.map((member) => [
                member.credential.connectedAccountId,
                member,
            ]),
        );
        if (patch.runtimeState.memberStates.some((member) =>
            !membersByConnectedAccountId.has(member.connectedAccountId))) {
            return { status: "member_not_found" };
        }
        const write = await tx.connectedServiceAuthGroup.updateMany({
            where: {
                id: current.id,
                generation: current.generation,
                runtimeStateRevision:
                    patch.expectedRuntimeStateRevision,
            },
            data: {
                ...(patch.runtimeState.state !== undefined
                    ? {
                        stateJson: encodeStoredState(
                            ConnectedServiceAuthGroupStateV1Schema,
                            patch.runtimeState.state,
                        ),
                    }
                    : {}),
                runtimeStateRevision: { increment: 1 },
            },
        });
        if (write.count !== 1) {
            const latestAdmission =
                await readQualifiedGroupMutationAdmissionInTx(tx, {
                    accountId: params.accountId,
                    service: patch.service,
                    groupId: patch.groupId,
                    expectedIncarnation: params.expectedIncarnation,
                });
            if (latestAdmission.status === "incarnation_superseded") {
                return { status: "incarnation_superseded" };
            }
            const latest = latestAdmission.status === "current"
                ? latestAdmission.current
                : null;
            if (
                latest
                && latest.generation !== current.generation
            ) {
                return {
                    status: "generation_superseded",
                    generation: latest.generation,
                };
            }
            return {
                status: "superseded",
                runtimeStateRevision:
                    latest?.runtimeStateRevision
                    ?? current.runtimeStateRevision,
            };
        }
        for (const member of patch.runtimeState.memberStates) {
            const stored =
                membersByConnectedAccountId.get(member.connectedAccountId);
            if (!stored) return { status: "member_not_found" };
            await tx.connectedServiceAuthGroupMember.update({
                where: { id: stored.id },
                data: {
                    stateJson: encodeStoredState(
                        ConnectedServiceAuthGroupMemberStateV1Schema,
                        member.state,
                    ),
                },
            });
        }
        return await finishQualifiedGroupMutation(tx, {
            accountId: params.accountId,
            service: patch.service,
            groupId: patch.groupId,
        });
    });
}

async function mutateQualifiedGroupMember(
    params: Readonly<{
        accountId: string;
        mutation: unknown;
        operation: "create" | "update";
        expectedIncarnation?: string | null;
        activateWhenGroupHasNoLegacyActiveAccount?: boolean;
    }>,
): Promise<QualifiedConnectedAccountGroupMutationResult> {
    const mutation =
        QualifiedConnectedAccountGroupMemberMutationV4Schema.parse(
            params.mutation,
        );
    try {
        return await inTx(async (tx) => {
            const admission = await readQualifiedGroupMutationAdmissionInTx(tx, {
                accountId: params.accountId,
                service: mutation.group.service,
                groupId: mutation.group.groupId,
                expectedIncarnation: params.expectedIncarnation,
            });
            if (admission.status !== "current") return admission;
            const current = admission.current;
            if (
                mutation.expectedGeneration !== current.generation
            ) {
                return {
                    status: "generation_superseded",
                    generation: current.generation,
                };
            }
            if (
                mutation.expectedRuntimeStateRevision !== undefined
                && mutation.expectedRuntimeStateRevision
                    !== current.runtimeStateRevision
            ) {
                return {
                    status: "superseded",
                    runtimeStateRevision: current.runtimeStateRevision,
                };
            }
            const existing = current.members.find((member) =>
                member.credential.connectedAccountId
                    === mutation.connectedAccountId);
            if (params.operation === "create" && existing) {
                return { status: "already_exists" };
            }
            if (params.operation === "update" && !existing) {
                return { status: "member_not_found" };
            }
            if (mutation.state !== undefined
                && mutation.expectedRuntimeStateRevision === undefined) {
                return {
                    status: "superseded",
                    runtimeStateRevision: current.runtimeStateRevision,
                };
            }
            let createdMemberLegacyProfileId: string | null = null;
            if (params.operation === "create") {
                const qualifiedIdentityDigest =
                    createQualifiedConnectedAccountIdentityDigest({
                        service: mutation.group.service,
                        accountId: mutation.connectedAccountId,
                    });
                const credential = await tx.serviceAccountToken.findUnique({
                    where: {
                        accountId_qualifiedIdentityDigest: {
                            accountId: params.accountId,
                            qualifiedIdentityDigest,
                        },
                    },
                });
                if (
                    !credential
                    || credential.qualifiedServiceDigest
                        !== current.qualifiedServiceDigest
                ) {
                    return { status: "member_not_found" };
                }
                if (
                    resolveQualifiedConnectedAccountStoredMetadata({
                        rowId: credential.id,
                        metadata: credential.metadata,
                    }).revisionSemantics === "legacy_unfenced"
                ) {
                    return { status: "source_superseded" };
                }
                createdMemberLegacyProfileId = credential.profileId;
                await tx.connectedServiceAuthGroupMember.create({
                    data: {
                        groupDbId: current.id,
                        accountId: params.accountId,
                        credentialId: credential.id,
                        qualifiedServiceDigest:
                            current.qualifiedServiceDigest,
                        qualifiedGroupDigest: current.qualifiedGroupDigest,
                        qualifiedIdentityDigest:
                            credential.qualifiedIdentityDigest,
                        vendor: current.vendor,
                        groupId: current.vendor === null
                            ? null
                            : current.groupId,
                        profileId: current.vendor === null
                            ? null
                            : credential.profileId,
                        priority: mutation.priority ?? 100,
                        enabled: mutation.enabled ?? true,
                        stateJson: encodeStoredState(
                            ConnectedServiceAuthGroupMemberStateV1Schema,
                            mutation.state ?? {},
                        ),
                    },
                });
            }
            const shouldReplaceActiveAccount =
                params.operation === "update"
                && existing !== undefined
                && mutation.enabled === false
                && current.activeConnectedAccountId
                    === mutation.connectedAccountId;
            const shouldSetInitialActiveAccount =
                params.operation === "create"
                && params.activateWhenGroupHasNoLegacyActiveAccount === true
                && current.activeProfileId === null
                && mutation.enabled !== false;
            const fallbackActiveMember = shouldReplaceActiveAccount
                ? current.members.find((candidate) =>
                    candidate.id !== existing?.id
                    && candidate.enabled)
                : undefined;
            if (params.operation === "update" && existing) {
                await tx.connectedServiceAuthGroupMember.update({
                    where: { id: existing.id },
                    data: {
                        ...(mutation.priority !== undefined
                            ? { priority: mutation.priority }
                            : {}),
                        ...(mutation.enabled !== undefined
                            ? { enabled: mutation.enabled }
                            : {}),
                        ...(mutation.state !== undefined
                            ? {
                                stateJson: encodeStoredState(
                                    ConnectedServiceAuthGroupMemberStateV1Schema,
                                    mutation.state,
                                ),
                            }
                            : {}),
                    },
                });
            }
            const updated = await tx.connectedServiceAuthGroup.updateMany({
                where: {
                    id: current.id,
                    generation: current.generation,
                    runtimeStateRevision: current.runtimeStateRevision,
                },
                data: {
                    generation: { increment: 1 },
                    ...(shouldReplaceActiveAccount
                        ? {
                            activeConnectedAccountId:
                                fallbackActiveMember?.credential
                                    .connectedAccountId ?? null,
                            activeProfileId:
                                current.vendor === null
                                    ? null
                                    : fallbackActiveMember?.credential
                                        .profileId ?? null,
                        }
                        : {}),
                    ...(shouldSetInitialActiveAccount
                        ? {
                            activeConnectedAccountId:
                                mutation.connectedAccountId,
                            activeProfileId:
                                current.vendor === null
                                    ? null
                                    : createdMemberLegacyProfileId,
                        }
                        : {}),
                    ...(mutation.state !== undefined
                        ? { runtimeStateRevision: { increment: 1 } }
                        : {}),
                },
            });
            if (updated.count !== 1) {
                throw new QualifiedGroupMemberCasConflictError();
            }
            return await finishQualifiedGroupMutation(tx, {
                accountId: params.accountId,
                service: mutation.group.service,
                groupId: mutation.group.groupId,
            });
        });
    } catch (error) {
        if (error instanceof QualifiedGroupMemberCasConflictError) {
            return await settleQualifiedGroupMemberCasConflict({
                accountId: params.accountId,
                service: mutation.group.service,
                groupId: mutation.group.groupId,
                expectedGeneration: mutation.expectedGeneration,
                expectedIncarnation: params.expectedIncarnation,
            });
        }
        if (isPrismaErrorCode(error, "P2002")) {
            return { status: "already_exists" };
        }
        if (isPrismaErrorCode(error, "P2003")) {
            const latestAdmission =
                await readQualifiedGroupMutationAdmissionInTx(db, {
                    accountId: params.accountId,
                    service: mutation.group.service,
                    groupId: mutation.group.groupId,
                    expectedIncarnation: params.expectedIncarnation,
                });
            if (latestAdmission.status === "incarnation_superseded") {
                return { status: "incarnation_superseded" };
            }
            const latest = latestAdmission.status === "current"
                ? latestAdmission.current
                : null;
            return latest
                ? { status: "member_not_found" }
                : { status: "not_found" };
        }
        throw error;
    }
}

export async function createQualifiedConnectedAccountGroupMember(
    params: Readonly<{
        accountId: string;
        mutation: unknown;
        expectedIncarnation?: string | null;
        activateWhenGroupHasNoLegacyActiveAccount?: boolean;
    }>,
): Promise<QualifiedConnectedAccountGroupMutationResult> {
    return await mutateQualifiedGroupMember({
        ...params,
        operation: "create",
    });
}

export async function updateQualifiedConnectedAccountGroupMember(
    params: Readonly<{
        accountId: string;
        mutation: unknown;
        expectedIncarnation?: string | null;
    }>,
): Promise<QualifiedConnectedAccountGroupMutationResult> {
    return await mutateQualifiedGroupMember({
        ...params,
        operation: "update",
    });
}

export async function deleteQualifiedConnectedAccountGroupMember(
    params: Readonly<{
        accountId: string;
        mutation: unknown;
        expectedIncarnation?: string | null;
    }>,
): Promise<QualifiedConnectedAccountGroupMutationResult> {
    const mutation =
        QualifiedConnectedAccountGroupMemberDeleteV4Schema.parse(
            params.mutation,
        );
    try {
        return await inTx(async (tx) => {
            const admission = await readQualifiedGroupMutationAdmissionInTx(tx, {
                accountId: params.accountId,
                service: mutation.group.service,
                groupId: mutation.group.groupId,
                expectedIncarnation: params.expectedIncarnation,
            });
            if (admission.status !== "current") return admission;
            const current = admission.current;
            if (
                mutation.expectedGeneration !== current.generation
            ) {
                return {
                    status: "generation_superseded",
                    generation: current.generation,
                };
            }
            if (
                mutation.expectedRuntimeStateRevision !== undefined
                && mutation.expectedRuntimeStateRevision
                    !== current.runtimeStateRevision
            ) {
                return {
                    status: "superseded",
                    runtimeStateRevision: current.runtimeStateRevision,
                };
            }
            const member = current.members.find((candidate) =>
                candidate.credential.connectedAccountId
                    === mutation.connectedAccountId);
            if (!member) return { status: "member_not_found" };
            const fallback = current.members.find((candidate) =>
                candidate.id !== member.id && candidate.enabled);
            await tx.connectedServiceAuthGroupMember.delete({
                where: { id: member.id },
            });
            await tx.connectedServiceUsageSource.deleteMany({
                where: {
                    accountId: params.accountId,
                    credentialId: member.credentialId,
                    bindingKind: "group_member",
                    groupId: current.groupId,
                },
            });
            const wasActive =
                current.activeConnectedAccountId
                    === mutation.connectedAccountId;
            const updated =
                await tx.connectedServiceAuthGroup.updateMany({
                    where: {
                        id: current.id,
                        generation: current.generation,
                        runtimeStateRevision:
                            current.runtimeStateRevision,
                    },
                    data: {
                        generation: { increment: 1 },
                        ...(wasActive
                            ? {
                                activeConnectedAccountId:
                                    fallback?.credential
                                        .connectedAccountId ?? null,
                                activeProfileId:
                                    current.vendor === null
                                        ? null
                                        : fallback?.credential.profileId
                                            ?? null,
                            }
                            : {}),
                    },
                });
            if (updated.count !== 1) {
                throw new QualifiedGroupMemberCasConflictError();
            }
            return await finishQualifiedGroupMutation(tx, {
                accountId: params.accountId,
                service: mutation.group.service,
                groupId: mutation.group.groupId,
            });
        });
    } catch (error) {
        if (!(error instanceof QualifiedGroupMemberCasConflictError)) {
            throw error;
        }
        return await settleQualifiedGroupMemberCasConflict({
            accountId: params.accountId,
            service: mutation.group.service,
            groupId: mutation.group.groupId,
            expectedGeneration: mutation.expectedGeneration,
            expectedIncarnation: params.expectedIncarnation,
        });
    }
}

export async function setQualifiedConnectedAccountGroupActiveAccount(
    params: Readonly<{
        accountId: string;
        mutation: unknown;
        expectedIncarnation?: string | null;
    }>,
): Promise<QualifiedConnectedAccountGroupMutationResult> {
    const mutation =
        QualifiedConnectedAccountGroupActiveAccountV4Schema.parse(
            params.mutation,
        );
    return await inTx(async (tx) => {
        const admission = await readQualifiedGroupMutationAdmissionInTx(tx, {
            accountId: params.accountId,
            service: mutation.group.service,
            groupId: mutation.group.groupId,
            expectedIncarnation: params.expectedIncarnation,
        });
        if (admission.status !== "current") return admission;
        const current = admission.current;
        if (
            mutation.expectedGeneration !== current.generation
        ) {
            return {
                status: "generation_superseded",
                generation: current.generation,
            };
        }
        if (
            mutation.expectedRuntimeStateRevision !== undefined
            && mutation.expectedRuntimeStateRevision
                !== current.runtimeStateRevision
        ) {
            return {
                status: "superseded",
                runtimeStateRevision: current.runtimeStateRevision,
            };
        }
        if (mutation.expectedSource !== undefined) {
            const sourceMember = current.members.find((candidate) =>
                candidate.credential.connectedAccountId
                    === current.activeConnectedAccountId);
            const sourceCredential = sourceMember?.credential;
            if (
                current.activeConnectedAccountId
                    !== mutation.expectedSource.connectedAccountId
                || !sourceCredential
                || typeof sourceCredential.id !== "string"
                || resolveQualifiedConnectedAccountStoredMetadata({
                    rowId: sourceCredential.id,
                    metadata: sourceCredential.metadata,
                }).credentialRevision
                    !== mutation.expectedSource.credentialRevision
                || (sourceCredential.configurationRevision ?? null)
                    !== mutation.expectedSource.configurationRevision
            ) {
                return { status: "source_superseded" };
            }
        }
        const member = current.members.find((candidate) =>
            candidate.credential.connectedAccountId
                === mutation.connectedAccountId);
        if (!member) return { status: "member_not_found" };
        if (!member.enabled) return { status: "member_disabled" };
        if (
            typeof member.credential.id !== "string"
            || resolveQualifiedConnectedAccountStoredMetadata({
                rowId: member.credential.id,
                metadata: member.credential.metadata,
            }).revisionSemantics === "legacy_unfenced"
        ) {
            return { status: "source_superseded" };
        }
        const runtimeBlocker =
            readConnectedServiceManualActiveProfileRuntimeBlocker(
                parseStoredJson(
                    ConnectedServiceAuthGroupMemberStateV1Schema,
                    member.stateJson,
                ),
                Date.now(),
            );
        if (
            runtimeBlocker !== null
            && mutation.overrideRuntimeCooldown !== true
        ) {
            return {
                status: "runtime_cooldown",
                ...runtimeBlocker,
            };
        }
        const updated = await tx.connectedServiceAuthGroup.updateMany({
            where: {
                id: current.id,
                generation: current.generation,
                runtimeStateRevision: current.runtimeStateRevision,
            },
            data: {
                activeConnectedAccountId: mutation.connectedAccountId,
                activeProfileId:
                    current.vendor === null
                        ? null
                        : member.credential.profileId,
                generation: { increment: 1 },
            },
        });
        if (updated.count !== 1) {
            const latestAdmission =
                await readQualifiedGroupMutationAdmissionInTx(tx, {
                    accountId: params.accountId,
                    service: mutation.group.service,
                    groupId: mutation.group.groupId,
                    expectedIncarnation: params.expectedIncarnation,
                });
            if (latestAdmission.status !== "current") return latestAdmission;
            const latest = latestAdmission.current;
            if (latest.generation !== current.generation) {
                return {
                    status: "generation_superseded",
                    generation: latest.generation,
                };
            }
            return {
                status: "superseded",
                runtimeStateRevision: latest.runtimeStateRevision,
            };
        }
        return await finishQualifiedGroupMutation(tx, {
            accountId: params.accountId,
            service: mutation.group.service,
            groupId: mutation.group.groupId,
        });
    });
}
