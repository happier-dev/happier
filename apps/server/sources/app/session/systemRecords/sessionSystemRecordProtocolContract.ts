import { SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION } from "./sessionSystemRecordMigrationDeployment";

export const SESSION_SYSTEM_RECORDS_PROTOCOL_V1 = 1 as const;

export const SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION =
    SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION;

type MigrationContractDatabase = Readonly<{
    $queryRawUnsafe(query: string): Promise<unknown>;
}>;

function isFinishedContractMigrationRow(value: unknown): boolean {
    return typeof value === "object"
        && value !== null
        && "migration_name" in value
        && value.migration_name === SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION;
}

/**
 * Protocol v1 is a post-CONTRACT capability, not a feature flag. This is the
 * single process-local projection of the incumbent Session persistence
 * contract: legacy host records remain available during EXPAND/backfill, but
 * plugin records cannot be advertised or executed until the final migration
 * has been observed on the connected database. Its deployment owner performs
 * the final address backfill/audit before CONTRACT; database constraints then
 * reject predecessor row shapes. Current writers derive canonical addresses
 * and readers validate them. Startup reads the completed contract rather
 * than re-auditing every persisted record.
 */
let sessionSystemRecordsProtocolV1Active = false;

export function isSessionSystemRecordsProtocolV1Active(): boolean {
    return sessionSystemRecordsProtocolV1Active;
}

export async function initializeSessionSystemRecordsProtocolV1Activation(
    database: MigrationContractDatabase,
): Promise<boolean> {
    sessionSystemRecordsProtocolV1Active = false;
    try {
        const rows = await database.$queryRawUnsafe(
            "SELECT migration_name FROM _prisma_migrations "
            + `WHERE migration_name = '${SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION}' `
            + "AND finished_at IS NOT NULL AND rolled_back_at IS NULL",
        );
        sessionSystemRecordsProtocolV1Active = Array.isArray(rows)
            && rows.some(isFinishedContractMigrationRow);
    } catch {
        // A database that cannot prove its final migration remains fail-closed
        // for v1 while ordinary predecessor host operations stay available.
    }
    return sessionSystemRecordsProtocolV1Active;
}

export function resetSessionSystemRecordsProtocolV1ActivationForTests(): void {
    sessionSystemRecordsProtocolV1Active = false;
}
