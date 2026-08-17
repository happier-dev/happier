import type { Prisma } from "@prisma/client";

import {
    createDbMaintenanceClient,
    type DbProvider,
    type PrismaClientType,
} from "@/storage/db";

import {
    auditSessionSystemRecordAddressesPage,
    backfillSessionSystemRecordAddressesPage,
} from "./backfillSessionSystemRecordAddresses";
import {
    parseSessionSystemRecordBackfillOperatorArgs,
    runSessionSystemRecordBackfillOperator,
    type SessionSystemRecordAddressAuditPageResult,
    type SessionSystemRecordBackfillOperatorResult,
    type SessionSystemRecordBackfillPageResult,
} from "./sessionSystemRecordBackfillOperator";
import { SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION } from "./sessionSystemRecordMigrationDeployment";

type SessionSystemRecordMaintenanceProvider = DbProvider;
type SessionSystemRecordMaintenanceClient = Pick<
    PrismaClientType,
    "$connect" | "$disconnect" | "$transaction" | "$queryRawUnsafe"
>;

export type SessionSystemRecordBackfillExecutionDependencies = Readonly<{
    createClient?: (
        provider: SessionSystemRecordMaintenanceProvider,
        databaseUrl?: string,
    ) => Promise<SessionSystemRecordMaintenanceClient>;
    runOperator?: (params: Readonly<{
        pageSize: number;
        timeBudgetMs: number;
        signal: AbortSignal;
        runPage: (params: Readonly<{
            afterId: string | undefined;
            limit: number;
        }>) => Promise<SessionSystemRecordBackfillPageResult>;
        runAuditPage: (params: Readonly<{
            afterId: string | undefined;
            limit: number;
        }>) => Promise<SessionSystemRecordAddressAuditPageResult>;
    }>) => Promise<SessionSystemRecordBackfillOperatorResult>;
}>;

async function runCanonicalBackfillPage(params: Readonly<{
    client: SessionSystemRecordMaintenanceClient;
    provider: SessionSystemRecordMaintenanceProvider;
    afterId: string | undefined;
    limit: number;
}>): Promise<SessionSystemRecordBackfillPageResult> {
    return await params.client.$transaction(async (tx) => await backfillSessionSystemRecordAddressesPage({
        db: tx as Prisma.TransactionClient,
        provider: params.provider,
        ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
        limit: params.limit,
    }));
}

async function runCanonicalAuditPage(params: Readonly<{
    client: SessionSystemRecordMaintenanceClient;
    afterId: string | undefined;
    limit: number;
}>): Promise<SessionSystemRecordAddressAuditPageResult> {
    return await params.client.$transaction(async (tx) => await auditSessionSystemRecordAddressesPage({
        db: tx as Prisma.TransactionClient,
        ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
        limit: params.limit,
    }));
}

export async function runSessionSystemRecordBackfillExecution(params: Readonly<{
    provider: DbProvider;
    databaseUrl?: string;
    pageSize: number;
    timeBudgetMs: number;
    signal: AbortSignal;
}> & SessionSystemRecordBackfillExecutionDependencies): Promise<SessionSystemRecordBackfillOperatorResult> {
    const provider = params.provider;
    const client = await (params.createClient ?? createDbMaintenanceClient)(provider, params.databaseUrl);
    let failed = false;
    try {
        await client.$connect();
        const runPage = async (input: Readonly<{
            afterId: string | undefined;
            limit: number;
        }>) => await runCanonicalBackfillPage({ client, provider, ...input });
        const runAuditPage = async (input: Readonly<{
            afterId: string | undefined;
            limit: number;
        }>) => await runCanonicalAuditPage({ client, ...input });
        return await (params.runOperator ?? runSessionSystemRecordBackfillOperator)({
            pageSize: params.pageSize,
            timeBudgetMs: params.timeBudgetMs,
            signal: params.signal,
            runPage,
            runAuditPage,
        });
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        try {
            await client.$disconnect();
        } catch (error) {
            if (!failed) throw error;
        }
    }
}

export async function runSessionSystemRecordFinalContractBackfill(params: Readonly<{
    provider: DbProvider;
    databaseUrl?: string;
    signal?: AbortSignal;
}>): Promise<SessionSystemRecordBackfillOperatorResult> {
    const args = parseSessionSystemRecordBackfillOperatorArgs(["--final-contract"]);
    const result = await runSessionSystemRecordBackfillExecution({
        provider: params.provider,
        ...(params.databaseUrl ? { databaseUrl: params.databaseUrl } : {}),
        pageSize: args.pageSize,
        timeBudgetMs: args.timeBudgetMs,
        signal: params.signal ?? new AbortController().signal,
    });
    if (
        result.outcome !== "drained"
        || result.audit.nullRows !== 0
        || result.audit.mismatchedRows !== 0
    ) {
        throw new Error(
            `[session-system-records] final CONTRACT backfill did not prove the address audit `
            + `(outcome=${result.outcome}, nullRows=${result.audit.nullRows}, `
            + `mismatchedRows=${result.audit.mismatchedRows})`,
        );
    }
    return result;
}

function isMissingMigrationLedger(error: unknown): boolean {
    const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
    return message.includes("no such table")
        || message.includes("does not exist")
        || message.includes("doesn't exist")
        || message.includes("unknown table");
}

export async function hasSessionSystemRecordContractMigration(params: Readonly<{
    provider: DbProvider;
    databaseUrl?: string;
}>): Promise<boolean> {
    const provider = params.provider;
    const client = await createDbMaintenanceClient(provider, params.databaseUrl);
    let failed = false;
    try {
        await client.$connect();
        const rows = await client.$queryRawUnsafe<Array<{ migration_name?: unknown }>>(
            "SELECT migration_name FROM _prisma_migrations "
            + `WHERE migration_name = '${SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION}' `
            + "AND finished_at IS NOT NULL AND rolled_back_at IS NULL",
        );
        return rows.some((row) => row.migration_name === SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION);
    } catch (error) {
        if (isMissingMigrationLedger(error)) return false;
        failed = true;
        throw error;
    } finally {
        try {
            await client.$disconnect();
        } catch (error) {
            if (!failed) throw error;
        }
    }
}
