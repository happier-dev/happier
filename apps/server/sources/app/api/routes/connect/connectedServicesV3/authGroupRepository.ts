import { z } from "zod";

import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import {
    parseConnectedServiceAuthGroupPolicyJson,
    stringifyConnectedServiceAuthGroupPolicy,
    type ConnectedServiceAuthGroupPolicyV1,
} from "./authGroupPolicy";
import {
    AuthGroupResponseSchema,
    ConnectedServiceAuthGroupMemberStateSchema,
    ConnectedServiceAuthGroupStateSchema,
} from "./authGroupSchemas";

type AuthGroupState = z.infer<typeof ConnectedServiceAuthGroupStateSchema>;
type AuthGroupMemberState = z.infer<typeof ConnectedServiceAuthGroupMemberStateSchema>;
type AuthGroupResponse = z.infer<typeof AuthGroupResponseSchema>;
export type DeleteConnectedServiceCredentialResult = "deleted" | "not_found" | "referenced";
export type AuthGroupGenerationConflictResult = Readonly<{ type: "generation_conflict"; generation: number }>;
export type CreateAuthGroupMemberResult = "created" | "group_not_found" | "profile_not_found" | AuthGroupGenerationConflictResult;
export type UpdateAuthGroupMemberResult = "updated" | "unchanged" | "not_found" | AuthGroupGenerationConflictResult;
export type DeleteAuthGroupMemberResult = "deleted" | "not_found" | AuthGroupGenerationConflictResult;

type AuthGroupMemberRow = Readonly<{
    profileId: string;
    priority: number;
    enabled: boolean;
    stateJson: string | null;
    createdAt: Date;
    updatedAt: Date;
}>;

type AuthGroupRow = Readonly<{
    id: string;
    vendor: string;
    groupId: string;
    displayName: string | null;
    policyJson: string;
    activeProfileId: string | null;
    generation: number;
    stateJson: string | null;
    createdAt: Date;
    updatedAt: Date;
    members: readonly AuthGroupMemberRow[];
}>;

const memberOrderBy = [
    { priority: "asc" as const },
    { profileId: "asc" as const },
];

export function stringifyAuthGroupState(state: AuthGroupState | null | undefined): string | null {
    if (state == null) return null;
    return JSON.stringify(ConnectedServiceAuthGroupStateSchema.parse(state));
}

export function stringifyAuthGroupMemberState(state: AuthGroupMemberState | null | undefined): string | null {
    if (state == null) return null;
    return JSON.stringify(ConnectedServiceAuthGroupMemberStateSchema.parse(state));
}

function parseAuthGroupStateJson(stateJson: string | null): AuthGroupState {
    if (!stateJson) return ConnectedServiceAuthGroupStateSchema.parse({});
    try {
        const parsed = ConnectedServiceAuthGroupStateSchema.safeParse(JSON.parse(stateJson));
        return parsed.success ? parsed.data : ConnectedServiceAuthGroupStateSchema.parse({});
    } catch {
        return ConnectedServiceAuthGroupStateSchema.parse({});
    }
}

function parseAuthGroupMemberStateJson(stateJson: string | null): AuthGroupMemberState {
    if (!stateJson) return ConnectedServiceAuthGroupMemberStateSchema.parse({});
    try {
        const parsed = ConnectedServiceAuthGroupMemberStateSchema.safeParse(JSON.parse(stateJson));
        return parsed.success ? parsed.data : ConnectedServiceAuthGroupMemberStateSchema.parse({});
    } catch {
        return ConnectedServiceAuthGroupMemberStateSchema.parse({});
    }
}

