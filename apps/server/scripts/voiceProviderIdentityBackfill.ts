import {
    runVoiceProviderIdentityBackfillOperator,
    parseVoiceProviderIdentityBackfillOperatorArgs,
    resolveVoiceProviderIdentityBackfillOperatorProvider,
} from "../sources/app/voice/providerIdentityBackfill/operator";
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

async function main(signal: AbortSignal): Promise<number> {
    const args = parseVoiceProviderIdentityBackfillOperatorArgs(process.argv.slice(2));
    const fallback = process.env.HAPPIER_SERVER_FLAVOR === "light" || process.env.HAPPY_SERVER_FLAVOR === "light"
        ? "sqlite"
        : "postgres";
    const provider = resolveVoiceProviderIdentityBackfillOperatorProvider(process.env, fallback);

    // The MySQL migration computes and finalizes identity keys in SQL. Do not even
    // initialize a host backfill client for that provider.
    if (provider === "mysql") {
        const result = await runVoiceProviderIdentityBackfillOperator({
            ...args,
            provider,
            signal,
            writeResult: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
        });
        return result.exitCode;
    }

    if (provider === "sqlite" && !String(process.env.DATABASE_URL ?? "").trim()) {
        const rawDataDir = String(
            process.env.HAPPIER_SERVER_LIGHT_DATA_DIR
            ?? process.env.HAPPY_SERVER_LIGHT_DATA_DIR
            ?? "",
        ).trim();
        if (!rawDataDir) {
            throw new Error("SQLite backfill requires DATABASE_URL or HAPPIER_SERVER_LIGHT_DATA_DIR");
        }
        process.env.DATABASE_URL = resolveLightSqliteDatabaseUrl(expandHomeDirPath(rawDataDir, process.env));
    }

    await initializeDatabase(provider);
    try {
        const result = await runVoiceProviderIdentityBackfillOperator({
            ...args,
            provider,
            signal,
            writeResult: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
        });
        return result.exitCode;
    } finally {
        await disconnectDatabase(provider);
    }
}

const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);

void main(controller.signal).then(
    (exitCode) => {
        process.exitCode = exitCode;
    },
    () => {
        process.stderr.write(`${JSON.stringify({
            exitCode: 1,
            outcome: "failed",
            reason: "operator_setup_failed",
            operatorAction: "Check the command arguments and database provider/connection configuration; keep Phase B blocked.",
        })}\n`);
        process.exitCode = 1;
    },
).finally(() => {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
});
