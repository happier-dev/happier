import type { DbProvider } from "@/storage/db";
import { inTx } from "@/storage/inTx";

import {
    auditSessionTurnTranscriptAnchorProjectionPage,
    backfillSessionTurnTranscriptAnchorProjectionPage,
    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_BACKFILL_PAGE_MAX,
} from "./sessionTurnTranscriptAnchorProjectionBackfill";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIME_BUDGET_MS = 5 * 60_000;
const MAX_TIME_BUDGET_MS = 15 * 60_000;

export interface SessionTurnTranscriptAnchorProjectionBackfillOperatorArgs {
    readonly pageSize: number;
    readonly timeBudgetMs: number;
    readonly mode: "coexistence" | "final-contract";
}

export type SessionTurnTranscriptAnchorProjectionBackfillPageResult = Readonly<{
    processed: number;
    updated: number;
    nextAfterId: string | null;
}>;

export type SessionTurnTranscriptAnchorProjectionAuditPageResult = Readonly<{
    processed: number;
    legacyRows: number;
    mismatchedRows: number;
    nextAfterId: string | null;
}>;

export type SessionTurnTranscriptAnchorProjectionAuditResult = Readonly<{
    pages: number;
    processed: number;
    legacyRows: number;
    mismatchedRows: number;
}>;

export type SessionTurnTranscriptAnchorProjectionBackfillOperatorResult = Readonly<{
    outcome: "drained" | "time_budget" | "aborted" | "verification_failed";
    pages: number;
    processed: number;
    updated: number;
    audit: SessionTurnTranscriptAnchorProjectionAuditResult;
}>;

const EMPTY_AUDIT_RESULT: SessionTurnTranscriptAnchorProjectionAuditResult = {
    pages: 0,
    processed: 0,
    legacyRows: 0,
    mismatchedRows: 0,
};

export function resolveSessionTurnTranscriptAnchorProjectionBackfillOperatorProvider(
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

export function parseSessionTurnTranscriptAnchorProjectionBackfillOperatorArgs(
    argv: readonly string[],
): SessionTurnTranscriptAnchorProjectionBackfillOperatorArgs {
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
            throw new Error(`Unknown SessionTurn transcript-anchor projection backfill argument: ${flag}`);
        }
        const name = flag.slice(2, separator);
        const raw = flag.slice(separator + 1);
        if (name === "page-size") {
            result.pageSize = readBoundedFlag({
                raw,
                name,
                min: 1,
                max: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_BACKFILL_PAGE_MAX,
            });
        } else if (name === "time-budget-ms") {
            result.timeBudgetMs = readBoundedFlag({
                raw,
                name,
                min: 1,
                max: MAX_TIME_BUDGET_MS,
            });
        } else {
            throw new Error(`Unknown SessionTurn transcript-anchor projection backfill argument: --${name}`);
        }
    }
    return result;
}

async function runCanonicalPage(params: Readonly<{
    afterId: string | undefined;
    limit: number;
}>): Promise<SessionTurnTranscriptAnchorProjectionBackfillPageResult> {
    return await inTx(async (tx) => await backfillSessionTurnTranscriptAnchorProjectionPage({
        db: tx,
        ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
        limit: params.limit,
    }));
}

async function runCanonicalAuditPage(params: Readonly<{
    afterId: string | undefined;
    limit: number;
}>): Promise<SessionTurnTranscriptAnchorProjectionAuditPageResult> {
    return await inTx(async (tx) => await auditSessionTurnTranscriptAnchorProjectionPage({
        db: tx,
        ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
        limit: params.limit,
    }));
}

/**
 * Two complete scans make this operator resumable without an extra progress
 * store. The second begins at the head so a coexistence writer cannot hide a
 * v0 row behind the first pass cursor; the final audit remains the proof for
 * final-contract mode after predecessor writers are actually excluded.
 */
export async function runSessionTurnTranscriptAnchorProjectionBackfillOperator(params: Readonly<{
    pageSize: number;
    timeBudgetMs: number;
    signal?: AbortSignal;
    nowMs?: () => number;
    runPage?: (params: Readonly<{
        afterId: string | undefined;
        limit: number;
    }>) => Promise<SessionTurnTranscriptAnchorProjectionBackfillPageResult>;
    runAuditPage?: (params: Readonly<{
        afterId: string | undefined;
        limit: number;
    }>) => Promise<SessionTurnTranscriptAnchorProjectionAuditPageResult>;
}>): Promise<SessionTurnTranscriptAnchorProjectionBackfillOperatorResult> {
    const nowMs = params.nowMs ?? Date.now;
    const startedAt = nowMs();
    const runPage = params.runPage ?? runCanonicalPage;
    const runAuditPage = params.runAuditPage ?? runCanonicalAuditPage;
    let afterId: string | undefined;
    let completedPasses = 0;
    let pages = 0;
    let processed = 0;
    let updated = 0;

    while (completedPasses < 2) {
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

        if (page.nextAfterId !== null) {
            afterId = page.nextAfterId;
            continue;
        }
        completedPasses += 1;
        afterId = undefined;
    }

    let auditAfterId: string | undefined;
    let auditPages = 0;
    let audited = 0;
    let legacyRows = 0;
    let mismatchedRows = 0;
    while (true) {
        const audit = { pages: auditPages, processed: audited, legacyRows, mismatchedRows };
        if (params.signal?.aborted) {
            return { outcome: "aborted", pages, processed, updated, audit };
        }
        if (nowMs() - startedAt >= params.timeBudgetMs) {
            return { outcome: "time_budget", pages, processed, updated, audit };
        }

        const page = await runAuditPage({ afterId: auditAfterId, limit: params.pageSize });
        if (params.signal?.aborted) {
            return { outcome: "aborted", pages, processed, updated, audit };
        }
        auditPages += 1;
        audited += page.processed;
        legacyRows += page.legacyRows;
        mismatchedRows += page.mismatchedRows;
        const result = { pages: auditPages, processed: audited, legacyRows, mismatchedRows };
        if (legacyRows > 0 || mismatchedRows > 0) {
            return { outcome: "verification_failed", pages, processed, updated, audit: result };
        }
        if (page.nextAfterId === null) {
            return { outcome: "drained", pages, processed, updated, audit: result };
        }
        auditAfterId = page.nextAfterId;
    }
}
