import type { Prisma } from "@prisma/client";

import { quotaSnapshotStaleWriteRejectedCounter } from "@/app/monitoring/metrics/quotaSnapshotMetrics";
import { db } from "@/storage/db";
import { isPrismaErrorCode } from "@/storage/prisma";

type QuotaSnapshotRouteVersion = "v2" | "v3";

type QuotaSnapshotStatus = "ok" | "unavailable" | "estimated" | "error";

type ExistingQuotaSnapshotRow = Readonly<{
    id: string;
    fetchedAt: Date | null;
    metadata: unknown;
    updatedAt: Date;
}>;

type PersistQuotaSnapshotParams = Readonly<{
    route: QuotaSnapshotRouteVersion;
    accountId: string;
    vendor: string;
    profileId: string;
    snapshot: Uint8Array<ArrayBuffer>;
    status: QuotaSnapshotStatus;
    fetchedAtMs: number;
    staleAfterMs: number;
    metadata: Prisma.InputJsonValue;
}>;

const MAX_IDEMPOTENT_WRITE_ATTEMPTS = 3;

type ConditionalWriteMode = "guardUpdatedAt" | "forceIfStillNewer";

export function readQuotaSnapshotMaterialFingerprint(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const value = (metadata as Record<string, unknown>).materialFingerprint;
    return typeof value === "string" && value.length > 0 ? value : null;
}

function hasQuotaSnapshotRefreshRequest(metadata: unknown): boolean {
    return !!metadata
        && typeof metadata === "object"
        && !Array.isArray(metadata)
        && Object.prototype.hasOwnProperty.call(metadata, "refreshRequestedAt");
}

function readQuotaSnapshotRefreshRequestedAt(metadata: unknown): number | null {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const value = (metadata as Record<string, unknown>).refreshRequestedAt;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function preserveRefreshRequestedAt(metadata: Prisma.InputJsonValue, refreshRequestedAt: number): Prisma.InputJsonValue {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return { refreshRequestedAt };
    }
    return { ...(metadata as Prisma.InputJsonObject), refreshRequestedAt };
}

function recordStaleWriteRejected(route: QuotaSnapshotRouteVersion): void {
    try {
        quotaSnapshotStaleWriteRejectedCounter.inc({ route });
    } catch {
        // Metrics must never turn an idempotent stale-write rejection into a failed request.
    }
}

function buildSnapshotData(params: PersistQuotaSnapshotParams) {
    return {
        updatedAt: new Date(),
        snapshot: params.snapshot,
        status: params.status,
        fetchedAt: new Date(params.fetchedAtMs),
        staleAfterMs: params.staleAfterMs,
        metadata: params.metadata,
    };
}

export function buildNewerQuotaSnapshotWriteGuard(params: Readonly<{
    id: string;
    incomingFetchedAtMs: number;
}>): Prisma.ServiceAccountQuotaSnapshotWhereInput {
    return {
        id: params.id,
        OR: [
            { fetchedAt: null },
            { fetchedAt: { lt: new Date(params.incomingFetchedAtMs) } },
        ],
    };
}

async function writeLegacyQuotaSnapshot(params: PersistQuotaSnapshotParams): Promise<void> {
    await db.serviceAccountQuotaSnapshot.upsert({
        where: { accountId_vendor_profileId: { accountId: params.accountId, vendor: params.vendor, profileId: params.profileId } },
        update: buildSnapshotData(params),
        create: {
            accountId: params.accountId,
            vendor: params.vendor,
            profileId: params.profileId,
            snapshot: params.snapshot,
            status: params.status,
            fetchedAt: new Date(params.fetchedAtMs),
            staleAfterMs: params.staleAfterMs,
            metadata: params.metadata,
        },
    });
}

async function createQuotaSnapshot(params: PersistQuotaSnapshotParams): Promise<"created" | "raced"> {
    try {
        await db.serviceAccountQuotaSnapshot.create({
            data: {
                accountId: params.accountId,
                vendor: params.vendor,
                profileId: params.profileId,
                snapshot: params.snapshot,
                status: params.status,
                fetchedAt: new Date(params.fetchedAtMs),
                staleAfterMs: params.staleAfterMs,
                metadata: params.metadata,
            },
        });
        return "created";
    } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) return "raced";
        throw error;
    }
}

async function updateNewerSnapshot(
    params: PersistQuotaSnapshotParams,
    existing: ExistingQuotaSnapshotRow,
    mode: ConditionalWriteMode,
): Promise<"updated" | "noop" | "missed"> {
    const existingFetchedAtMs = existing.fetchedAt?.getTime() ?? null;
    if (existingFetchedAtMs !== null && params.fetchedAtMs <= existingFetchedAtMs) {
        recordStaleWriteRejected(params.route);
        return "noop";
    }
    const refreshRequestedAt = readQuotaSnapshotRefreshRequestedAt(existing.metadata);
    const shouldPreserveRefreshRequest = refreshRequestedAt !== null && params.fetchedAtMs < refreshRequestedAt;

    const update = await db.serviceAccountQuotaSnapshot.updateMany({
        where: {
            ...buildNewerQuotaSnapshotWriteGuard({ id: existing.id, incomingFetchedAtMs: params.fetchedAtMs }),
            ...(mode === "guardUpdatedAt" ? { updatedAt: existing.updatedAt } : {}),
        },
        data: {
            ...buildSnapshotData(params),
            ...(shouldPreserveRefreshRequest
                ? { metadata: preserveRefreshRequestedAt(params.metadata, refreshRequestedAt) }
                : {}),
        },
    });

    return update.count > 0 ? "updated" : "missed";
}

