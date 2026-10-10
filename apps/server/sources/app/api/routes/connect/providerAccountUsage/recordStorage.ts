import type { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import { prismaRuntime, type TransactionClient } from "@/storage/prisma";
import {
    ProviderAccountUsageRecordKeyV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    SealedProviderAccountUsageSnapshotV1Schema,
} from "@happier-dev/protocol";
import {
    ProviderAccountUsageRecordMetadataSchema,
    validateProviderAccountUsageRecordWrite,
} from "./schemas";
import type {
    StoredProviderAccountUsageRecord,
    UpsertProviderAccountUsageRecordParams,
} from "./types";
import { ProviderAccountUsagePayloadInvariantError } from "./types";

type ProviderAccountUsageRecordClient = Pick<typeof db, "providerAccountUsageRecord">
    | Pick<TransactionClient, "providerAccountUsageRecord">;

type ParsedProviderAccountUsageRecordWrite = ReturnType<typeof validateProviderAccountUsageRecordWrite>;

export function projectProviderAccountUsageRecordV4(record: StoredProviderAccountUsageRecord, sources: readonly import('@happier-dev/protocol').QualifiedConnectedServiceUsageSourceV4[]) {
    if (record.payloadMode === 'plain_json_v1' ? !record.snapshot : !record.sealedPayload) throw new ProviderAccountUsagePayloadInvariantError('Provider usage payload is unavailable');
    return {
        content: record.payloadMode === 'plain_json_v1' ? { t: 'plain' as const, v: record.snapshot! } : { t: 'encrypted' as const, c: record.sealedPayload!.ciphertext, ...(record.sealedPayload!.subscription ? { subscription: record.sealedPayload!.subscription } : {}) },
        metadata: { fetchedAt: record.fetchedAt ?? record.snapshot?.fetchedAtMs ?? 0, staleAfterMs: record.staleAfterMs ?? record.snapshot?.staleAfterMs ?? 0, status: record.status === 'unavailable' || record.status === 'estimated' || record.status === 'error' ? record.status : 'ok' as const, ...(record.refreshRequestedAt !== undefined ? { refreshRequestedAt: record.refreshRequestedAt } : {}) },
        sources: [...sources],
    };
}

export async function readProviderAccountUsageHistory(params: Readonly<{ accountId: string; recordId: string; history: import('@happier-dev/protocol/connect/providerAccountUsageHistory').ProviderAccountUsageHistoryRequestV1 }>, client: ProviderAccountUsageRecordClient = db) {
    const { range, pageSize, cursor } = params.history;
    const row = await client.providerAccountUsageRecord.findUnique({
        where: { accountId_recordId: { accountId: params.accountId, recordId: params.recordId } },
        select: { history: { where: {
            observedAt: { gte: new Date(range.startAtMs), lt: new Date(range.endAtMs) },
            ...(cursor ? { OR: [{ observedAt: { gt: new Date(cursor.observedAtMs) } }, { observedAt: new Date(cursor.observedAtMs), id: { gt: cursor.id } }] } : {}),
        }, orderBy: [{ observedAt: 'asc' }, { id: 'asc' }], take: pageSize + 1, select: { id: true, observedAt: true, payload: true } } },
    });
    const rows = row?.history ?? [];
    const entries = rows.slice(0, pageSize).map(entry => ({ id: entry.id, observedAtMs: entry.observedAt.getTime(), record: parseHistoryRecord(entry.payload) }));
    const last = entries.at(-1);
    return { entries, nextCursor: rows.length > pageSize && last ? { observedAtMs: last.observedAtMs, id: last.id } : null };
}

function parseHistoryRecord(payload: unknown): StoredProviderAccountUsageRecord {
    const parsed = parseProviderAccountUsageRecordWrite(payload);
    return { ...parsed, fetchedAt: parsed.fetchedAt ?? null, staleAfterMs: parsed.staleAfterMs ?? null };
}

export async function hasProviderAccountUsageHistory(params: Readonly<{ accountId: string; recordId: string }>, client: ProviderAccountUsageRecordClient): Promise<boolean> {
    const row = await client.providerAccountUsageRecord.findUnique({
        where: { accountId_recordId: params },
        select: { history: { take: 1, select: { id: true } } },
    });
    return (row?.history.length ?? 0) > 0;
}

export async function readProviderAccountUsageHistoryWitness(params: Readonly<{ accountId: string; recordId: string; witness: import('@happier-dev/protocol/connect/providerAccountUsageHistory').ProviderAccountUsageHistoryWitnessV1 }>, client: ProviderAccountUsageRecordClient = db) {
    const row = await client.providerAccountUsageRecord.findUnique({
        where: { accountId_recordId: { accountId: params.accountId, recordId: params.recordId } },
        select: { history: { where: { id: params.witness.id, observedAt: new Date(params.witness.observedAtMs) }, select: { id: true, observedAt: true, payload: true } } },
    });
    const entry = row?.history[0];
    return entry ? { id: entry.id, observedAtMs: entry.observedAt.getTime(), record: parseHistoryRecord(entry.payload) } : null;
}

/** Only the accepted-write policy invokes this inside the same transaction as its CAS. */
export async function retainProviderAccountUsageHistory(raw: UpsertProviderAccountUsageRecordParams, client: ProviderAccountUsageRecordClient) {
    const parsed = parseProviderAccountUsageRecordWrite(raw);
    if (parsed.fetchedAt === undefined || (!parsed.snapshot && !parsed.sealedPayload)) return;
    await client.providerAccountUsageRecord.update({
        where: { accountId_recordId: { accountId: parsed.accountId, recordId: parsed.recordId } },
        data: { history: { create: { observedAt: new Date(parsed.fetchedAt), payload: parsed as Prisma.InputJsonValue } } },
    });
}

export type ProviderAccountUsageRecordCurrentGuard = Readonly<{
    fetchedAt: number | null;
    refreshRequestedAt?: number;
}>;

function normalizeQuotaScopeIdKey(quotaScopeId: string | undefined): string {
    return quotaScopeId ?? "";
}

function isJsonFieldAbsent(value: unknown): boolean {
    return value === null
        || value === undefined
        || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0);
}