export function toAuthGroupResponse(row: AuthGroupRow): AuthGroupResponse {
    const response = {
        v: 1,
        serviceId: row.vendor,
        groupId: row.groupId,
        displayName: row.displayName,
        policy: parseConnectedServiceAuthGroupPolicyJson(row.policyJson),
        activeProfileId: row.activeProfileId,
        generation: row.generation,
        state: parseAuthGroupStateJson(row.stateJson),
        members: row.members.map((member) => ({
            v: 1,
            serviceId: row.vendor,
            groupId: row.groupId,
            profileId: member.profileId,
            priority: member.priority,
            enabled: member.enabled,
            state: parseAuthGroupMemberStateJson(member.stateJson),
            createdAt: member.createdAt.getTime(),
            updatedAt: member.updatedAt.getTime(),
        })),
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
    return AuthGroupResponseSchema.parse(response);
}

export async function listAuthGroupsForAccount(params: {
    accountId: string;
    serviceId: string;
}): Promise<AuthGroupResponse[]> {
    const rows = await db.connectedServiceAuthGroup.findMany({
        where: { accountId: params.accountId, vendor: params.serviceId },
        include: { members: { orderBy: memberOrderBy } },
        orderBy: [{ groupId: "asc" }],
    });
    return rows.map(toAuthGroupResponse);
}

export async function findAuthGroupForAccount(params: {
    accountId: string;
    serviceId: string;
    groupId: string;
}): Promise<AuthGroupResponse | null> {
    const row = await db.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        include: { members: { orderBy: memberOrderBy } },
    });
    return row ? toAuthGroupResponse(row) : null;
}

export async function hasConnectedServiceProfile(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
}): Promise<boolean> {
    const row = await db.serviceAccountToken.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: { id: true },
    });
    return row !== null;
}

export async function findAuthGroupMemberReference(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
}): Promise<{ groupId: string } | null> {
    return db.connectedServiceAuthGroupMember.findFirst({
        where: {
            accountId: params.accountId,
            vendor: params.serviceId,
            profileId: params.profileId,
        },
        select: { groupId: true },
    });
}

export async function isCredentialReferencedByAuthGroup(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
}): Promise<boolean> {
    return (await findAuthGroupMemberReference(params)) !== null;
}

export async function deleteConnectedServiceCredentialInTx(
    tx: Tx,
    params: {
        accountId: string;
        serviceId: string;
        profileId: string;
        allowReferencedGroupCleanup: boolean;
    },
): Promise<DeleteConnectedServiceCredentialResult> {
    const existing = await tx.serviceAccountToken.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: { id: true },
    });
    if (!existing) return "not_found";

    if (!params.allowReferencedGroupCleanup) {
        const reference = await tx.connectedServiceAuthGroupMember.findFirst({
            where: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
            select: { id: true },
        });
        if (reference) return "referenced";
    } else {
        const memberGroups = await tx.connectedServiceAuthGroupMember.findMany({
            where: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
            select: { groupDbId: true },
        });
        const activeGroups = await tx.connectedServiceAuthGroup.findMany({
            where: {
                accountId: params.accountId,
                vendor: params.serviceId,
                activeProfileId: params.profileId,
            },
            select: { id: true },
        });
        const activeGroupIds = activeGroups.map((group) => group.id);
        const affectedGroupIds = Array.from(new Set([
            ...memberGroups.map((member) => member.groupDbId),
            ...activeGroupIds,
        ]));
        if (affectedGroupIds.length > 0) {
            await tx.connectedServiceAuthGroup.updateMany({
                where: { id: { in: affectedGroupIds } },
                data: { generation: { increment: 1 } },
            });
            if (activeGroupIds.length > 0) {
                await tx.connectedServiceAuthGroup.updateMany({
                    where: { id: { in: activeGroupIds } },
                    data: { activeProfileId: null },
                });
            }
        }
    }

    await tx.serviceAccountToken.delete({ where: { id: existing.id } });
    return "deleted";
}

export async function deleteConnectedServiceCredential(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
    allowReferencedGroupCleanup: boolean;
}): Promise<DeleteConnectedServiceCredentialResult> {
    return inTx((tx) => deleteConnectedServiceCredentialInTx(tx, params));
}

export function encodePolicyForStorage(policy: ConnectedServiceAuthGroupPolicyV1): string {
    return stringifyConnectedServiceAuthGroupPolicy(policy);
}

