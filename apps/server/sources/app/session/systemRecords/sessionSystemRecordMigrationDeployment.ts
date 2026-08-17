import { cp, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export const SESSION_SYSTEM_RECORD_EXPAND_MIGRATION =
    "20260731170000_expand_session_system_record_addresses";
export const SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION =
    "20260810120000_contract_session_system_record_addresses";

export type SessionSystemRecordMigrationStage = Readonly<{
    migrationsDir: string;
    schemaPath?: string;
}>;

export type SessionSystemRecordMigrationDeployResult<T> = Readonly<{
    sequenceApplied: boolean;
    expand: T | null;
    contract: T | null;
    final: T;
}>;

type SessionSystemRecordMigrationSequence = Readonly<{
    expandMigrationNames: readonly string[];
    contractMigrationNames: readonly string[];
}>;

function resolveSessionSystemRecordMigrationSequence(
    migrationNames: readonly string[],
): SessionSystemRecordMigrationSequence | null {
    const ordered = [...migrationNames].sort((left, right) => left.localeCompare(right));
    const expandIndexes = ordered
        .map((name, index) => name === SESSION_SYSTEM_RECORD_EXPAND_MIGRATION ? index : -1)
        .filter((index) => index >= 0);
    const contractIndexes = ordered
        .map((name, index) => name === SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION ? index : -1)
        .filter((index) => index >= 0);

    if (expandIndexes.length === 0 && contractIndexes.length === 0) {
        return null;
    }
    if (expandIndexes.length !== 1 || contractIndexes.length !== 1) {
        throw new Error(
            "[session-system-records] migration assets must contain exactly one EXPAND and one CONTRACT migration",
        );
    }

    const expandIndex = expandIndexes[0]!;
    const contractIndex = contractIndexes[0]!;
    if (expandIndex >= contractIndex) {
        throw new Error(
            "[session-system-records] EXPAND migration must precede CONTRACT in the canonical migration order",
        );
    }

    return {
        expandMigrationNames: ordered.slice(0, expandIndex + 1),
        contractMigrationNames: ordered.slice(0, contractIndex + 1),
    };
}

async function listMigrationDirectoryNames(migrationsDir: string): Promise<string[]> {
    const resolvedMigrationsDir = resolve(migrationsDir);
    const entries = await readdir(resolvedMigrationsDir, { withFileTypes: true }).catch((error: unknown) => {
        const detail = error instanceof Error ? `: ${error.message}` : "";
        throw new Error(`[session-system-records] cannot read canonical migrations ${resolvedMigrationsDir}${detail}`);
    });
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
}

async function stageMigrationSubset(params: Readonly<{
    sourceMigrationsDir: string;
    stageDir: string;
    migrationNames: readonly string[];
    schemaPath?: string;
}>): Promise<SessionSystemRecordMigrationStage> {
    const migrationsDir = join(params.stageDir, "migrations");
    await mkdir(migrationsDir, { recursive: true });
    await copyFile(
        join(params.sourceMigrationsDir, "migration_lock.toml"),
        join(migrationsDir, "migration_lock.toml"),
    );
    for (const migrationName of params.migrationNames) {
        await cp(
            join(params.sourceMigrationsDir, migrationName),
            join(migrationsDir, migrationName),
            { recursive: true, force: false },
        );
    }

    if (!params.schemaPath) {
        return { migrationsDir };
    }

    const schemaPath = join(params.stageDir, basename(params.schemaPath));
    await copyFile(params.schemaPath, schemaPath);
    return { migrationsDir, schemaPath };
}

/**
 * Runs the only permitted System Records migration lifecycle. The temporary
 * roots copy the canonical migration bytes under their original names, so the
 * provider's normal ledger and checksum rules remain authoritative while the
 * bounded backfill gets a real boundary between EXPAND and CONTRACT.
 */
export async function runSessionSystemRecordMigrationDeployment<T>(params: Readonly<{
    migrationsDir: string;
    schemaPath?: string;
    deploy: (stage: SessionSystemRecordMigrationStage) => Promise<T>;
    isContractApplied?: () => Promise<boolean>;
    runFinalContractBackfill: () => Promise<void>;
}>): Promise<SessionSystemRecordMigrationDeployResult<T>> {
    const migrationsDir = resolve(params.migrationsDir);
    const schemaPath = params.schemaPath ? resolve(params.schemaPath) : undefined;
    const sequence = resolveSessionSystemRecordMigrationSequence(
        await listMigrationDirectoryNames(migrationsDir),
    );
    if (!sequence) {
        return {
            sequenceApplied: false,
            expand: null,
            contract: null,
            final: await params.deploy({ migrationsDir, ...(schemaPath ? { schemaPath } : {}) }),
        };
    }

    // A finished CONTRACT ledger row means this database already crossed the
    // only between-phases boundary. Re-entering a subset root would make a
    // steady-state deployment depend on a historical partial migration tree;
    // delegate directly to the canonical full deploy instead.
    if (params.isContractApplied && await params.isContractApplied()) {
        return {
            sequenceApplied: false,
            expand: null,
            contract: null,
            final: await params.deploy({ migrationsDir, ...(schemaPath ? { schemaPath } : {}) }),
        };
    }

    const stageRoot = await mkdtemp(join(tmpdir(), "happier-session-system-record-migrations-"));
    try {
        const expandStage = await stageMigrationSubset({
            sourceMigrationsDir: migrationsDir,
            stageDir: join(stageRoot, "expand"),
            migrationNames: sequence.expandMigrationNames,
            ...(schemaPath ? { schemaPath } : {}),
        });
        const expand = await params.deploy(expandStage);
        await params.runFinalContractBackfill();
        const contractStage = await stageMigrationSubset({
            sourceMigrationsDir: migrationsDir,
            stageDir: join(stageRoot, "contract"),
            migrationNames: sequence.contractMigrationNames,
            ...(schemaPath ? { schemaPath } : {}),
        });
        const contract = await params.deploy(contractStage);
        const final = await params.deploy({ migrationsDir, ...(schemaPath ? { schemaPath } : {}) });
        return { sequenceApplied: true, expand, contract, final };
    } finally {
        await rm(stageRoot, { recursive: true, force: true });
    }
}
