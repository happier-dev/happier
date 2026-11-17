import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";

import { resolveServerWorkspaceRoot, runPrismaCli } from "./prismaCli";
import { resolveServerPrismaInstallLayout } from "./prismaInstallLayout.mjs";
import { runCommand } from "./runCommand";

export type BuildDbProvider = "postgres" | "mysql" | "sqlite";

export function isMainModule(importMetaUrl: string, argv1: string | undefined): boolean {
    if (!argv1) return false;
    try {
        return importMetaUrl === pathToFileURL(argv1).href;
    } catch {
        return false;
    }
}

function normalizeToken(token: string): string {
    return token.trim().toLowerCase();
}

function parseProvidersList(raw: string): string[] {
    return raw
        .split("|")
        .map((v) => normalizeToken(v))
        .filter(Boolean);
}

export function resolveBuildDbProvidersFromEnv(env: NodeJS.ProcessEnv): Set<BuildDbProvider> {
    const raw = (env.HAPPIER_BUILD_DB_PROVIDERS ?? env.HAPPY_BUILD_DB_PROVIDERS ?? "").toString().trim();
    if (!raw) {
        return new Set<BuildDbProvider>(["postgres", "mysql", "sqlite"]);
    }

    const tokens = parseProvidersList(raw);
    if (tokens.length === 0) {
        return new Set<BuildDbProvider>(["postgres", "mysql", "sqlite"]);
    }

    const out = new Set<BuildDbProvider>();
    for (const t of tokens) {
        if (t === "all") {
            return new Set<BuildDbProvider>(["postgres", "mysql", "sqlite"]);
        }
        if (t === "postgres" || t === "postgresql") {
            out.add("postgres");
            continue;
        }
        if (t === "pglite") {
            // pglite runtime uses the Postgres Prisma client.
            out.add("postgres");
            continue;
        }
        if (t === "mysql") {
            out.add("mysql");
            continue;
        }
        if (t === "sqlite") {
            out.add("sqlite");
            continue;
        }
        throw new Error(
            `Unsupported HAPPIER_BUILD_DB_PROVIDERS token: ${t}. Supported: postgres|pglite|mysql|sqlite|all`,
        );
    }

    // Always generate the default Prisma client (postgres schema), because server runtime imports @prisma/client
    // even when running against MySQL/SQLite generated clients.
    out.add("postgres");
    return out;
}

export function prismaGenerateDatabaseUrlForProvider(provider: BuildDbProvider): string {
    if (provider === "postgres") {
        return "postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable";
    }
    if (provider === "mysql") {
        // Any syntactically valid MySQL URL works for `prisma generate` (no network calls).
        return "mysql://root:root@127.0.0.1:3306/mysql";
    }
    // Any syntactically valid SQLite URL works for `prisma generate` (no file access required).
    return "file:./.happier-prisma-generate.sqlite";
}

type OutputStatusParams = Readonly<{
    serverRoot: string;
    providers: ReadonlySet<BuildDbProvider>;
    fileExists?: (path: string) => Promise<boolean>;
    readText?: (path: string) => Promise<string>;
    resolveInstalledPath?: ResolveInstalledPath;
}>;

function defaultFileExists(path: string): Promise<boolean> {
    return readFile(path, "utf8").then(() => true).catch(() => false);
}