function zodProviderAccountUsageMetadata(raw: unknown) {
    try {
        return ProviderAccountUsageRecordMetadataSchema.parse(raw);
    } catch {
        throw new ProviderAccountUsagePayloadInvariantError(
            "Stored provider account usage metadata is invalid",
        );
    }
}

function parseProviderAccountUsageRecordWrite(raw: unknown): ParsedProviderAccountUsageRecordWrite {
    try {
        return validateProviderAccountUsageRecordWrite(raw);
    } catch (error) {
        throw new ProviderAccountUsagePayloadInvariantError(
            error instanceof Error ? error.message : "Invalid provider account usage payload",
        );
    }
}

function buildProviderAccountUsageRecordCreateData(parsed: ParsedProviderAccountUsageRecordWrite) {
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
        ...(parsed.snapshot ? { snapshot: parsed.snapshot as Prisma.InputJsonValue } : {}),
        ...(parsed.sealedPayload ? { sealedPayload: parsed.sealedPayload as Prisma.InputJsonValue } : {}),
        ...(parsed.fetchedAt !== undefined ? { fetchedAt: new Date(parsed.fetchedAt) } : {}),
        ...(parsed.staleAfterMs !== undefined ? { staleAfterMs: parsed.staleAfterMs } : {}),
        ...(parsed.refreshRequestedAt !== undefined ? { refreshRequestedAt: new Date(parsed.refreshRequestedAt) } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata as Prisma.InputJsonValue } : {}),
    };
}

function buildProviderAccountUsageRecordUpdateData(parsed: ParsedProviderAccountUsageRecordWrite) {
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
        snapshot: parsed.snapshot ? parsed.snapshot as Prisma.InputJsonValue : prismaRuntime.DbNull,
        sealedPayload: parsed.sealedPayload ? parsed.sealedPayload as Prisma.InputJsonValue : prismaRuntime.DbNull,
        fetchedAt: parsed.fetchedAt !== undefined ? new Date(parsed.fetchedAt) : null,
        staleAfterMs: parsed.staleAfterMs ?? null,
        refreshRequestedAt: parsed.refreshRequestedAt !== undefined ? new Date(parsed.refreshRequestedAt) : null,
        metadata: parsed.metadata ? parsed.metadata as Prisma.InputJsonValue : prismaRuntime.DbNull,
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
    };
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
    const snapshot = isJsonFieldAbsent(row.snapshot)
        ? undefined
        : ProviderAccountUsageSnapshotV1Schema.parse(row.snapshot);
    const sealedPayload = isJsonFieldAbsent(row.sealedPayload)
        ? undefined
        : SealedProviderAccountUsageSnapshotV1Schema.parse(row.sealedPayload);
    if (payloadMode === "plain_json_v1" && (sealedPayload || (!snapshot && status !== "refresh_requested"))) {
        throw new ProviderAccountUsagePayloadInvariantError("Stored plain provider account usage record payload is invalid");
    }
    if (payloadMode === "sealed_account_scoped_v1" && (snapshot || (!sealedPayload && status !== "refresh_requested"))) {
        throw new ProviderAccountUsagePayloadInvariantError("Stored sealed provider account usage record payload is invalid");
    }
    const metadata = row.metadata === null || row.metadata === undefined
        ? undefined
        : zodProviderAccountUsageMetadata(row.metadata);
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
