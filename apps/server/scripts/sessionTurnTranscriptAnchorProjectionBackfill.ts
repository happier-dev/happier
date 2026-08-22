import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
    parseSessionTurnTranscriptAnchorProjectionBackfillOperatorArgs,
    resolveSessionTurnTranscriptAnchorProjectionBackfillOperatorProvider,
    runSessionTurnTranscriptAnchorProjectionBackfillOperator,
    type SessionTurnTranscriptAnchorProjectionBackfillOperatorResult,
} from "../sources/app/session/turns/sessionTurnTranscriptAnchorProjectionBackfillOperator";
import {
    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION,
    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_KEY,
    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE,
} from "../sources/app/session/turns/sessionTurnTranscriptAnchorProjectionProtocolContract";
import {
    db,
    initDbMysql,
    initDbPglite,
    initDbPostgres,
    initDbSqlite,
    shutdownDbPglite,
    type DbProvider,
} from "../sources/storage/db";
import { resolveLightSqliteDatabaseUrl } from "../sources/flavors/light/env";
import { expandHomeDirPath } from "@happier-dev/cli-common/path";

const SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_APPROVAL_ENV =
    "HAPPIER_SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_APPROVAL";

export function formatSessionTurnTranscriptAnchorProjectionBackfillFailure(error: unknown): Readonly<{
    outcome: "failed";
    reason: "operator_setup_or_runtime_failed";
    operatorAction: string;
    detail?: string;
}> {
    const detail = error instanceof Error
        && error.message.startsWith("[session-turn-anchor-projection]")
        ? error.message
        : null;
    return {
        outcome: "failed",
        reason: "operator_setup_or_runtime_failed",
        operatorAction: "Check arguments and database connection, then rerun; keep external transcript projection inactive.",
        ...(detail ? { detail } : {}),
    };
}

function assertFinalContractOperatorAdmission(env: NodeJS.ProcessEnv): void {
    if (
        String(env[SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_APPROVAL_ENV] ?? "").trim()
        === SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION
    ) {
        return;
    }
    throw new Error(
        "[session-turn-anchor-projection] Final CONTRACT preflight requires the deployment operator to exclude "
        + "every predecessor writer and rollback target first. Stop or quiesce those writers, then set "
        + `${SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_APPROVAL_ENV}=`
        + `${SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION} for this exact invocation. `
        + "This admission does not detect or drain writers.",
    );
}

async function initializeDatabase(provider: DbProvider): Promise<void> {
    if (provider === "postgres") {
        initDbPostgres();
    } else if (provider === "pglite") {
        await initDbPglite();
    } else if (provider === "sqlite") {
        await initDbSqlite();
    } else {
        await initDbMysql();
    }
    await db.$connect();
}

async function disconnectDatabase(provider: DbProvider): Promise<void> {
    if (provider === "pglite") {
        await shutdownDbPglite();
        return;
    }
    await db.$disconnect();
}

async function persistFinalContractMarker(): Promise<void> {
    await db.simpleCache.upsert({
        where: { key: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_KEY },
        create: {
            key: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_KEY,
            value: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE,
        },
        update: { value: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE },
    });
}

export async function runSessionTurnTranscriptAnchorProjectionBackfillCommand(params: Readonly<{
    signal: AbortSignal;
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    initialize?: (provider: DbProvider) => Promise<void>;
    disconnect?: (provider: DbProvider) => Promise<void>;
    runOperator?: (params: Readonly<{
        pageSize: number;
        timeBudgetMs: number;
        signal: AbortSignal;
    }>) => Promise<SessionTurnTranscriptAnchorProjectionBackfillOperatorResult>;
    writeOutput?: (output: string) => void;
}>): Promise<number> {
    const env = params.env ?? process.env;
    const args = parseSessionTurnTranscriptAnchorProjectionBackfillOperatorArgs(
        params.argv ?? process.argv.slice(2),
    );
    if (args.mode === "final-contract") {
        assertFinalContractOperatorAdmission(env);
    }
    const fallback = env.HAPPIER_SERVER_FLAVOR === "light" || env.HAPPY_SERVER_FLAVOR === "light"
        ? "sqlite"
        : "postgres";
    const provider = resolveSessionTurnTranscriptAnchorProjectionBackfillOperatorProvider(env, fallback);

    if (provider === "sqlite" && !String(env.DATABASE_URL ?? "").trim()) {
        const rawDataDir = String(
            env.HAPPIER_SERVER_LIGHT_DATA_DIR
            ?? env.HAPPY_SERVER_LIGHT_DATA_DIR
            ?? "",
        ).trim();
        if (!rawDataDir) {
            throw new Error("SQLite backfill requires DATABASE_URL or HAPPIER_SERVER_LIGHT_DATA_DIR");
        }
        env.DATABASE_URL = resolveLightSqliteDatabaseUrl(expandHomeDirPath(rawDataDir, env));
    }

    let failed = false;
    try {
        await (params.initialize ?? initializeDatabase)(provider);
        const result = await (params.runOperator ?? runSessionTurnTranscriptAnchorProjectionBackfillOperator)({
            pageSize: args.pageSize,
            timeBudgetMs: args.timeBudgetMs,
            signal: params.signal,
        });
        const writeOutput = params.writeOutput ?? ((output) => process.stdout.write(output));
        if (result.outcome === "aborted") {
            writeOutput(`${JSON.stringify({ provider, mode: args.mode, ...result })}\n`);
            return 130;
        }
        if (
            args.mode === "final-contract"
            && (
                result.outcome !== "drained"
                || result.audit.legacyRows !== 0
                || result.audit.mismatchedRows !== 0
            )
        ) {
            writeOutput(`${JSON.stringify({ provider, mode: args.mode, ...result })}\n`);
            return 1;
        }
        if (args.mode === "final-contract") {
            if (params.signal.aborted) {
                writeOutput(`${JSON.stringify({
                    provider,
                    mode: args.mode,
                    ...result,
                    outcome: "aborted",
                })}\n`);
                return 130;
            }
            await persistFinalContractMarker();
        }
        writeOutput(`${JSON.stringify({ provider, mode: args.mode, ...result })}\n`);
        return result.outcome === "drained" ? 0 : 1;
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        try {
            await (params.disconnect ?? disconnectDatabase)(provider);
        } catch (error) {
            if (!failed) throw error;
        }
    }
}

const invokedAsMain = process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsMain) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);

    void runSessionTurnTranscriptAnchorProjectionBackfillCommand({ signal: controller.signal }).then(
        (exitCode) => {
            process.exitCode = exitCode;
        },
        (error) => {
            process.stderr.write(`${JSON.stringify(
                formatSessionTurnTranscriptAnchorProjectionBackfillFailure(error),
            )}\n`);
            process.exitCode = 1;
        },
    ).finally(() => {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
    });
}