export async function createAuthGroupMemberAndBumpGenerationInTx(tx: Tx, params: {
    accountId: string;
    serviceId: string;
    groupId: string;
    profileId: string;
    priority: number;
    enabled: boolean;
    expectedGeneration: number;
}): Promise<CreateAuthGroupMemberResult> {
    const group = await tx.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        select: { id: true, generation: true },
    });
    if (!group) return "group_not_found";
    if (group.generation !== params.expectedGeneration) {
        return { type: "generation_conflict", generation: group.generation };
    }

    const profile = await tx.serviceAccountToken.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: { id: true },
    });
    if (!profile) return "profile_not_found";

    const generationUpdate = await tx.connectedServiceAuthGroup.updateMany({
        where: { id: group.id, generation: params.expectedGeneration },
        data: { generation: { increment: 1 } },
    });
    if (generationUpdate.count !== 1) {
        const current = await tx.connectedServiceAuthGroup.findUnique({
            where: { id: group.id },
            select: { generation: true },
        });
        return { type: "generation_conflict", generation: current?.generation ?? group.generation };
    }

    await tx.connectedServiceAuthGroupMember.create({
        data: {
            groupDbId: group.id,
            accountId: params.accountId,
            vendor: params.serviceId,
            groupId: params.groupId,
            profileId: params.profileId,
            priority: params.priority,
            enabled: params.enabled,
            stateJson: null,
        },
    });
    return "created";
}

export async function updateAuthGroupMemberAndBumpGenerationInTx(tx: Tx, params: {
    accountId: string;
    serviceId: string;
    groupId: string;
    profileId: string;
    priority?: number;
    enabled?: boolean;
    expectedGeneration: number;
}): Promise<UpdateAuthGroupMemberResult> {
    const group = await tx.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        select: { id: true, activeProfileId: true, generation: true },
    });
    if (!group) return "not_found";
    if (group.generation !== params.expectedGeneration) {
        return { type: "generation_conflict", generation: group.generation };
    }

    const member = await tx.connectedServiceAuthGroupMember.findUnique({
        where: {
            accountId_vendor_groupId_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
                profileId: params.profileId,
            },
        },
        select: { id: true, priority: true, enabled: true },
    });
    if (!member) return "not_found";

    const changesCandidate = (params.priority !== undefined && params.priority !== member.priority)
        || (params.enabled !== undefined && params.enabled !== member.enabled);
    if (!changesCandidate) return "unchanged";

    const shouldClearActiveProfile = params.enabled === false && group.activeProfileId === params.profileId;
    const generationUpdate = await tx.connectedServiceAuthGroup.updateMany({
        where: { id: group.id, generation: params.expectedGeneration },
        data: {
            generation: { increment: 1 },
            ...(shouldClearActiveProfile ? { activeProfileId: null } : {}),
        },
    });
    if (generationUpdate.count !== 1) {
        const current = await tx.connectedServiceAuthGroup.findUnique({
            where: { id: group.id },
            select: { generation: true },
        });
        return { type: "generation_conflict", generation: current?.generation ?? group.generation };
    }

    await tx.connectedServiceAuthGroupMember.update({
        where: { id: member.id },
        data: {
            ...(params.priority !== undefined ? { priority: params.priority } : {}),
            ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        },
    });
    return "updated";
}

export async function deleteAuthGroupMemberAndBumpGenerationInTx(tx: Tx, params: {
    accountId: string;
    serviceId: string;
    groupId: string;
    profileId: string;
    expectedGeneration: number;
}): Promise<DeleteAuthGroupMemberResult> {
    const group = await tx.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        select: { id: true, activeProfileId: true, generation: true },
    });
    if (!group) return "not_found";
    if (group.generation !== params.expectedGeneration) {
        return { type: "generation_conflict", generation: group.generation };
    }

    const member = await tx.connectedServiceAuthGroupMember.findUnique({
        where: {
            accountId_vendor_groupId_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
                profileId: params.profileId,
            },
        },
        select: { id: true },
    });
    if (!member) return "not_found";

    const generationUpdate = await tx.connectedServiceAuthGroup.updateMany({
        where: { id: group.id, generation: params.expectedGeneration },
        data: {
            generation: { increment: 1 },
            ...(group.activeProfileId === params.profileId ? { activeProfileId: null } : {}),
        },
    });
    if (generationUpdate.count !== 1) {
        const current = await tx.connectedServiceAuthGroup.findUnique({
            where: { id: group.id },
            select: { generation: true },
        });
        return { type: "generation_conflict", generation: current?.generation ?? group.generation };
    }

    await tx.connectedServiceAuthGroupMember.delete({ where: { id: member.id } });
    return "deleted";
}
