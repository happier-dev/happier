import type { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import { getDbProviderFromEnv, prismaRuntime, type TransactionClient } from "@/storage/prisma";
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ProviderAccountUsageRecordKeyV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { parseBuiltInLegacyProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { SealedProviderAccountUsageSnapshotV1Schema, type SealedProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/accountUsage';
import { PROVIDER_ACCOUNT_USAGE_DAY_MS } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import {
    ProviderAccountUsageRecordMetadataSchema,
    UpsertProviderAccountUsageRecordSchema,
    validateProviderAccountUsageRecordWrite,
} from "./schemas";
import type {
    StoredProviderAccountUsageRecord,
    UpsertProviderAccountUsageRecordParams,
} from "./types";
import { ProviderAccountUsagePayloadInvariantError } from "./types";
import { appendProviderAccountUsagePendingDay } from './daySummaryPendingStorage';
import { usageSqlName as name, usageSqlTimestamp } from './storageSql';

type ProviderAccountUsageRecordClient = Pick<typeof db, "providerAccountUsageRecord">
    | Pick<TransactionClient, "providerAccountUsageRecord">;

type ParsedProviderAccountUsageRecordWrite = ReturnType<typeof validateProviderAccountUsageRecordWrite>;

export function projectSealedProviderAccountUsageContentV4(sealedPayload: SealedProviderAccountUsageSnapshotV1) {
    return {
        t: "encrypted" as const,
        c: sealedPayload.ciphertext,
        ...(sealedPayload.subscription ? { subscription: sealedPayload.subscription } : {}),
        ...(sealedPayload.recoveryCreditDetails ? { recoveryCreditDetails: sealedPayload.recoveryCreditDetails } : {}),
    };
}

export function projectProviderAccountUsageRecordV4(record: StoredProviderAccountUsageRecord, sources: readonly import('@happier-dev/protocol').QualifiedConnectedServiceUsageSourceV4[]) {
    if (record.payloadMode === 'plain_json_v1' ? !record.snapshot : !record.sealedPayload) throw new ProviderAccountUsagePayloadInvariantError('Provider usage payload is unavailable');
    return {
        content: record.payloadMode === 'plain_json_v1' ? { t: 'plain' as const, v: record.snapshot! } : projectSealedProviderAccountUsageContentV4(record.sealedPayload!),
        metadata: { fetchedAt: record.fetchedAt ?? record.snapshot?.fetchedAtMs ?? 0, staleAfterMs: record.staleAfterMs ?? record.snapshot?.staleAfterMs ?? 0, status: record.status === 'unavailable' || record.status === 'estimated' || record.status === 'error' ? record.status : 'ok' as const, ...(record.refreshRequestedAt !== undefined ? { refreshRequestedAt: record.refreshRequestedAt } : {}) },
        sources: [...sources],
    };
}

export async function readProviderAccountUsageHistory(params: Readonly<{ accountId: string; recordId: string; history: import('@happier-dev/protocol/connect/providerAccountUsageHistory').ProviderAccountUsageHistoryRequestV1 }>, client: Pick<TransactionClient, 'providerAccountUsageHistory'> = db) {
    const page = await readProviderAccountUsageHistoryPageRows(params, client);
    return { entries: page.entries.map(parseProviderAccountUsageHistoryEntry), nextCursor: page.nextCursor };
}

/** Capture database values in the admission snapshot; validate payloads after releasing its connection. */
export async function readProviderAccountUsageHistoryPageRows(params: Readonly<{ accountId: string; recordId: string; history: import('@happier-dev/protocol/connect/providerAccountUsageHistory').ProviderAccountUsageHistoryRequestV1 }>, client: Pick<TransactionClient, 'providerAccountUsageHistory'>) {
    const { range, pageSize, cursor } = params.history;
    // A parent relation read aggregates the entire page into one PostgreSQL
    // JSONB array, which can exceed its 256 MiB representation limit. Return
    // independent rows while retaining the same Account, range and cursor scope.
    const rows = await client.providerAccountUsageHistory.findMany({
        where: {
            accountId: params.accountId, recordId: params.recordId,
            observedAt: { gte: new Date(range.startAtMs), lt: new Date(range.endAtMs) },
            ...(cursor ? { OR: [{ observedAt: { gt: new Date(cursor.observedAtMs) } }, { observedAt: new Date(cursor.observedAtMs), id: { gt: cursor.id } }] } : {}),
        }, orderBy: [{ observedAt: 'asc' }, { id: 'asc' }], take: pageSize + 1, select: { id: true, observedAt: true, payload: true },
    });
    const entries = rows.slice(0, pageSize);
    const last = entries.at(-1);
    return { entries, nextCursor: rows.length > pageSize && last ? { observedAtMs: last.observedAt.getTime(), id: last.id } : null };
}

export function parseProviderAccountUsageHistoryEntry(entry: Readonly<{ id: string; observedAt: Date; payload: unknown }>) {
    return { id: entry.id, observedAtMs: entry.observedAt.getTime(), record: parseHistoryRecord(entry.payload) };
}

function parseHistoryRecord(payload: unknown): StoredProviderAccountUsageRecord {
    // Retained pages and exact witnesses share the persistence-only projection.
    // Strict write validation still owns all recognized identities and invariants.
    const retained = createStoredReadSchema(UpsertProviderAccountUsageRecordSchema).safeParse(payload);
    if (!retained.success) throw new ProviderAccountUsagePayloadInvariantError(retained.error.message);
    const parsed = parseProviderAccountUsageRecordWrite(retained.data);
    return { ...parsed, fetchedAt: parsed.fetchedAt ?? null, staleAfterMs: parsed.staleAfterMs ?? null };
}

export async function hasProviderAccountUsageHistory(params: Readonly<{ accountId: string; recordId: string }>, client: ProviderAccountUsageRecordClient): Promise<boolean> {
    const row = await client.providerAccountUsageRecord.findUnique({
        where: { accountId_recordId: params },
        select: { history: { orderBy: [{ observedAt: 'asc' }, { id: 'asc' }], take: 1, select: { id: true } } },
    });
    return (row?.history.length ?? 0) > 0;
}

export async function readProviderAccountUsageHistoryWitness(params: Readonly<{ accountId: string; recordId: string; witness: import('@happier-dev/protocol/connect/providerAccountUsageHistory').ProviderAccountUsageHistoryWitnessV1 }>, client: ProviderAccountUsageRecordClient = db) {
    const entry = await readProviderAccountUsageHistoryWitnessRow(params, client);
    return entry ? parseProviderAccountUsageHistoryEntry(entry) : null;
}

export async function readProviderAccountUsageHistoryWitnessRow(params: Readonly<{ accountId: string; recordId: string; witness: import('@happier-dev/protocol/connect/providerAccountUsageHistory').ProviderAccountUsageHistoryWitnessV1 }>, client: ProviderAccountUsageRecordClient) {
    const row = await client.providerAccountUsageRecord.findUnique({
        where: { accountId_recordId: { accountId: params.accountId, recordId: params.recordId } },
        select: { history: { where: { id: params.witness.id, observedAt: new Date(params.witness.observedAtMs) }, select: { id: true, observedAt: true, payload: true } } },
    });
    return row?.history[0] ?? null;
}

/** Only the accepted-write policy invokes this inside the same transaction as its CAS. */
export async function retainProviderAccountUsageHistory(
    raw: UpsertProviderAccountUsageRecordParams,
    client: Pick<TransactionClient, "providerAccountUsageHistory" | '$executeRaw'>,
) {
    const parsed = parseProviderAccountUsageRecordWrite(raw);
    if (parsed.fetchedAt === undefined || (!parsed.snapshot && !parsed.sealedPayload)) return;
    // The read materialization belongs only to the current record. Embedding it
    // into every accepted observation would recursively duplicate its history.
    const { pageProjection: _derived, daySummaryPendingDays: _pending, ...metadata } = parsed.metadata ?? {};
    const retained = { ...parsed, ...(parsed.metadata ? { metadata } : {}) };
    // The policy already owns the accepted parent CAS in this transaction.
    // Insert through the existing composite FK without updating that parent again.
    await client.providerAccountUsageHistory.create({
        data: { accountId: parsed.accountId, recordId: parsed.recordId,
            observedAt: new Date(parsed.fetchedAt), payload: retained as Prisma.InputJsonValue },
        select: { id: true },
    });
    // Empty coverage proves no remaining detail. A newly retained observation
    // invalidates that proof at its producer, including equal-time insertions
    // whose opaque ids need not sort after the old frontier. The sealed body
    // remains available for the CLI to merge with remaining/new observations.
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const payload = name('payload');
    const coverage = JSON.stringify({ observationCount: 0, frontier: null });
    const dayStartAtMs = Math.floor(parsed.fetchedAt / PROVIDER_ACCOUNT_USAGE_DAY_MS) * PROVIDER_ACCOUNT_USAGE_DAY_MS;
    const invalidated = provider === 'sqlite' ? prismaRuntime.sql`json_set(${payload}, '$.coverage', json(${coverage}))`
        : provider === 'mysql' ? prismaRuntime.sql`JSON_SET(${payload}, '$.coverage', CAST(${coverage} AS JSON))`
        : prismaRuntime.sql`jsonb_set(${payload}, '{coverage}', ${coverage}::jsonb)`;
    await client.$executeRaw(prismaRuntime.sql`UPDATE ${name('ProviderAccountUsageDaySummary')} SET ${payload} = ${invalidated}
        WHERE ${name('accountId')} = ${parsed.accountId} AND ${name('recordId')} = ${parsed.recordId}
            AND ${name('dayStartAt')} = ${usageSqlTimestamp(dayStartAtMs)}`);
    // Both live callers are the policy: existing rows were initialized before
    // its CAS, and a newly created record has no earlier pending work.
    await appendProviderAccountUsagePendingDay({ accountId: parsed.accountId, recordId: parsed.recordId, dayStartAtMs,
        knownPendingDays: parsed.metadata?.daySummaryPendingDays ?? [] }, client);
}

/** Remove retained exact-observation cache bytes when their source detail is compacted. */
export async function clearProviderAccountUsagePageProjection(params: Readonly<{ accountId: string; recordId: string }>,
    client: Pick<TransactionClient, '$executeRaw'>): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const metadata = name('metadata');
    const updated = provider === 'sqlite' ? prismaRuntime.sql`json_remove(${metadata}, '$.pageProjection')`
        : provider === 'mysql' ? prismaRuntime.sql`JSON_REMOVE(${metadata}, '$.pageProjection')`
        : prismaRuntime.sql`${metadata} - 'pageProjection'`;
    await client.$executeRaw(prismaRuntime.sql`UPDATE ${name('ProviderAccountUsageRecord')} SET ${metadata} = ${updated}
        WHERE ${name('accountId')} = ${params.accountId} AND ${name('recordId')} = ${params.recordId} AND ${metadata} IS NOT NULL`);
}

export type ProviderAccountUsageRecordCurrentGuard = Readonly<{
    fetchedAt: number | null;
    refreshRequestedAt?: number;
    content?: Pick<Prisma.ProviderAccountUsageRecordWhereInput,
        "payloadMode" | "status" | "staleAfterMs" | "snapshot" | "sealedPayload" | "metadata">;
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
        return createStoredReadSchema(ProviderAccountUsageRecordMetadataSchema).parse(raw);
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
    parsed: Pick<ParsedProviderAccountUsageRecordWrite, "accountId" | "recordId">,
    guard: ProviderAccountUsageRecordCurrentGuard,
) {
    return {
        accountId: parsed.accountId,
        recordId: parsed.recordId,
        fetchedAt: guard.fetchedAt === null ? null : new Date(guard.fetchedAt),
        refreshRequestedAt: guard.refreshRequestedAt === undefined ? null : new Date(guard.refreshRequestedAt),
        ...guard.content,
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
    const recordKey = createStoredReadSchema(ProviderAccountUsageRecordKeyV1Schema).parse(row.recordKeyJson);
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
    const metadata = row.metadata === null || row.metadata === undefined
        ? undefined
        : zodProviderAccountUsageMetadata(row.metadata);
    const storedSnapshot = isJsonFieldAbsent(row.snapshot)
        ? undefined
        : parseBuiltInLegacyProviderAccountUsageSnapshotV1(row.snapshot);
    // 0.2 stores supplemental facts beside the strict base; native V4 fields win.
    const snapshot = storedSnapshot ? {
        ...storedSnapshot,
        ...(storedSnapshot.subscription === undefined && metadata?.subscription
            ? { subscription: metadata.subscription } : {}),
        ...(storedSnapshot.recoveryCreditDetails === undefined && metadata?.recoveryCreditDetails
            ? { recoveryCreditDetails: metadata.recoveryCreditDetails } : {}),
    } : undefined;
    const sealedPayload = isJsonFieldAbsent(row.sealedPayload)
        ? undefined
        : createStoredReadSchema(SealedProviderAccountUsageSnapshotV1Schema).parse(row.sealedPayload);
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
): Promise<void> {
    const parsed = parseProviderAccountUsageRecordWrite(raw);
    await client.providerAccountUsageRecord.create({
        data: buildProviderAccountUsageRecordCreateData(parsed),
    });
}

/** An insert race must not abort PostgreSQL before the policy can reread its winner. */
export async function createProviderAccountUsageRecordIfAbsent(
    raw: UpsertProviderAccountUsageRecordParams,
    client: ProviderAccountUsageRecordClient,
): Promise<boolean> {
    if (getDbProviderFromEnv(process.env, "postgres") === "sqlite") {
        // SQLite serializes these writers; preserve its existing unique-error recovery.
        await createProviderAccountUsageRecord(raw, client);
        return true;
    }
    const parsed = parseProviderAccountUsageRecordWrite(raw);
    const created = await client.providerAccountUsageRecord.createMany({
        data: buildProviderAccountUsageRecordCreateData(parsed),
        skipDuplicates: true,
    });
    return created.count === 1;
}

export async function updateProviderAccountUsageRecordIfCurrent(
    raw: UpsertProviderAccountUsageRecordParams,
    guard: ProviderAccountUsageRecordCurrentGuard,
    client: ProviderAccountUsageRecordClient = db,
): Promise<boolean> {
    const parsed = parseProviderAccountUsageRecordWrite(raw);
    const updated = await client.providerAccountUsageRecord.updateMany({
        where: buildProviderAccountUsageRecordCurrentWhere(parsed, guard),
        data: buildProviderAccountUsageRecordUpdateData(parsed),
    });
    // The write policy consumes only this acknowledgement. Its qualified
    // caller reads the final record after history/source settlement; reading
    // and decoding it here extends the credential lock for a discarded value.
    return updated.count > 0;
}

/** Derived metadata shares the observation owner's complete persisted-parent CAS. */
export async function updateProviderAccountUsageRecordMetadataIfCurrent(
    params: Readonly<{ accountId: string; recordId: string; metadata: Prisma.InputJsonValue }>,
    guard: ProviderAccountUsageRecordCurrentGuard,
    client: ProviderAccountUsageRecordClient,
): Promise<boolean> {
    const updated = await client.providerAccountUsageRecord.updateMany({
        where: buildProviderAccountUsageRecordCurrentWhere(params, guard),
        data: { metadata: params.metadata },
    });
    return updated.count === 1;
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
    return (await readProviderAccountUsageRecordWithCurrentGuard(params, client))?.record ?? null;
}

/** Keep raw persisted JSON in the CAS: legacy projections and unknown retained fields need not reserialize identically. */
export async function readProviderAccountUsageRecordWithCurrentGuard(params: Readonly<{
    accountId: string;
    recordId: string;
}>, client: ProviderAccountUsageRecordClient): Promise<Readonly<{
    record: StoredProviderAccountUsageRecord;
    guard: ProviderAccountUsageRecordCurrentGuard;
    rawMetadata: Prisma.JsonValue;
}> | null> {
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
    if (!row) return null;
    return {
        record: parseStoredProviderAccountUsageRecord(row),
        // The Prisma JSON-types generator types this untagged column `unknown`; the driver only returns parsed JSON.
        rawMetadata: row.metadata as Prisma.JsonValue,
        guard: {
            fetchedAt: row.fetchedAt?.getTime() ?? null,
            ...(row.refreshRequestedAt ? { refreshRequestedAt: row.refreshRequestedAt.getTime() } : {}),
            content: {
                payloadMode: row.payloadMode,
                status: row.status,
                staleAfterMs: row.staleAfterMs,
                snapshot: { equals: row.snapshot ?? prismaRuntime.AnyNull },
                sealedPayload: { equals: row.sealedPayload ?? prismaRuntime.AnyNull },
                metadata: { equals: row.metadata ?? prismaRuntime.AnyNull },
            },
        } satisfies ProviderAccountUsageRecordCurrentGuard,
    };
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