function normalizePrismaSchemaText(text: string): string {
    return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Prisma 7 `prisma-client-js` output that a runtime load needs. The client runs a WASM query
 * compiler embedded as base64 beside `index.js`; there is no per-target query-engine library.
 */
const REQUIRED_GENERATED_CLIENT_FILES = Object.freeze([
    "index.js",
    "default.js",
    "package.json",
    "query_compiler_fast_bg.js",
    "query_compiler_fast_bg.wasm-base64.js",
]);

type ResolveInstalledPath = (specifier: string) => string;

const PRISMA_SOURCE_SCHEMA_STAMP = ".happier-source-schema.sha256";

function digestPrismaSourceSchema(sourceSchema: string): string {
    return createHash("sha256").update(sourceSchema).digest("hex");
}

async function writePrismaSourceSchemaStamp(params: Readonly<{
    sourcePath: string;
    generatedClientDir: string;
}>): Promise<void> {
    const sourceSchema = await readFile(params.sourcePath, "utf8");
    await writeFile(
        join(params.generatedClientDir, PRISMA_SOURCE_SCHEMA_STAMP),
        `${digestPrismaSourceSchema(sourceSchema)}\n`,
        "utf8",
    );
}

export async function areRequestedPrismaOutputsCurrent(params: OutputStatusParams): Promise<boolean> {
    const serverRoot = params.serverRoot;
    const fileExists = params.fileExists ?? defaultFileExists;
    const readText = params.readText ?? ((path: string) => readFile(path, "utf8"));
    const prismaLayout = resolveServerPrismaInstallLayout({
        serverRoot,
        resolveInstalledPath: params.resolveInstalledPath,
    });

    const checks: Array<Readonly<{ sourcePath: string; generatedClientDir: string; copiesRuntime?: boolean }>> = [
        {
            sourcePath: join(serverRoot, "prisma", "schema.prisma"),
            generatedClientDir: prismaLayout.defaultClientDir,
        },
    ];
    if (params.providers.has("sqlite")) {
        checks.push({
            sourcePath: join(serverRoot, "prisma", "sqlite", "schema.prisma"),
            generatedClientDir: join(serverRoot, "generated", "sqlite-client"),
            copiesRuntime: true,
        });
    }
    if (params.providers.has("mysql")) {
        checks.push({
            sourcePath: join(serverRoot, "prisma", "mysql", "schema.prisma"),
            generatedClientDir: join(serverRoot, "generated", "mysql-client"),
            copiesRuntime: true,
        });
    }

    for (const check of checks) {
        const generatedSchemaPath = join(check.generatedClientDir, "schema.prisma");
        if (!(await fileExists(check.sourcePath)) || !(await fileExists(generatedSchemaPath))) {
            return false;
        }
        const [sourceSchema, generatedSchema] = await Promise.all([
            readText(check.sourcePath),
            readText(generatedSchemaPath),
        ]);
        for (const requiredFile of REQUIRED_GENERATED_CLIENT_FILES) {
            if (!(await fileExists(join(check.generatedClientDir, requiredFile)))) {
                return false;
            }
        }
        const stampPath = join(check.generatedClientDir, PRISMA_SOURCE_SCHEMA_STAMP);
        const stampedSourceDigest = await readText(stampPath).catch(() => null);
        if (stampedSourceDigest !== null) {
            if (stampedSourceDigest.trim() !== digestPrismaSourceSchema(sourceSchema)) {
                return false;
            }
        } else if (normalizePrismaSchemaText(sourceSchema) !== normalizePrismaSchemaText(generatedSchema)) {
            return false;
        }
        if (check.copiesRuntime) {
            const copiedRuntimePath = join(check.generatedClientDir, "runtime", "client.js");
            if (!(await fileExists(copiedRuntimePath))) return false;
            const [sourceRuntime, copiedRuntime] = await Promise.all([
                readText(prismaLayout.clientRuntimePath),
                readText(copiedRuntimePath),
            ]);
            // Prisma prepends its generated-file notice to the copied runtime.
            // Schema equality alone misses dependency patches at the same version.
            if (!sourceRuntime || !copiedRuntime.endsWith(sourceRuntime)) return false;
        }
    }

    return true;
}

const CLIENT_GENERATOR_BLOCK = /^(generator client \{\n)/m;

/** The default-client schema with its `client` generator writing to `output` (a run-local client). */
export function withDefaultClientOutput(schema: string, output: string): string {
    if (!CLIENT_GENERATOR_BLOCK.test(schema) || /^generator client \{[^}]*^\s*output\s*=/m.test(schema)) {
        throw new Error("[prisma-generate] the default schema needs a `generator client` block without an output");
    }
    return schema.replace(CLIENT_GENERATOR_BLOCK, `$1    output = ${JSON.stringify(output)}\n`);
}

/**
 * Generates the default client into this checkout's `defaultClientDir`. When the installed
 * `@prisma/client` belongs to another checkout, that is the run-local client, generated from an
 * staged copy of the schema (under the ignored `generated/`) with the output set; the installed client is never written.
 */
async function generateDefaultClient(serverRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
    const layout = resolveServerPrismaInstallLayout({ serverRoot });
    const schemaPath = join(serverRoot, "prisma", "schema.prisma");
    const generateEnv = { ...env, DATABASE_URL: prismaGenerateDatabaseUrlForProvider("postgres") };
    if (layout.ownsInstalledClient) {
        await runPrismaCli({ serverRoot, args: ["generate"], env: generateEnv });
    } else {
        // Prisma resolves @prisma/client from the schema's directory, so the copy stays in this server package.
        await mkdir(join(serverRoot, "generated"), { recursive: true });
        const stage = await mkdtemp(join(serverRoot, "generated", ".default-client-schema-"));
        try {
            const stagedSchemaPath = join(stage, "schema.prisma");
            await writeFile(stagedSchemaPath, withDefaultClientOutput(await readFile(schemaPath, "utf8"), layout.defaultClientDir));
            await runPrismaCli({ serverRoot, args: ["generate", "--schema", stagedSchemaPath], env: generateEnv });
        } finally {
            await rm(stage, { recursive: true, force: true });
        }
    }
    await writePrismaSourceSchemaStamp({ sourcePath: schemaPath, generatedClientDir: layout.defaultClientDir });
}

export function resolveSchemaSyncInvocation(params: Readonly<{
    env: NodeJS.ProcessEnv;
    checkOnly: boolean;
    processExecPath?: string;
}>): Readonly<{ command: string; args: string[] }> {
    const check = params.checkOnly || String(params.env.HAPPIER_DEV_TARGET_EXECUTION ?? "").trim() === "1";
    return {
        command: params.processExecPath ?? process.execPath,
        args: [
            "./scripts/runTsx.mjs",
            "--tsconfig",
            "./tsconfig.json",
            "./scripts/schemaSync.ts",
            ...(check ? ["--check"] : []),
            "--quiet",
        ],
    };
}

export async function invalidateServerTypeScriptBuildInfo(params: Readonly<{
    serverRoot: string;
    statFile?: (path: string) => Promise<Readonly<{ mtimeMs: number }>>;
    rmFile?: (path: string, options: Readonly<{ force: boolean }>) => Promise<void>;
    resolveInstalledPath?: ResolveInstalledPath;
}>): Promise<void> {
    const statFile = params.statFile ?? stat;
    const buildInfoPath = join(
        params.serverRoot,
        "node_modules",
        ".cache",
        "tsc",
        "server.typecheck.tsbuildinfo",
    );
    const buildInfo = await statFile(buildInfoPath).catch(() => null);
    if (!buildInfo) return;
    const declarationPaths = [
        join(resolveServerPrismaInstallLayout(params).defaultClientDir, "index.d.ts"),
        join(params.serverRoot, "generated", "sqlite-client", "index.d.ts"),
        join(params.serverRoot, "generated", "mysql-client", "index.d.ts"),
    ];
    const declarations = await Promise.all(declarationPaths.map(async (path) => (
        await statFile(path).catch(() => null)
    )));
    if (!declarations.some((entry) => entry && entry.mtimeMs > buildInfo.mtimeMs)) return;
    await (params.rmFile ?? rm)(buildInfoPath, { force: true });
}

async function main(): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const serverRoot = resolveServerWorkspaceRoot(import.meta.url);
    const providers = resolveBuildDbProvidersFromEnv(env);
    const checkOnly = process.argv.includes("--check");

    const schemaSyncInvocation = resolveSchemaSyncInvocation({ env, checkOnly });
    await runCommand(schemaSyncInvocation.command, schemaSyncInvocation.args, env, { cwd: serverRoot });
    await invalidateServerTypeScriptBuildInfo({ serverRoot });
    if (resolveServerPrismaInstallLayout({ serverRoot }).ownsInstalledClient && !checkOnly) {
        // A run-local default client exists only while node_modules belonged to another checkout.
        await rm(join(serverRoot, "generated", "default-client"), { recursive: true, force: true });
    }
    if (await areRequestedPrismaOutputsCurrent({ serverRoot, providers })) {
        return;
    }
    if (checkOnly) {
        throw new Error(
            "Generated Prisma clients are stale. Run `pnpm --dir apps/server run generate:providers` before typechecking the runtime.",
        );
    }

    // Always generate the default client (postgres schema).
    await generateDefaultClient(serverRoot, env);

    if (providers.has("sqlite")) {
        await runPrismaCli({
            serverRoot,
            args: ["generate", "--schema", "prisma/sqlite/schema.prisma"],
            env: {
                ...env,
                DATABASE_URL: prismaGenerateDatabaseUrlForProvider("sqlite"),
            },
        });
        await writePrismaSourceSchemaStamp({
            sourcePath: join(serverRoot, "prisma", "sqlite", "schema.prisma"),
            generatedClientDir: join(serverRoot, "generated", "sqlite-client"),
        });
    }
    if (providers.has("mysql")) {
        await runPrismaCli({
            serverRoot,
            args: ["generate", "--schema", "prisma/mysql/schema.prisma"],
            env: {
                ...env,
                DATABASE_URL: prismaGenerateDatabaseUrlForProvider("mysql"),
            },
        });
        await writePrismaSourceSchemaStamp({
            sourcePath: join(serverRoot, "prisma", "mysql", "schema.prisma"),
            generatedClientDir: join(serverRoot, "generated", "mysql-client"),
        });
    }
    await invalidateServerTypeScriptBuildInfo({ serverRoot });
}

if (isMainModule(import.meta.url, process.argv[1])) {
    // eslint-disable-next-line no-void
    void main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
