import { describe, expect, it } from "vitest";
import {
    areRequestedPrismaOutputsCurrent,
    invalidateServerTypeScriptBuildInfo,
    isMainModule,
    prismaGenerateDatabaseUrlForProvider,
    resolveBuildDbProvidersFromEnv,
    resolveSchemaSyncInvocation,
} from "./generateClients";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolveServerPrismaInstallLayout } from "./prismaInstallLayout.mjs";

/** Installed-package layout the hoisted pnpm linker produces for apps/server. */
function installedFromServer(specifier: string): string {
    return join("/repo/apps/server/node_modules", specifier);
}

function extractPrismaModelBlock(schema: string, modelName: string): string {
    const modelStart = schema.indexOf(`model ${modelName} {`);
    if (modelStart === -1) {
        throw new Error(`Missing Prisma model ${modelName}`);
    }
    const nextModelStart = schema.indexOf("\nmodel ", modelStart + 1);
    return schema
        .slice(modelStart, nextModelStart === -1 ? undefined : nextModelStart)
        .replace(/\s+/g, " ")
        .trim();
}

describe("resolveBuildDbProvidersFromEnv", () => {
    it("defaults to postgres+mysql+sqlite when unset", () => {
        expect([...resolveBuildDbProvidersFromEnv({})].sort()).toEqual(["mysql", "postgres", "sqlite"]);
    });

    it("treats empty as default", () => {
        expect([...resolveBuildDbProvidersFromEnv({ HAPPIER_BUILD_DB_PROVIDERS: "   " })].sort()).toEqual([
            "mysql",
            "postgres",
            "sqlite",
        ]);
    });

    it("always includes postgres (required for @prisma/client runtime import)", () => {
        expect([...resolveBuildDbProvidersFromEnv({ HAPPIER_BUILD_DB_PROVIDERS: "mysql" })].sort()).toEqual([
            "mysql",
            "postgres",
        ]);
    });

    it("maps pglite to postgres", () => {
        expect([...resolveBuildDbProvidersFromEnv({ HAPPIER_BUILD_DB_PROVIDERS: "pglite|sqlite" })].sort()).toEqual([
            "postgres",
            "sqlite",
        ]);
    });

    it("supports all", () => {
        expect([...resolveBuildDbProvidersFromEnv({ HAPPIER_BUILD_DB_PROVIDERS: "all" })].sort()).toEqual([
            "mysql",
            "postgres",
            "sqlite",
        ]);
    });

    it("rejects unknown tokens", () => {
        expect(() => resolveBuildDbProvidersFromEnv({ HAPPIER_BUILD_DB_PROVIDERS: "nope" })).toThrow(/Unsupported/);
    });
});

describe("isMainModule", () => {
    it("returns true when argv1 resolves to import.meta.url", () => {
        const argv1 = resolve(process.cwd(), "apps/server/scripts/generateClients.ts");
        const importMetaUrl = pathToFileURL(argv1).href;
        expect(isMainModule(importMetaUrl, argv1)).toBe(true);
    });

    it("returns false when argv1 is missing", () => {
        expect(isMainModule("file:///tmp/x.js", undefined)).toBe(false);
    });

    it("returns false when argv1 is a relative path", () => {
        expect(isMainModule("file:///tmp/x.js", "./scripts/generateClients.ts")).toBe(false);
    });
});

