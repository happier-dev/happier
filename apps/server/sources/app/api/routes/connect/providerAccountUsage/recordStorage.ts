import type { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import { prismaRuntime, type TransactionClient } from "@/storage/prisma";
import {
    ProviderAccountUsageRecordKeyV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    SealedProviderAccountUsageSnapshotV1Schema,
    ProviderAccountSubscriptionV1Schema,
    ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema,
    splitProviderAccountUsageSupplementalFacets,
} from "@happier-dev/protocol";
import { validateProviderAccountUsageRecordWrite } from "./schemas";
import type {
    ProviderAccountUsageRecordMetadata,
    StoredProviderAccountUsageRecord,
    UpsertProviderAccountUsageRecordParams,
} from "./types";
import { ProviderAccountUsagePayloadInvariantError } from "./types";

type ProviderAccountUsageRecordClient = Pick<typeof db, "providerAccountUsageRecord">
    | Pick<TransactionClient, "providerAccountUsageRecord">;

type ParsedProviderAccountUsageRecordWrite = ReturnType<typeof validateProviderAccountUsageRecordWrite>;

export type ProviderAccountUsageRecordCurrentGuard = Readonly<{
    fetchedAt: number | null;
    refreshRequestedAt?: number;
    metadata?: ProviderAccountUsageRecordMetadata;
}>;

function toNullableDate(value: number | undefined): Date | undefined {
    return value === undefined ? undefined : new Date(value);
}

function normalizeQuotaScopeIdKey(quotaScopeId: string | undefined): string {
    return quotaScopeId ?? "";
}

function isJsonFieldAbsent(value: unknown): boolean {
    return value === null
        || value === undefined
        || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0);
}

function parseStoredProviderAccountUsageRecord(row: Readonly<{
    accountId: string;
    recordId: string;
    recordKeyJson: unknown;
    payloadMode: string;
    status: string;
    snapshot: unknown;
    sealedPayload: unknown;
    fetchedAt: Date | null;
    staleAfterMs: number | null;
    refreshRequestedAt: Date | null;
    metadata: unknown;
}>): StoredProviderAccountUsageRecord {
    const recordKey = ProviderAccountUsageRecordKeyV1Schema.parse(row.recordKeyJson);
    const payloadMode =
        row.payloadMode === "plain_json_v1" || row.payloadMode === "sealed_account_scoped_v1"
            ? row.payloadMode
            : null;
    if (!payloadMode) {
        throw new ProviderAccountUsagePayloadInvariantError(`Unsupported provider account usage payload mode: ${row.payloadMode}`);
    }
    const status =
        row.status === "ok"
        || row.status === "unavailable"
        || row.status === "estimated"
        || row.status === "error"
        || row.status === "refresh_requested"
            ? row.status
            : null;
    if (!status) {
        throw new ProviderAccountUsagePayloadInvariantError(`Unsupported provider account usage status: ${row.status}`);
    }
    const baseSnapshot = isJsonFieldAbsent(row.snapshot)
        ? undefined
        : ProviderAccountUsageSnapshotV1Schema.parse(row.snapshot);
    const metadata = row.metadata === null || row.metadata === undefined
        ? undefined
        : zodProviderAccountUsageMetadata(row.metadata);
    const snapshot = baseSnapshot
        ? {
            ...baseSnapshot,
            ...(metadata?.subscription ? { subscription: metadata.subscription } : {}),
            ...(metadata?.recoveryCreditDetails ? { recoveryCreditDetails: metadata.recoveryCreditDetails } : {}),
        }
        : undefined;
    const sealedPayload = isJsonFieldAbsent(row.sealedPayload)
        ? undefined
        : SealedProviderAccountUsageSnapshotV1Schema.parse(row.sealedPayload);
    if (payloadMode === "plain_json_v1" && (sealedPayload || (!snapshot && status !== "refresh_requested"))) {
        throw new ProviderAccountUsagePayloadInvariantError("Stored plain provider account usage record payload is invalid");
    }
    if (payloadMode === "sealed_account_scoped_v1" && (snapshot || (!sealedPayload && status !== "refresh_requested"))) {
        throw new ProviderAccountUsagePayloadInvariantError("Stored sealed provider account usage record payload is invalid");
    }
    return {
        accountId: row.accountId,
        recordId: row.recordId as StoredProviderAccountUsageRecord["recordId"],
        recordKey,
        payloadMode,
        status,
        ...(snapshot ? { snapshot } : {}),
        ...(sealedPayload ? { sealedPayload } : {}),
        fetchedAt: row.fetchedAt ? row.fetchedAt.getTime() : null,
        staleAfterMs: typeof row.staleAfterMs === "number" ? row.staleAfterMs : null,
        ...(row.refreshRequestedAt ? { refreshRequestedAt: row.refreshRequestedAt.getTime() } : {}),
        ...(metadata ? { metadata } : {}),
    };
}

