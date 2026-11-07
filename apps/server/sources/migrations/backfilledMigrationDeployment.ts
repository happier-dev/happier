import { chmod, cp, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export type BackfilledMigrationStage = Readonly<{
    migrationsDir: string;
    schemaPath?: string;
}>;

export type BackfilledMigrationDeployResult<T> = Readonly<{
    sequenceApplied: boolean;
    expand: T | null;
    contract: T | null;
    final: T;
}>;

type BackfilledMigrationSequence = Readonly<{
    expandMigrationNames: readonly string[];
    contractMigrationNames: readonly string[];
}>;

function resolveBackfilledMigrationSequence(
    migrationNames: readonly string[],
    migrationSequence: Readonly<{ expandMigration: string; contractMigration: string }>,
): BackfilledMigrationSequence | null {
    const ordered = [...migrationNames].sort((left, right) => left.localeCompare(right));
    const expandIndexes = ordered
        .map((name, index) => name === migrationSequence.expandMigration ? index : -1)
        .filter((index) => index >= 0);
    const contractIndexes = ordered
        .map((name, index) => name === migrationSequence.contractMigration ? index : -1)
        .filter((index) => index >= 0);

    if (expandIndexes.length === 0 && contractIndexes.length === 0) {
        return null;
    }
    if (expandIndexes.length !== 1 || contractIndexes.length !== 1) {
        throw new Error(
            "[backfilled-migrations] migration assets must contain exactly one EXPAND and one CONTRACT migration",
        );
    }

    const expandIndex = expandIndexes[0]!;
    const contractIndex = contractIndexes[0]!;
    if (expandIndex >= contractIndex) {
        throw new Error(
            "[backfilled-migrations] EXPAND migration must precede CONTRACT in the canonical migration order",
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
        throw new Error(`[backfilled-migrations] cannot read canonical migrations ${resolvedMigrationsDir}${detail}`);
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
}>): Promise<BackfilledMigrationStage> {
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

    // Source-runtime assets are immutable. Their copied directory modes must
    // not make this invocation's private scratch tree impossible to retire.
    await makeMigrationStageWritable(params.stageDir);

    if (!params.schemaPath) {
        return { migrationsDir };
    }

    const schemaPath = join(params.stageDir, basename(params.schemaPath));
    await copyFile(params.schemaPath, schemaPath);
    await chmod(schemaPath, 0o600);
    return { migrationsDir, schemaPath };
}

async function makeMigrationStageWritable(directory: string): Promise<void> {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await makeMigrationStageWritable(path);
        else if (entry.isFile()) await chmod(path, 0o600);
    }
}

/**
 * Runs canonical migration phases around an exact application-owned backfill. The temporary
 * roots copy the canonical migration bytes under their original names, so the
 * provider's normal ledger and checksum rules remain authoritative while the
 * bounded backfill gets a real boundary between EXPAND and CONTRACT.
 */
export async function runBackfilledMigrationDeployment<T>(params: Readonly<{
    migrationsDir: string;
    schemaPath?: string;
    deploy: (stage: BackfilledMigrationStage) => Promise<T>;
    isContractApplied?: () => Promise<boolean>;
    runFinalContractBackfill: () => Promise<void>;
    migrationSequence: Readonly<{ expandMigration: string; contractMigration: string }>;
}>): Promise<BackfilledMigrationDeployResult<T>> {
    const migrationsDir = resolve(params.migrationsDir);
    const schemaPath = params.schemaPath ? resolve(params.schemaPath) : undefined;
    const sequence = resolveBackfilledMigrationSequence(
        await listMigrationDirectoryNames(migrationsDir),
        params.migrationSequence,
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

    const stageRoot = await mkdtemp(join(tmpdir(), "happier-backfilled-migrations-"));
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

