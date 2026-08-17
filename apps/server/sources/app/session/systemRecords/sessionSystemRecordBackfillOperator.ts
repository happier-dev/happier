import type { DbProvider } from "@/storage/db";
import { inTx } from "@/storage/inTx";

import {
    auditSessionSystemRecordAddressesPage,
    backfillSessionSystemRecordAddressesPage,
    SESSION_SYSTEM_RECORD_BACKFILL_PAGE_MAX,
} from "./backfillSessionSystemRecordAddresses";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIME_BUDGET_MS = 5 * 60_000;
const MAX_TIME_BUDGET_MS = 15 * 60_000;

export interface SessionSystemRecordBackfillOperatorArgs {
    readonly pageSize: number;
    readonly timeBudgetMs: number;
    readonly mode: "coexistence" | "final-contract";
}

export type SessionSystemRecordBackfillPageResult = Readonly<{
    processed: number;
    updated: number;
    nextAfterId: string | null;
}>;

export type SessionSystemRecordAddressAuditPageResult = Readonly<{
    processed: number;
    nullRows: number;
    mismatchedRows: number;
    nextAfterId: string | null;
}>;

export type SessionSystemRecordAddressAuditResult = Readonly<{
    pages: number;
    processed: number;
    nullRows: number;
    mismatchedRows: number;
}>;

export type SessionSystemRecordBackfillOperatorResult = Readonly<{
    outcome: "drained" | "time_budget" | "aborted" | "verification_failed";
    pages: number;
    processed: number;
    updated: number;
    audit: SessionSystemRecordAddressAuditResult;
}>;

const EMPTY_AUDIT_RESULT: SessionSystemRecordAddressAuditResult = {
    pages: 0,
    processed: 0,
    nullRows: 0,
    mismatchedRows: 0,
};

export function resolveSessionSystemRecordBackfillOperatorProvider(
    env: NodeJS.ProcessEnv,
    fallback: DbProvider,
): DbProvider {
    const raw = String(env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER ?? "").trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "pglite" || raw === "sqlite" || raw === "mysql") return raw;
    throw new Error(`Unsupported HAPPIER_DB_PROVIDER/HAPPY_DB_PROVIDER: ${raw}`);
}

function readBoundedFlag(params: Readonly<{
    raw: string;
    name: string;
    min: number;
    max: number;
}>): number {
    if (!/^\d+$/.test(params.raw)) {
        throw new Error(`--${params.name} must be an integer from ${params.min} to ${params.max}`);
    }
    const value = Number(params.raw);
    if (!Number.isSafeInteger(value) || value < params.min || value > params.max) {
        throw new Error(`--${params.name} must be an integer from ${params.min} to ${params.max}`);
    }
    return value;
}

export function parseSessionSystemRecordBackfillOperatorArgs(
    argv: readonly string[],
): SessionSystemRecordBackfillOperatorArgs {
    const result = {
        pageSize: DEFAULT_PAGE_SIZE,
        timeBudgetMs: DEFAULT_TIME_BUDGET_MS,
        mode: "coexistence" as "coexistence" | "final-contract",
    };
    for (const flag of argv) {
        if (flag === "--final-contract") {
            result.mode = "final-contract";
            continue;
        }
        const separator = flag.indexOf("=");
        if (!flag.startsWith("--") || separator < 3) {
            throw new Error(`Unknown Session System Record backfill argument: ${flag}`);
        }
        const name = flag.slice(2, separator);
        const raw = flag.slice(separator + 1);
        if (name === "page-size") {
            result.pageSize = readBoundedFlag({
                raw,
                name,
                min: 1,
                max: SESSION_SYSTEM_RECORD_BACKFILL_PAGE_MAX,
            });
        } else if (name === "time-budget-ms") {
            result.timeBudgetMs = readBoundedFlag({
                raw,
                name,
                min: 1,
                max: MAX_TIME_BUDGET_MS,
            });
        } else {
            throw new Error(`Unknown Session System Record backfill argument: --${name}`);
        }
    }
    return result;
}

async function runCanonicalPage(params: Readonly<{
    afterId: string | undefined;
    limit: number;
}>): Promise<SessionSystemRecordBackfillPageResult> {
    return await inTx(async (tx) => await backfillSessionSystemRecordAddressesPage({
        db: tx,
        ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
        limit: params.limit,
    }));
}

async function runCanonicalAuditPage(params: Readonly<{
    afterId: string | undefined;
    limit: number;
}>): Promise<SessionSystemRecordAddressAuditPageResult> {
    return await inTx(async (tx) => await auditSessionSystemRecordAddressesPage({
        db: tx,
        ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
        limit: params.limit,
    }));
}

export async function runSessionSystemRecordBackfillOperator(params: Readonly<{
    pageSize: number;
    timeBudgetMs: number;
    signal?: AbortSignal;
    nowMs?: () => number;
    runPage?: (params: Readonly<{
        afterId: string | undefined;
        limit: number;
    }>) => Promise<SessionSystemRecordBackfillPageResult>;
    runAuditPage?: (params: Readonly<{
        afterId: string | undefined;
        limit: number;
    }>) => Promise<SessionSystemRecordAddressAuditPageResult>;
}>): Promise<SessionSystemRecordBackfillOperatorResult> {
    const startedAt = (params.nowMs ?? Date.now)();
    const nowMs = params.nowMs ?? Date.now;
    const runPage = params.runPage ?? runCanonicalPage;
    const runAuditPage = params.runAuditPage ?? runCanonicalAuditPage;
    let afterId: string | undefined;
    let pages = 0;
    let processed = 0;
    let updated = 0;

    while (true) {
        if (params.signal?.aborted) {
            return { outcome: "aborted", pages, processed, updated, audit: EMPTY_AUDIT_RESULT };
        }
        if (pages > 0 && nowMs() - startedAt >= params.timeBudgetMs) {
            return { outcome: "time_budget", pages, processed, updated, audit: EMPTY_AUDIT_RESULT };
        }

        const page = await runPage({ afterId, limit: params.pageSize });
        pages += 1;
        processed += page.processed;
        updated += page.updated;

        if (page.processed === 0) {
            if (afterId !== undefined) {
                afterId = undefined;
                continue;
            }
            break;
        }
        // Once a tail page is consumed, restart at the beginning and require an
        // observed empty page. This catches rows an old writer inserted behind the
        // cursor during coexistence without adding persistent progress state.
        afterId = page.nextAfterId ?? undefined;
    }

    let auditAfterId: string | undefined;
    let auditPages = 0;
    let audited = 0;
    let nullRows = 0;
    let mismatchedRows = 0;
    while (true) {
        const audit = { pages: auditPages, processed: audited, nullRows, mismatchedRows };
        if (params.signal?.aborted) {
            return { outcome: "aborted", pages, processed, updated, audit };
        }
        if (nowMs() - startedAt >= params.timeBudgetMs) {
            return { outcome: "time_budget", pages, processed, updated, audit };
        }

        const page = await runAuditPage({ afterId: auditAfterId, limit: params.pageSize });
        auditPages += 1;
        audited += page.processed;
        nullRows += page.nullRows;
        mismatchedRows += page.mismatchedRows;
        const result = { pages: auditPages, processed: audited, nullRows, mismatchedRows };
        if (nullRows > 0 || mismatchedRows > 0) {
            return { outcome: "verification_failed", pages, processed, updated, audit: result };
        }
        if (page.nextAfterId === null) {
            return { outcome: "drained", pages, processed, updated, audit: result };
        }
        auditAfterId = page.nextAfterId;
    }
}