function zodProviderAccountUsageMetadata(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ProviderAccountUsagePayloadInvariantError("Stored provider account usage metadata must be an object");
    }
    const materialFingerprint = (raw as { materialFingerprint?: unknown }).materialFingerprint;
    if (materialFingerprint !== undefined && typeof materialFingerprint !== "string") {
        throw new ProviderAccountUsagePayloadInvariantError("Stored provider account usage materialFingerprint must be a string");
    }
    const subscription = (raw as { subscription?: unknown }).subscription;
    const refreshErrorAt = (raw as { refreshErrorAt?: unknown }).refreshErrorAt;
    if (refreshErrorAt !== undefined && (typeof refreshErrorAt !== "number" || !Number.isSafeInteger(refreshErrorAt) || refreshErrorAt < 0)) {
        throw new ProviderAccountUsagePayloadInvariantError("Stored provider account usage refreshErrorAt must be a nonnegative integer");
    }
    const recoveryCreditDetails = (raw as { recoveryCreditDetails?: unknown }).recoveryCreditDetails;
    return {
        ...(materialFingerprint ? { materialFingerprint } : {}),
        ...(refreshErrorAt !== undefined ? { refreshErrorAt } : {}),
        ...(subscription !== undefined ? { subscription: ProviderAccountSubscriptionV1Schema.parse(subscription) } : {}),
        ...(recoveryCreditDetails !== undefined ? { recoveryCreditDetails: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema.parse(recoveryCreditDetails) } : {}),
    };
}

function parseProviderAccountUsageRecordWrite(raw: UpsertProviderAccountUsageRecordParams): ParsedProviderAccountUsageRecordWrite {
    try {
        return validateProviderAccountUsageRecordWrite(raw);
    } catch (error) {
        throw new ProviderAccountUsagePayloadInvariantError(
            error instanceof Error ? error.message : "Invalid provider account usage payload",
        );
    }
}

function buildProviderAccountUsageRecordCreateData(parsed: ParsedProviderAccountUsageRecordWrite) {
    const plain = parsed.snapshot ? splitProviderAccountUsageSupplementalFacets(parsed.snapshot) : undefined;
    return {
        accountId: parsed.accountId,
        providerId: parsed.recordKey.providerId,
        recordId: parsed.recordId,
        accountSubjectId: parsed.recordKey.accountSubjectId,
        subjectKind: parsed.recordKey.subjectKind,
        quotaScope: parsed.recordKey.quotaScope,
        quotaScopeId: parsed.recordKey.quotaScopeId,
        quotaScopeIdKey: normalizeQuotaScopeIdKey(parsed.recordKey.quotaScopeId),
        recordKeyJson: parsed.recordKey,
        payloadMode: parsed.payloadMode,
        status: parsed.status,
        ...(plain ? { snapshot: plain.snapshot as Prisma.InputJsonValue } : {}),
        ...(parsed.sealedPayload ? { sealedPayload: parsed.sealedPayload as Prisma.InputJsonValue } : {}),
        ...(parsed.fetchedAt !== undefined ? { fetchedAt: new Date(parsed.fetchedAt) } : {}),
        ...(parsed.staleAfterMs !== undefined ? { staleAfterMs: parsed.staleAfterMs } : {}),
        ...(parsed.refreshRequestedAt !== undefined ? { refreshRequestedAt: new Date(parsed.refreshRequestedAt) } : {}),
        ...(parsed.metadata || plain?.subscription || plain?.recoveryCreditDetails ? {
            metadata: {
                ...parsed.metadata,
                ...(plain?.subscription ? { subscription: plain.subscription } : {}),
                ...(plain?.recoveryCreditDetails ? { recoveryCreditDetails: plain.recoveryCreditDetails } : {}),
            } as Prisma.InputJsonValue,
        } : {}),
    };
}

