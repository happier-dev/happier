import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { resolveServerWorkspaceRoot, runPrismaCli } from "./prismaCli";
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
}>;

function defaultFileExists(path: string): Promise<boolean> {
    return readFile(path, "utf8").then(() => true).catch(() => false);
}

function normalizePrismaSchemaText(text: string): string {
    return String(text ?? "").replace(/\s+/g, " ").trim();
}

const PRISMA_BINARY_TARGET_ENGINE_FILES = new Map<string, string>([
    ["debian-openssl-3.0.x", "libquery_engine-debian-openssl-3.0.x.so.node"],
    ["linux-arm64-openssl-3.0.x", "libquery_engine-linux-arm64-openssl-3.0.x.so.node"],
    ["darwin", "libquery_engine-darwin.dylib.node"],
    ["darwin-arm64", "libquery_engine-darwin-arm64.dylib.node"],
    ["windows", "query_engine-windows.dll.node"],
]);

function resolveRequiredGeneratedClientFiles(sourceSchema: string): string[] | null {
    const binaryTargetsMatch = sourceSchema.match(/binaryTargets\s*=\s*\[([\s\S]*?)\]/m);
    if (!binaryTargetsMatch) {
        return null;
    }

    const requiredFiles = new Set(["index.js", "default.js", "package.json"]);
    const binaryTargets = Array.from(binaryTargetsMatch[1]!.matchAll(/"([^"]+)"/g)).map((match) => normalizeToken(match[1] ?? ""));
    for (const binaryTarget of binaryTargets) {
        if (!binaryTarget || binaryTarget === "native") {
            continue;
        }
        const engineFile = PRISMA_BINARY_TARGET_ENGINE_FILES.get(binaryTarget);
        if (!engineFile) {
            return null;
        }
        requiredFiles.add(engineFile);
    }

    return [...requiredFiles];
}

export async function areRequestedPrismaOutputsCurrent(params: OutputStatusParams): Promise<boolean> {
    const serverRoot = params.serverRoot;
    const repoRoot = join(serverRoot, "..", "..");
    const fileExists = params.fileExists ?? defaultFileExists;
    const readText = params.readText ?? ((path: string) => readFile(path, "utf8"));

    const checks: Array<Readonly<{ sourcePath: string; generatedClientDir: string }>> = [
        {
            sourcePath: join(serverRoot, "prisma", "schema.prisma"),
            generatedClientDir: join(repoRoot, "node_modules", ".prisma", "client"),
        },
    ];
    if (params.providers.has("sqlite")) {
        checks.push({
            sourcePath: join(serverRoot, "prisma", "sqlite", "schema.prisma"),
            generatedClientDir: join(serverRoot, "generated", "sqlite-client"),
        });
    }
    if (params.providers.has("mysql")) {
        checks.push({
            sourcePath: join(serverRoot, "prisma", "mysql", "schema.prisma"),
            generatedClientDir: join(serverRoot, "generated", "mysql-client"),
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
        const requiredFiles = resolveRequiredGeneratedClientFiles(sourceSchema);
        if (requiredFiles == null) {
            return false;
        }
        for (const requiredFile of requiredFiles) {
            if (!(await fileExists(join(check.generatedClientDir, requiredFile)))) {
                return false;
            }
        }
        if (normalizePrismaSchemaText(sourceSchema) !== normalizePrismaSchemaText(generatedSchema)) {
            return false;
        }
    }

    return true;
}

export function resolveSchemaSyncScript(env: NodeJS.ProcessEnv): "schema:sync" | "schema:sync:check" {
    return String(env.HAPPIER_DEV_TARGET_EXECUTION ?? "").trim() === "1"
        ? "schema:sync:check"
        : "schema:sync";
}

async function main(): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const serverRoot = resolveServerWorkspaceRoot(import.meta.url);
    const providers = resolveBuildDbProvidersFromEnv(env);

    await runCommand("yarn", ["-s", resolveSchemaSyncScript(env), "--quiet"], env, { cwd: serverRoot });
    if (await areRequestedPrismaOutputsCurrent({ serverRoot, providers })) {
        return;
    }

    // Always generate the default client (postgres schema).
    await runPrismaCli({
        serverRoot,
        args: ["generate"],
        env: {
            ...env,
            DATABASE_URL: prismaGenerateDatabaseUrlForProvider("postgres"),
        },
    });

    if (providers.has("sqlite")) {
        await runPrismaCli({
            serverRoot,
            args: ["generate", "--schema", "prisma/sqlite/schema.prisma"],
            env: {
                ...env,
                DATABASE_URL: prismaGenerateDatabaseUrlForProvider("sqlite"),
            },
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
    }
}

if (isMainModule(import.meta.url, process.argv[1])) {
    // eslint-disable-next-line no-void
    void main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
