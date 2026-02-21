import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

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

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            env: env as Record<string, string>,
            stdio: "inherit",
            shell: false,
        });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}

async function main(): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const providers = resolveBuildDbProvidersFromEnv(env);

    await run("yarn", ["-s", "schema:sync", "--quiet"], env);

    const require = createRequire(import.meta.url);
    const prismaCliPath = require.resolve("prisma/build/index.js");

    // Always generate the default client (postgres schema).
    await run(process.execPath, [prismaCliPath, "generate"], {
        ...env,
        DATABASE_URL: prismaGenerateDatabaseUrlForProvider("postgres"),
    });

    if (providers.has("sqlite")) {
        await run(process.execPath, [prismaCliPath, "generate", "--schema", "prisma/sqlite/schema.prisma"], {
            ...env,
            DATABASE_URL: prismaGenerateDatabaseUrlForProvider("sqlite"),
        });
    }
    if (providers.has("mysql")) {
        await run(process.execPath, [prismaCliPath, "generate", "--schema", "prisma/mysql/schema.prisma"], {
            ...env,
            DATABASE_URL: prismaGenerateDatabaseUrlForProvider("mysql"),
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