function buildProviderAccountUsageRecordUpdateData(parsed: ParsedProviderAccountUsageRecordWrite) {
    const plain = parsed.snapshot ? splitProviderAccountUsageSupplementalFacets(parsed.snapshot) : undefined;
    return {
        providerId: parsed.recordKey.providerId,
        accountSubjectId: parsed.recordKey.accountSubjectId,
        subjectKind: parsed.recordKey.subjectKind,
        quotaScope: parsed.recordKey.quotaScope,
        quotaScopeId: parsed.recordKey.quotaScopeId,
        quotaScopeIdKey: normalizeQuotaScopeIdKey(parsed.recordKey.quotaScopeId),
        recordKeyJson: parsed.recordKey,
        payloadMode: parsed.payloadMode,
        status: parsed.status,
        snapshot: plain ? plain.snapshot as Prisma.InputJsonValue : prismaRuntime.DbNull,
        sealedPayload: parsed.sealedPayload ? parsed.sealedPayload as Prisma.InputJsonValue : prismaRuntime.DbNull,
        fetchedAt: parsed.fetchedAt !== undefined ? new Date(parsed.fetchedAt) : null,
        staleAfterMs: parsed.staleAfterMs ?? null,
        refreshRequestedAt: parsed.refreshRequestedAt !== undefined ? new Date(parsed.refreshRequestedAt) : null,
        metadata: parsed.metadata || plain?.subscription || plain?.recoveryCreditDetails
            ? {
                ...parsed.metadata,
                ...(plain?.subscription ? { subscription: plain.subscription } : {}),
                ...(plain?.recoveryCreditDetails ? { recoveryCreditDetails: plain.recoveryCreditDetails } : {}),
            } as Prisma.InputJsonValue
            : prismaRuntime.DbNull,
    };
}

function buildProviderAccountUsageRecordCurrentWhere(
    parsed: ParsedProviderAccountUsageRecordWrite,
    guard: ProviderAccountUsageRecordCurrentGuard,
) {
    return {
        accountId: parsed.accountId,
        recordId: parsed.recordId,
        fetchedAt: guard.fetchedAt === null ? null : new Date(guard.fetchedAt),
        refreshRequestedAt: guard.refreshRequestedAt === undefined ? null : new Date(guard.refreshRequestedAt),
        metadata: { equals: guard.metadata ? guard.metadata as Prisma.InputJsonValue : prismaRuntime.AnyNull },
    };
}

export async function upsertProviderAccountUsageRecord(
    raw: UpsertProviderAccountUsageRecordParams,
    client: ProviderAccountUsageRecordClient = db,
): Promise<StoredProviderAccountUsageRecord> {
    const parsed = parseProviderAccountUsageRecordWrite(raw);

    await client.providerAccountUsageRecord.upsert({
        where: {
            accountId_recordId: {
                accountId: parsed.accountId,
                recordId: parsed.recordId,
            },
        },
        create: buildProviderAccountUsageRecordCreateData(parsed),
        update: buildProviderAccountUsageRecordUpdateData(parsed),
    });

    const stored = await readProviderAccountUsageRecord({
        accountId: parsed.accountId,
        recordId: parsed.recordId,
    }, client);
    if (!stored) {
        throw new Error("Provider account usage record disappeared after upsert");
    }
    return stored;
}

export async function createProviderAccountUsageRecord(
    raw: UpsertProviderAccountUsageRecordParams,
    client: ProviderAccountUsageRecordClient = db,
): Promise<StoredProviderAccountUsageRecord> {
    const parsed = parseProviderAccountUsageRecordWrite(raw);
    await client.providerAccountUsageRecord.create({
        data: buildProviderAccountUsageRecordCreateData(parsed),
    });
    const stored = await readProviderAccountUsageRecord({
        accountId: parsed.accountId,
        recordId: parsed.recordId,
    }, client);
    if (!stored) {
        throw new Error("Provider account usage record disappeared after create");
    }
    return stored;
}