describe("prismaGenerateDatabaseUrlForProvider", () => {
    it("returns provider-compatible URL schemes", () => {
        expect(prismaGenerateDatabaseUrlForProvider("postgres")).toMatch(/^postgresql:\/\//);
        expect(prismaGenerateDatabaseUrlForProvider("mysql")).toMatch(/^mysql:\/\//);
        expect(prismaGenerateDatabaseUrlForProvider("sqlite")).toMatch(/^file:/);
    });
});

describe("resolveSchemaSyncInvocation", () => {
    it("uses the direct Node script and checks tracked outputs for typechecks and one-way mirrors", () => {
        expect(resolveSchemaSyncInvocation({
            env: {},
            checkOnly: true,
            processExecPath: "/runtime/node",
        })).toEqual({
            command: "/runtime/node",
            args: [
                "./scripts/runTsx.mjs",
                "--tsconfig",
                "./tsconfig.json",
                "./scripts/schemaSync.ts",
                "--check",
                "--quiet",
            ],
        });
        expect(resolveSchemaSyncInvocation({
            env: { HAPPIER_DEV_TARGET_EXECUTION: "1" },
            checkOnly: false,
            processExecPath: "/runtime/node",
        }).args).toContain("--check");
        expect(resolveSchemaSyncInvocation({
            env: {},
            checkOnly: false,
            processExecPath: "/runtime/node",
        }).args).not.toContain("--check");
    });
});

describe("invalidateServerTypeScriptBuildInfo", () => {
    it("removes the incremental cache only when generated Prisma declarations are newer", async () => {
        const removed: Array<Readonly<{ path: string; options: Readonly<{ force: boolean }> }>> = [];
        const mtimes = new Map([
            ["/repo/apps/server/node_modules/.cache/tsc/server.typecheck.tsbuildinfo", 10],
            ["/repo/apps/server/node_modules/.prisma/client/index.d.ts", 20],
            ["/repo/apps/server/generated/sqlite-client/index.d.ts", 5],
            ["/repo/apps/server/generated/mysql-client/index.d.ts", 5],
        ]);

        await invalidateServerTypeScriptBuildInfo({
            serverRoot: "/repo/apps/server",
            resolveInstalledPath: installedFromServer,
            statFile: async (path) => ({ mtimeMs: mtimes.get(path) ?? 0 }),
            rmFile: async (path, options) => {
                removed.push({ path, options });
            },
        });

        expect(removed).toEqual([{
            path: "/repo/apps/server/node_modules/.cache/tsc/server.typecheck.tsbuildinfo",
            options: { force: true },
        }]);

        mtimes.set("/repo/apps/server/node_modules/.cache/tsc/server.typecheck.tsbuildinfo", 30);
        await invalidateServerTypeScriptBuildInfo({
            serverRoot: "/repo/apps/server",
            resolveInstalledPath: installedFromServer,
            statFile: async (path) => ({ mtimeMs: mtimes.get(path) ?? 0 }),
            rmFile: async (path, options) => {
                removed.push({ path, options });
            },
        });
        expect(removed).toHaveLength(1);
    });
});

describe("areRequestedPrismaOutputsCurrent", () => {
    const sourceDigest = (schema: string): string => createHash("sha256").update(schema).digest("hex");
    const serverRoot = "/repo/apps/server";
    const defaultClientDir = "/repo/apps/server/node_modules/.prisma/client";
    const runtimeSourcePath = "/repo/apps/server/node_modules/@prisma/client/runtime/client.js";
    const sharedSchema = `
        generator client {
            provider = "prisma-client-js"
        }
    `;
    const generatedClientFiles = (dir: string): Array<[string, string]> => [
        [`${dir}/index.js`, "module.exports = {}\n"],
        [`${dir}/default.js`, "module.exports = {}\n"],
        [`${dir}/package.json`, "{\n}\n"],
        [`${dir}/query_compiler_fast_bg.js`, "module.exports = {}\n"],
        [`${dir}/query_compiler_fast_bg.wasm-base64.js`, "module.exports = {}\n"],
    ];
    const checkWith = (files: Map<string, string>, providers: ReadonlySet<"postgres" | "sqlite" | "mysql">) =>
        areRequestedPrismaOutputsCurrent({
            serverRoot,
            providers,
            resolveInstalledPath: installedFromServer,
            fileExists: async (path) => files.has(path),
            readText: async (path) => {
                const value = files.get(path);
                if (typeof value !== "string") throw new Error(`Unexpected file read: ${path}`);
                return value;
            },
        });

    it("keeps the checked-in MySQL generated client synchronized with the MySQL schema", async () => {
        const serverRoot = process.cwd();
        const [sourceSchema, generatedSchema, generatedTypes] = await Promise.all([
            readFile(join(serverRoot, "prisma", "mysql", "schema.prisma"), "utf8"),
            readFile(join(serverRoot, "generated", "mysql-client", "schema.prisma"), "utf8"),
            readFile(join(serverRoot, "generated", "mysql-client", "index.d.ts"), "utf8"),
        ]);

        expect(extractPrismaModelBlock(generatedSchema, "VoiceSessionLease")).toBe(
            extractPrismaModelBlock(sourceSchema, "VoiceSessionLease"),
        );
        expect(generatedTypes).toContain("providerBindingNonce");
        expect(generatedTypes).not.toContain("VoiceSessionLeaseProviderIdProviderConversationIdCompoundUniqueInput");
    });

    it("locates the default client beside the @prisma/client the server resolves", () => {
        expect(resolveServerPrismaInstallLayout({ serverRoot, resolveInstalledPath: installedFromServer }).defaultClientDir)
            .toBe(defaultClientDir);
        const installedClientPackage = createRequire(join(process.cwd(), "package.json"))
            .resolve("@prisma/client/package.json");
        const installed = resolveServerPrismaInstallLayout({ serverRoot: process.cwd() });
        expect(installed.defaultClientDir)
            .toBe(join(dirname(installedClientPackage), "..", "..", ".prisma", "client"));
        expect(installed.clientRuntimePath)
            .toBe(createRequire(join(process.cwd(), "package.json")).resolve("@prisma/client/runtime/client.js"));
    });

    it("never targets another checkout's installed client: a linked node_modules gets a run-local default client", () => {
        // A snapshot or worktree whose node_modules links into the live checkout must not
        // regenerate the live checkout's .prisma/client from its own schema.
        const snapshotServerRoot = "/snapshots/one/apps/server";
        const layout = resolveServerPrismaInstallLayout({
            serverRoot: snapshotServerRoot,
            resolveInstalledPath: (specifier) => join("/live/apps/server/node_modules", specifier),
        });
        expect(layout.defaultClientDir).toBe(join(snapshotServerRoot, "generated", "default-client"));
        expect(layout.ownsInstalledClient).toBe(false);
        expect(resolveServerPrismaInstallLayout({ serverRoot, resolveInstalledPath: installedFromServer }).ownsInstalledClient)
            .toBe(true);
    });

    it("checks copied query-compiler runtimes as well as schemas against the installed client", async () => {
        const files = new Map<string, string>([
            [runtimeSourcePath, "pristine-runtime"],
            ["/repo/apps/server/generated/sqlite-client/runtime/client.js", "/* Prisma generated notice */\npristine-runtime"],
            ["/repo/apps/server/generated/mysql-client/runtime/client.js", "/* Prisma generated notice */\npristine-runtime"],
            ["/repo/apps/server/prisma/schema.prisma", sharedSchema],
            [`${defaultClientDir}/schema.prisma`, sharedSchema],
            ...generatedClientFiles(defaultClientDir),
            ["/repo/apps/server/prisma/sqlite/schema.prisma", sharedSchema],
            ["/repo/apps/server/generated/sqlite-client/schema.prisma", sharedSchema],
            ...generatedClientFiles("/repo/apps/server/generated/sqlite-client"),
            ["/repo/apps/server/prisma/mysql/schema.prisma", sharedSchema],
            ["/repo/apps/server/generated/mysql-client/schema.prisma", sharedSchema],
            ...generatedClientFiles("/repo/apps/server/generated/mysql-client"),
        ]);
        const all = new Set(["postgres", "sqlite", "mysql"] as const);

        expect(await checkWith(files, all)).toBe(true);

        files.set(runtimeSourcePath, "patched-runtime");
        expect(await checkWith(files, all)).toBe(false);
        files.set("/repo/apps/server/generated/sqlite-client/runtime/client.js", "/* Prisma generated notice */\npatched-runtime");
        expect(await checkWith(files, all)).toBe(false);
        files.set("/repo/apps/server/generated/mysql-client/runtime/client.js", "/* Prisma generated notice */\npatched-runtime");
        expect(await checkWith(files, all)).toBe(true);
    });

    it("uses the source-schema generation stamp instead of Prisma's reordered generated schema text", async () => {
        const sourceSchema = `
            generator client {
                provider = "prisma-client-js"
            }

            model Run {
                id String @db.VarChar(36) @id @default(uuid())
                @@index([id])
                @@unique([id])
            }
        `;
        const prismaGeneratedSchema = `
            generator client {
                provider = "prisma-client-js"
            }

            model Run {
                id String @id @default(uuid()) @db.VarChar(36)
                @@unique([id])
                @@index([id])
            }
        `;
        const files = new Map<string, string>([
            ["/repo/apps/server/prisma/schema.prisma", sourceSchema],
            [`${defaultClientDir}/schema.prisma`, prismaGeneratedSchema],
            [`${defaultClientDir}/.happier-source-schema.sha256`, `${sourceDigest(sourceSchema)}\n`],
            ...generatedClientFiles(defaultClientDir),
        ]);

        await expect(checkWith(files, new Set(["postgres"]))).resolves.toBe(true);
    });

    it("returns false when a requested generated schema drifts from the source schema", async () => {
        const files = new Map<string, string>([
            ["/repo/apps/server/prisma/schema.prisma", sharedSchema],
            [`${defaultClientDir}/schema.prisma`, `${sharedSchema}\n// drifted`],
            ...generatedClientFiles(defaultClientDir),
        ]);

        expect(await checkWith(files, new Set(["postgres"]))).toBe(false);
    });

    it("returns false when a requested generated client is missing its embedded query compiler", async () => {
        const files = new Map<string, string>([
            ["/repo/apps/server/prisma/schema.prisma", sharedSchema],
            [`${defaultClientDir}/schema.prisma`, sharedSchema],
            ...generatedClientFiles(defaultClientDir),
        ]);
        expect(await checkWith(files, new Set(["postgres"]))).toBe(true);

        files.delete(`${defaultClientDir}/query_compiler_fast_bg.wasm-base64.js`);
        expect(await checkWith(files, new Set(["postgres"]))).toBe(false);
    });
});
