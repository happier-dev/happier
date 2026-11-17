import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveServerPrismaMigrationToolLayout } from "./prismaInstallLayout.mjs";
import { resolveServerWorkspaceRoot, runPrismaCli } from "./prismaCli";
import { withPackagedMigrationDatasourceUrl } from "./runtime/prepareFullRuntimeMigrationSchema.mjs";

type RunPrismaMigrateCliParams = Readonly<{
    serverRoot: string;
    /** The dialect schema whose sibling `migrations` directory is applied. */
    schemaPath: string;
    /** The `prisma migrate` subcommand and its flags, e.g. `["deploy"]`. */
    args: readonly string[];
    env?: NodeJS.ProcessEnv;
    quiet?: boolean;
}>;

const DATASOURCE_URL = /^datasource db \{[^}]*^\s*url\s*=/m;

/**
 * The only way server source tooling (dev, the Docker image's `migrate:deploy`, hstack, the DB
 * contract templates) runs `prisma migrate`. The packaged `happier-server-migrate` runs the same
 * CLI build (packages/cli-common/scripts/buildPrismaMigrateBinary.mjs).
 *
 * TRANSITION (owner decision 2026-11-17): the client runs on Prisma 7, migrations stay on the
 * Prisma 6.19.2 migrator (`prisma-migrate-cli` alias, schema engine c2990dca). Prisma 7.10.1's
 * schema engine applies a PostgreSQL migration.sql statement by statement instead of as one
 * transaction, which breaks committed migrations that rely on it (ON COMMIT DROP staging tables in
 * 20260725100000_activate_qualified_connected_accounts_v4 and the session data key envelope pair)
 * and drops whole-file atomicity on failure. Remove this transition (run the server's own `prisma`
 * CLI here and in the packaged migrator, drop the alias and the URL staging) once Prisma's migrator
 * applies a migration file transactionally again: prismaMigrateCli.postgres.dbcontract.spec.ts
 * passes against it.
 *
 * The 6.19.2 CLI reads the URL only from the schema's datasource block, which the Prisma 7 schemas
 * no longer carry, so it migrates an OS-temp copy with `url = env("DATABASE_URL")` and is pointed at
 * the real migrations directory through its config. Nothing is written into the source tree.
 */
export async function runPrismaMigrateCli(params: RunPrismaMigrateCliParams): Promise<void> {
    const schemaPath = resolve(params.serverRoot, params.schemaPath);
    const schema = await readFile(schemaPath, "utf8");
    const layout = resolveServerPrismaMigrationToolLayout({ serverRoot: params.serverRoot });
    const stage = await mkdtemp(join(tmpdir(), "happier-prisma-migrate-"));
    try {
        const stagedSchemaPath = join(stage, "schema.prisma");
        const configPath = join(stage, "prisma.config.mjs");
        // Released schemas (upgrade fixtures) still carry their own Prisma 6 URL line.
        await writeFile(stagedSchemaPath, DATASOURCE_URL.test(schema) ? schema : withPackagedMigrationDatasourceUrl(schema));
        const config = { schema: stagedSchemaPath, migrations: { path: join(dirname(schemaPath), "migrations") } };
        await writeFile(configPath, `export default ${JSON.stringify(config)};\n`);
        await runPrismaCli({
            serverRoot: params.serverRoot,
            entryPath: layout.cliEntrypoint,
            args: ["migrate", ...params.args, "--config", configPath],
            env: params.env,
            quiet: params.quiet,
        });
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
}

/** `prisma migrate <args>` for package scripts: `--schema <path>` selects the dialect (default PostgreSQL). */
async function main(argv: readonly string[]): Promise<void> {
    const schemaFlag = argv.indexOf("--schema");
    const schemaPath = schemaFlag >= 0 ? argv[schemaFlag + 1] : "prisma/schema.prisma";
    if (!schemaPath) throw new Error("[prisma-migrate] --schema needs a path");
    const args = schemaFlag >= 0 ? [...argv.slice(0, schemaFlag), ...argv.slice(schemaFlag + 2)] : [...argv];
    await runPrismaMigrateCli({ serverRoot: resolveServerWorkspaceRoot(import.meta.url), schemaPath, args });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