export async function updateProviderAccountUsageRecordIfCurrent(
    raw: UpsertProviderAccountUsageRecordParams,
    guard: ProviderAccountUsageRecordCurrentGuard,
    client: ProviderAccountUsageRecordClient = db,
): Promise<StoredProviderAccountUsageRecord | null> {
    const parsed = parseProviderAccountUsageRecordWrite(raw);
    const updated = await client.providerAccountUsageRecord.updateMany({
        where: buildProviderAccountUsageRecordCurrentWhere(parsed, guard),
        data: buildProviderAccountUsageRecordUpdateData(parsed),
    });
    if (updated.count === 0) return null;
    const stored = await readProviderAccountUsageRecord({
        accountId: parsed.accountId,
        recordId: parsed.recordId,
    }, client);
    if (!stored) {
        throw new Error("Provider account usage record disappeared after guarded update");
    }
    return stored;
}

export async function writeProviderAccountUsageRecord(
    raw: UpsertProviderAccountUsageRecordParams,
    client: ProviderAccountUsageRecordClient = db,
): Promise<StoredProviderAccountUsageRecord> {
    return await upsertProviderAccountUsageRecord(raw, client);
}

export async function readProviderAccountUsageRecord(params: Readonly<{
    accountId: string;
    recordId: string;
}>, client: ProviderAccountUsageRecordClient = db): Promise<StoredProviderAccountUsageRecord | null> {
    const row = await client.providerAccountUsageRecord.findUnique({
        where: {
            accountId_recordId: {
                accountId: params.accountId,
                recordId: params.recordId,
            },
        },
        select: {
            accountId: true,
            recordId: true,
            recordKeyJson: true,
            payloadMode: true,
            status: true,
            snapshot: true,
            sealedPayload: true,
            fetchedAt: true,
            staleAfterMs: true,
            refreshRequestedAt: true,
            metadata: true,
        },
    });
    return row ? parseStoredProviderAccountUsageRecord(row) : null;
}

export async function requestProviderAccountUsageRefresh(params: Readonly<{
    accountId: string;
    recordId: string;
}>, client: ProviderAccountUsageRecordClient = db): Promise<"written" | "not_found"> {
    const updated = await client.providerAccountUsageRecord.updateMany({
        where: {
            accountId: params.accountId,
            recordId: params.recordId,
        },
        data: {
            refreshRequestedAt: new Date(),
        },
    });
    return updated.count > 0 ? "written" : "not_found";
}

/** Lists only outstanding requests owned by this account, including records a restarted daemon has not seen. */
export async function listProviderAccountUsageRefreshRequests(accountId: string): Promise<string[]> {
    const rows = await db.providerAccountUsageRecord.findMany({
        where: { accountId, refreshRequestedAt: { not: null } },
        select: { recordId: true, fetchedAt: true, refreshRequestedAt: true },
        orderBy: { recordId: "asc" },
    });
    return rows.filter((row) => row.refreshRequestedAt !== null
        && (row.fetchedAt === null || row.refreshRequestedAt > row.fetchedAt)).map((row) => row.recordId);
}

export async function deleteProviderAccountUsageRecord(params: Readonly<{
    accountId: string;
    recordId: string;
}>, client: ProviderAccountUsageRecordClient = db): Promise<"deleted" | "not_found"> {
    const deleted = await client.providerAccountUsageRecord.deleteMany({
        where: {
            accountId: params.accountId,
            recordId: params.recordId,
        },
    });
    return deleted.count > 0 ? "deleted" : "not_found";
}

export async function deleteProviderAccountUsageRecordsForAccount(params: Readonly<{
    accountId: string;
}>, client: ProviderAccountUsageRecordClient = db): Promise<number> {
    const deleted = await client.providerAccountUsageRecord.deleteMany({
        where: { accountId: params.accountId },
    });
    return deleted.count;
}
