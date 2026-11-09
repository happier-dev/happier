import {
    runBackfilledMigrationDeployment,
    type BackfilledMigrationStage,
    type BackfilledMigrationDeployResult,
} from '@/migrations/backfilledMigrationDeployment';

export type {
    BackfilledMigrationStage as SessionSystemRecordMigrationStage,
    BackfilledMigrationDeployResult as SessionSystemRecordMigrationDeployResult,
} from '@/migrations/backfilledMigrationDeployment';

export const SESSION_SYSTEM_RECORD_EXPAND_MIGRATION = '20260731170000_expand_session_system_record_addresses';
export const SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION = '20260810120000_contract_session_system_record_addresses';

export async function runSessionSystemRecordMigrationDeployment<T>(params: Readonly<{
    migrationsDir: string;
    schemaPath?: string;
    deploy: (stage: BackfilledMigrationStage) => Promise<T>;
    isContractApplied?: () => Promise<boolean>;
    runFinalContractBackfill: () => Promise<void>;
}>): Promise<BackfilledMigrationDeployResult<T>> {
    return runBackfilledMigrationDeployment({ ...params, migrationSequence: {
        expandMigration: SESSION_SYSTEM_RECORD_EXPAND_MIGRATION,
        contractMigration: SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION,
    } });
}
