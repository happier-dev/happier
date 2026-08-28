import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

type ReleasedQuotaStatus = "ok" | "unavailable" | "estimated" | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStatus(value: string | null): ReleasedQuotaStatus {
    return value === "unavailable" || value === "estimated" || value === "error"
        ? value
        : "ok";
}

function readRefreshRequestedAt(metadata: unknown): number | undefined {
    const value = isRecord(metadata) ? metadata.refreshRequestedAt : undefined;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : undefined;
}

/**
 * Reads the exact sealed V2 quota row written by released server-v0.2.1.
 * This is a bounded old-storage adapter: current writes remain owned by the
 * qualified ProviderAccountUsage repository and never write this table.
 */
export async function readReleasedConnectedServiceQuotaSnapshot(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>): Promise<Readonly<{
    ciphertext: string;
    fetchedAt: number;
    staleAfterMs: number;
    status: ReleasedQuotaStatus;
    refreshRequestedAt?: number;
}> | null> {
    const row = await db.serviceAccountQuotaSnapshot.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: {
            snapshot: true,
            status: true,
            fetchedAt: true,
            staleAfterMs: true,
            metadata: true,
        },
    });
    if (!row) return null;
    const ciphertext = new TextDecoder().decode(row.snapshot);
    if (!ciphertext.trim()) return null;
    const refreshRequestedAt = readRefreshRequestedAt(row.metadata);
    return {
        ciphertext,
        fetchedAt: row.fetchedAt?.getTime() ?? 0,
        staleAfterMs: row.staleAfterMs ?? 0,
        status: normalizeStatus(row.status),
        ...(refreshRequestedAt !== undefined ? { refreshRequestedAt } : {}),
    };
}

export async function requestReleasedConnectedServiceQuotaRefresh(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>): Promise<"updated" | "not_found"> {
    const where = {
        accountId_vendor_profileId: {
            accountId: params.accountId,
            vendor: params.serviceId,
            profileId: params.profileId,
        },
    } as const;
    const row = await db.serviceAccountQuotaSnapshot.findUnique({
        where,
        select: { metadata: true },
    });
    if (!row) return "not_found";
    const metadata = isRecord(row.metadata) ? row.metadata : {};
    await db.serviceAccountQuotaSnapshot.update({
        where,
        data: {
            metadata: {
                ...metadata,
                v: 1,
                format: "account_scoped_v1",
                refreshRequestedAt: Date.now(),
            },
        },
    });
    return "updated";
}

export async function deleteReleasedConnectedServiceQuotaSnapshot(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>): Promise<"deleted" | "not_found"> {
    return await deleteReleasedConnectedServiceQuotaSnapshotInStorage(db, params);
}

export async function deleteReleasedConnectedServiceQuotaSnapshotInStorage(
    storage: Pick<Tx, "serviceAccountQuotaSnapshot">,
    params: Readonly<{
        accountId: string;
        serviceId: string;
        profileId: string;
    }>,
): Promise<"deleted" | "not_found"> {
    const deleted = await storage.serviceAccountQuotaSnapshot.deleteMany({
        where: {
            accountId: params.accountId,
            vendor: params.serviceId,
            profileId: params.profileId,
        },
    });
    return deleted.count > 0 ? "deleted" : "not_found";
}
