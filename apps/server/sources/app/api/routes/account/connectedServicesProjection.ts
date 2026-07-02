import {
    ConnectedServiceIdSchema,
    type ConnectedServiceCredentialHealthV1,
    type ConnectedServiceId,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";
import { isConnectedServiceCredentialMetadataV2 } from "../connect/connectedServicesV2/credentialMetadataV2";
import { isConnectedServiceCredentialMetadataV3 } from "../connect/connectedServicesV3/credentialMetadataV3";
import { deriveConnectedServiceCredentialStatus } from "../connect/credentialHealthMetadata";
import { collectLegacyConnectedServiceVendorKeysFromRows } from "../connect/legacyConnectedServiceVendors";

type ConnectedServiceProfileStatus =
    | "connected"
    | "refreshing"
    | "needs_reauth"
    | "refresh_failed_retryable";

export type ConnectedServiceProfileProjection = Readonly<{
    profileId: string;
    status: ConnectedServiceProfileStatus;
    kind: "oauth" | "token" | null;
    providerEmail: string | null;
    providerAccountId: string | null;
    expiresAt: number | null;
    lastUsedAt: number | null;
    health: ConnectedServiceCredentialHealthV1 | null;
}>;

export type ConnectedServiceGroupProjection = Readonly<{
    groupId: string;
    displayName: string | null;
    activeProfileId: string | null;
    generation: number;
    memberProfileIds: string[];
}>;

export type ConnectedServiceServiceProjection = Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ConnectedServiceProfileProjection[];
    groups: ConnectedServiceGroupProjection[];
}>;

export type AccountConnectedServicesProjection = Readonly<{
    connectedServices: string[];
    connectedServicesV2: ConnectedServiceServiceProjection[];
}>;

type ConnectedServiceTokenProjectionRow = Readonly<{
    vendor: string;
    profileId: string;
    metadata: unknown;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
}>;

type ConnectedServiceAuthGroupProjectionRow = Readonly<{
    vendor: string;
    groupId: string;
    displayName: string | null;
    activeProfileId: string | null;
    generation: number;
    members: ReadonlyArray<Readonly<{ profileId: string }>>;
}>;

type AccountConnectedServicesProjectionStorage = Pick<Tx, "serviceAccountToken" | "connectedServiceAuthGroup">;

function resolveCredentialMetadata(metadata: unknown): Readonly<{
    status: ConnectedServiceProfileStatus;
    kind: "oauth" | "token";
    providerEmail: string | null;
    providerAccountId: string | null;
    health: ConnectedServiceCredentialHealthV1 | null;
}> | null {
    if (isConnectedServiceCredentialMetadataV2(metadata)) {
        return {
            status: deriveConnectedServiceCredentialStatus(metadata),
            kind: metadata.kind,
            providerEmail: metadata.providerEmail ?? null,
            providerAccountId: metadata.providerAccountId ?? null,
            health: metadata.health ?? null,
        };
    }
    if (isConnectedServiceCredentialMetadataV3(metadata)) {
        return {
            status: deriveConnectedServiceCredentialStatus(metadata),
            kind: metadata.kind,
            providerEmail: metadata.providerEmail ?? null,
            providerAccountId: metadata.providerAccountId ?? null,
            health: metadata.health ?? null,
        };
    }
    return null;
}

function addTokenProfilesToServices(params: Readonly<{
    rows: ReadonlyArray<ConnectedServiceTokenProjectionRow>;
    servicesById: Map<ConnectedServiceId, ConnectedServiceServiceProjection>;
}>): void {
    for (const row of params.rows) {
        const parsedServiceId = ConnectedServiceIdSchema.safeParse(row.vendor);
        if (!parsedServiceId.success) continue;

        const serviceId = parsedServiceId.data;
        const existing = params.servicesById.get(serviceId) ?? {
            serviceId,
            profiles: [],
            groups: [],
        };
        const metadata = resolveCredentialMetadata(row.metadata);
        existing.profiles.push({
            profileId: row.profileId,
            status: metadata?.status ?? "needs_reauth",
            kind: metadata?.kind ?? null,
            providerEmail: metadata?.providerEmail ?? null,
            providerAccountId: metadata?.providerAccountId ?? null,
            expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
            lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
            health: metadata?.health ?? null,
        });
        params.servicesById.set(serviceId, existing);
    }
}

function addAuthGroupsToServices(params: Readonly<{
    rows: ReadonlyArray<ConnectedServiceAuthGroupProjectionRow>;
    servicesById: Map<ConnectedServiceId, ConnectedServiceServiceProjection>;
}>): void {
    for (const row of params.rows) {
        const parsedServiceId = ConnectedServiceIdSchema.safeParse(row.vendor);
        if (!parsedServiceId.success) continue;

        const serviceId = parsedServiceId.data;
        const existing = params.servicesById.get(serviceId) ?? {
            serviceId,
            profiles: [],
            groups: [],
        };
        const memberProfileIds = row.members.map((member) => member.profileId);
        existing.groups.push({
            groupId: row.groupId,
            displayName: row.displayName,
            activeProfileId: row.activeProfileId && memberProfileIds.includes(row.activeProfileId)
                ? row.activeProfileId
                : null,
            generation: row.generation,
            memberProfileIds,
        });
        params.servicesById.set(serviceId, existing);
    }
}

export async function buildAccountConnectedServicesProjection(params: Readonly<{
    tx: AccountConnectedServicesProjectionStorage;
    accountId: string;
    includeGroups: boolean;
}>): Promise<AccountConnectedServicesProjection> {
    const tokenRows = await params.tx.serviceAccountToken.findMany({
        where: { accountId: params.accountId },
        select: {
            vendor: true,
            profileId: true,
            metadata: true,
            expiresAt: true,
            lastUsedAt: true,
        },
    });

    const servicesById = new Map<ConnectedServiceId, ConnectedServiceServiceProjection>();
    addTokenProfilesToServices({ rows: tokenRows, servicesById });

    if (params.includeGroups) {
        const authGroups = await params.tx.connectedServiceAuthGroup.findMany({
            where: { accountId: params.accountId },
            select: {
                vendor: true,
                groupId: true,
                displayName: true,
                activeProfileId: true,
                generation: true,
                members: {
                    select: { profileId: true },
                    where: { enabled: true },
                    orderBy: [{ priority: "asc" }, { createdAt: "asc" }, { profileId: "asc" }],
                },
            },
            orderBy: [{ vendor: "asc" }, { groupId: "asc" }],
        });
        addAuthGroupsToServices({ rows: authGroups, servicesById });
    }

    return {
        connectedServices: collectLegacyConnectedServiceVendorKeysFromRows(tokenRows),
        connectedServicesV2: Array.from(servicesById.values()),
    };
}