async function updateDuplicateSnapshot(
    params: PersistQuotaSnapshotParams,
    existing: ExistingQuotaSnapshotRow,
    mode: ConditionalWriteMode,
): Promise<"updated" | "noop" | "missed"> {
    const existingFetchedAtMs = existing.fetchedAt?.getTime() ?? null;
    const isNewer = existingFetchedAtMs === null || params.fetchedAtMs > existingFetchedAtMs;
    const refreshRequestedAt = readQuotaSnapshotRefreshRequestedAt(existing.metadata);
    const hasRefreshRequest = refreshRequestedAt !== null || hasQuotaSnapshotRefreshRequest(existing.metadata);
    const satisfiesRefreshRequest = refreshRequestedAt === null || params.fetchedAtMs >= refreshRequestedAt;

    if (!isNewer && (!hasRefreshRequest || !satisfiesRefreshRequest)) return "noop";

    const where = isNewer
        ? {
            ...buildNewerQuotaSnapshotWriteGuard({ id: existing.id, incomingFetchedAtMs: params.fetchedAtMs }),
            ...(mode === "guardUpdatedAt" ? { updatedAt: existing.updatedAt } : {}),
        }
        : {
            id: existing.id,
            ...(mode === "guardUpdatedAt" ? { updatedAt: existing.updatedAt } : {}),
            ...(existing.fetchedAt ? { fetchedAt: existing.fetchedAt } : { fetchedAt: null }),
        };

    const update = await db.serviceAccountQuotaSnapshot.updateMany({
        where,
        data: {
            updatedAt: new Date(),
            metadata: hasRefreshRequest && !satisfiesRefreshRequest && refreshRequestedAt !== null
                ? preserveRefreshRequestedAt(params.metadata, refreshRequestedAt)
                : params.metadata,
            ...(isNewer
                ? {
                    snapshot: params.snapshot,
                    status: params.status,
                    fetchedAt: new Date(params.fetchedAtMs),
                    staleAfterMs: params.staleAfterMs,
                }
                : {}),
        },
    });

    return update.count > 0 ? "updated" : "missed";
}

async function findQuotaSnapshot(
    where: Readonly<{ accountId_vendor_profileId: Readonly<{ accountId: string; vendor: string; profileId: string }> }>,
): Promise<ExistingQuotaSnapshotRow | null> {
    return await db.serviceAccountQuotaSnapshot.findUnique({
        where,
        select: { id: true, fetchedAt: true, metadata: true, updatedAt: true },
    });
}

async function writeAfterContention(
    params: PersistQuotaSnapshotParams,
    where: Readonly<{ accountId_vendor_profileId: Readonly<{ accountId: string; vendor: string; profileId: string }> }>,
): Promise<"written" | "stale"> {
    const existing = await findQuotaSnapshot(where);
    if (!existing) {
        const created = await createQuotaSnapshot(params);
        return created === "created" ? "written" : "stale";
    }

    const existingFingerprint = readQuotaSnapshotMaterialFingerprint(existing.metadata);
    const result = existingFingerprint === readQuotaSnapshotMaterialFingerprint(params.metadata)
        ? await updateDuplicateSnapshot(params, existing, "forceIfStillNewer")
        : await updateNewerSnapshot(params, existing, "forceIfStillNewer");

    return result === "missed" || result === "noop" ? "stale" : "written";
}

export async function persistQuotaSnapshotWithIdempotency(params: PersistQuotaSnapshotParams): Promise<void> {
    const incomingFingerprint = readQuotaSnapshotMaterialFingerprint(params.metadata);
    if (!incomingFingerprint) {
        await writeLegacyQuotaSnapshot(params);
        return;
    }

    const where = { accountId_vendor_profileId: { accountId: params.accountId, vendor: params.vendor, profileId: params.profileId } };

    for (let attempt = 0; attempt < MAX_IDEMPOTENT_WRITE_ATTEMPTS; attempt += 1) {
        const existing = await findQuotaSnapshot(where);

        if (!existing) {
            const created = await createQuotaSnapshot(params);
            if (created === "created") return;
            continue;
        }

        if (readQuotaSnapshotMaterialFingerprint(existing.metadata) === incomingFingerprint) {
            const result = await updateDuplicateSnapshot(params, existing, "guardUpdatedAt");
            if (result !== "missed") return;
            continue;
        }

        const result = await updateNewerSnapshot(params, existing, "guardUpdatedAt");
        if (result !== "missed") return;
    }

    const contendedWrite = await writeAfterContention(params, where);
    if (contendedWrite === "written") return;

    recordStaleWriteRejected(params.route);
}
