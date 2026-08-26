import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
    resolveServerBuildDbProvidersFromEnv,
    type ServerBuildDbProvider,
} from "@happier-dev/cli-common/componentArtifacts";
import { runCommand } from "./runCommand";

export type BuildDbProvider = ServerBuildDbProvider;

export function isMainModule(importMetaUrl: string, argv1: string | undefined): boolean {
    if (!argv1) return false;
    try {
        return importMetaUrl === pathToFileURL(argv1).href;
    } catch {
        return false;
    }
}

export const resolveBuildDbProvidersFromEnv = resolveServerBuildDbProvidersFromEnv;

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

async function main(): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const providers = resolveBuildDbProvidersFromEnv(env);

    await runCommand("yarn", ["-s", "schema:sync", "--quiet"], env);

    const require = createRequire(import.meta.url);
    const prismaCliPath = require.resolve("prisma/build/index.js");

    // Always generate the default client (postgres schema).
    await runCommand(process.execPath, [prismaCliPath, "generate"], {
        ...env,
        DATABASE_URL: prismaGenerateDatabaseUrlForProvider("postgres"),
    });

    if (providers.has("sqlite")) {
        await runCommand(process.execPath, [prismaCliPath, "generate", "--schema", "prisma/sqlite/schema.prisma"], {
            ...env,
            DATABASE_URL: prismaGenerateDatabaseUrlForProvider("sqlite"),
        });
    }
    if (providers.has("mysql")) {
        await runCommand(process.execPath, [prismaCliPath, "generate", "--schema", "prisma/mysql/schema.prisma"], {
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
