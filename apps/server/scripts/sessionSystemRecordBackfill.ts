import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
    parseSessionSystemRecordBackfillOperatorArgs,
    resolveSessionSystemRecordBackfillOperatorProvider,
    type SessionSystemRecordBackfillOperatorResult,
} from "../sources/app/session/systemRecords/sessionSystemRecordBackfillOperator";
import {
    runSessionSystemRecordBackfillExecution,
    type SessionSystemRecordBackfillExecutionDependencies,
} from "../sources/app/session/systemRecords/sessionSystemRecordBackfillExecution";
import { type DbProvider } from "../sources/storage/db";
import { resolveLightSqliteDatabaseUrl } from "../sources/flavors/light/env";
import { expandHomeDirPath } from "@happier-dev/cli-common/path";

export function formatSessionSystemRecordBackfillFailure(error: unknown): Readonly<{
    outcome: "failed";
    reason: "operator_setup_or_runtime_failed";
    operatorAction: string;
    detail?: string;
}> {
    const detail = error instanceof Error
        && error.message.startsWith("[session-system-records]")
        ? error.message
        : null;
    return {
        outcome: "failed",
        reason: "operator_setup_or_runtime_failed",
        operatorAction: "Check the arguments and database connection, then rerun; keep Session System Records protocol activation blocked.",
        ...(detail ? { detail } : {}),
    };
}

export async function runSessionSystemRecordBackfillCommand(params: Readonly<{
    signal: AbortSignal;
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    createClient?: SessionSystemRecordBackfillExecutionDependencies["createClient"];
    runOperator?: (params: Readonly<{
        pageSize: number;
        timeBudgetMs: number;
        signal: AbortSignal;
    }>) => Promise<SessionSystemRecordBackfillOperatorResult>;
    writeOutput?: (output: string) => void;
}>): Promise<number> {
    const env = params.env ?? process.env;
    const args = parseSessionSystemRecordBackfillOperatorArgs(params.argv ?? process.argv.slice(2));
    const fallback = env.HAPPIER_SERVER_FLAVOR === "light"
        || env.HAPPY_SERVER_FLAVOR === "light"
        ? "sqlite"
        : "postgres";
    const provider = resolveSessionSystemRecordBackfillOperatorProvider(env, fallback);

    if (provider === "sqlite" && !String(env.DATABASE_URL ?? "").trim()) {
        const rawDataDir = String(
            env.HAPPIER_SERVER_LIGHT_DATA_DIR
            ?? env.HAPPY_SERVER_LIGHT_DATA_DIR
            ?? "",
        ).trim();
        if (!rawDataDir) {
            throw new Error("SQLite backfill requires DATABASE_URL or HAPPIER_SERVER_LIGHT_DATA_DIR");
        }
        env.DATABASE_URL = resolveLightSqliteDatabaseUrl(
            expandHomeDirPath(rawDataDir, env),
        );
    }

    const result = await runSessionSystemRecordBackfillExecution({
        provider,
        ...(env.DATABASE_URL?.trim() ? { databaseUrl: env.DATABASE_URL } : {}),
        pageSize: args.pageSize,
        timeBudgetMs: args.timeBudgetMs,
        signal: params.signal,
        ...(params.createClient ? { createClient: params.createClient } : {}),
        ...(params.runOperator ? {
            runOperator: async ({ pageSize, timeBudgetMs, signal }) => await params.runOperator!({
                pageSize,
                timeBudgetMs,
                signal,
            }),
        } : {}),
    });
    (params.writeOutput ?? ((output) => process.stdout.write(output)))(
        `${JSON.stringify({ provider, mode: args.mode, ...result })}\n`,
    );
    if (result.outcome === "aborted") return 130;
    if (
        args.mode === "final-contract"
        && (
            result.outcome !== "drained"
            || result.audit.nullRows !== 0
            || result.audit.mismatchedRows !== 0
        )
    ) {
        return 1;
    }
    return result.outcome === "drained" ? 0 : 1;
}

const invokedAsMain = process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsMain) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);

    void runSessionSystemRecordBackfillCommand({ signal: controller.signal }).then(
        (exitCode) => {
            process.exitCode = exitCode;
        },
        (error) => {
            process.stderr.write(`${JSON.stringify(
                formatSessionSystemRecordBackfillFailure(error),
            )}\n`);
            process.exitCode = 1;
        },
    ).finally(() => {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
    });
}
