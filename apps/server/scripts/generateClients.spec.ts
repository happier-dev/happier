import { describe, expect, it } from "vitest";
import {
    areRequestedPrismaOutputsCurrent,
    isMainModule,
    prismaGenerateDatabaseUrlForProvider,
    resolveBuildDbProvidersFromEnv,
    resolveSchemaSyncInvocation,
} from "./generateClients";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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

describe("areRequestedPrismaOutputsCurrent", () => {
    const sourceDigest = (schema: string): string => createHash("sha256").update(schema).digest("hex");

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

    it("returns true when the generated clients already match the requested schemas", async () => {
        const serverRoot = "/repo/apps/server";
        const sharedSchema = `
            generator client {
                provider = "prisma-client-js"
                binaryTargets = ["native", "debian-openssl-3.0.x", "linux-arm64-openssl-3.0.x", "darwin", "darwin-arm64", "windows"]
            }
        `;
        const files = new Map<string, string>([
            ["/repo/apps/server/prisma/schema.prisma", sharedSchema],
            ["/repo/node_modules/.prisma/client/schema.prisma", sharedSchema],
            ["/repo/node_modules/.prisma/client/index.js", "module.exports = {}\n"],
            ["/repo/node_modules/.prisma/client/default.js", "module.exports = {}\n"],
            ["/repo/node_modules/.prisma/client/package.json", "{\n}\n"],
            ["/repo/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node", ""],
            ["/repo/node_modules/.prisma/client/libquery_engine-linux-arm64-openssl-3.0.x.so.node", ""],
            ["/repo/node_modules/.prisma/client/libquery_engine-darwin.dylib.node", ""],
            ["/repo/node_modules/.prisma/client/libquery_engine-darwin-arm64.dylib.node", ""],
            ["/repo/node_modules/.prisma/client/query_engine-windows.dll.node", ""],
            ["/repo/apps/server/prisma/sqlite/schema.prisma", sharedSchema],
            ["/repo/apps/server/generated/sqlite-client/schema.prisma", sharedSchema],
            ["/repo/apps/server/generated/sqlite-client/index.js", "module.exports = {}\n"],
            ["/repo/apps/server/generated/sqlite-client/default.js", "module.exports = {}\n"],
            ["/repo/apps/server/generated/sqlite-client/package.json", "{\n}\n"],
            ["/repo/apps/server/generated/sqlite-client/libquery_engine-debian-openssl-3.0.x.so.node", ""],
            ["/repo/apps/server/generated/sqlite-client/libquery_engine-linux-arm64-openssl-3.0.x.so.node", ""],
            ["/repo/apps/server/generated/sqlite-client/libquery_engine-darwin.dylib.node", ""],
            ["/repo/apps/server/generated/sqlite-client/libquery_engine-darwin-arm64.dylib.node", ""],
            ["/repo/apps/server/generated/sqlite-client/query_engine-windows.dll.node", ""],
            ["/repo/apps/server/prisma/mysql/schema.prisma", sharedSchema],
            ["/repo/apps/server/generated/mysql-client/schema.prisma", sharedSchema],
            ["/repo/apps/server/generated/mysql-client/index.js", "module.exports = {}\n"],
            ["/repo/apps/server/generated/mysql-client/default.js", "module.exports = {}\n"],
            ["/repo/apps/server/generated/mysql-client/package.json", "{\n}\n"],
            ["/repo/apps/server/generated/mysql-client/libquery_engine-debian-openssl-3.0.x.so.node", ""],
            ["/repo/apps/server/generated/mysql-client/libquery_engine-linux-arm64-openssl-3.0.x.so.node", ""],
            ["/repo/apps/server/generated/mysql-client/libquery_engine-darwin.dylib.node", ""],
            ["/repo/apps/server/generated/mysql-client/libquery_engine-darwin-arm64.dylib.node", ""],
            ["/repo/apps/server/generated/mysql-client/query_engine-windows.dll.node", ""],
        ]);

        const current = await areRequestedPrismaOutputsCurrent({
            serverRoot,
            providers: new Set(["postgres", "sqlite", "mysql"]),
            fileExists: async (path) => files.has(path),
            readText: async (path) => {
                const value = files.get(path);
                if (typeof value !== "string") {
                    throw new Error(`Unexpected file read: ${path}`);
                }
                return value;
            },
        });

        expect(current).toBe(true);
    });

    it("uses the source-schema generation stamp instead of Prisma's reordered generated schema text", async () => {
        const serverRoot = "/repo/apps/server";
        const sourceSchema = `
            generator client {
                provider = "prisma-client-js"
                binaryTargets = ["native", "debian-openssl-3.0.x", "linux-arm64-openssl-3.0.x", "darwin", "darwin-arm64", "windows"]
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
                binaryTargets = ["native", "debian-openssl-3.0.x", "linux-arm64-openssl-3.0.x", "darwin", "darwin-arm64", "windows"]
            }

            model Run {
                id String @id @default(uuid()) @db.VarChar(36)
                @@unique([id])
                @@index([id])
            }
        `;
        const generatedDir = "/repo/node_modules/.prisma/client";
        const files = new Map<string, string>([
            ["/repo/apps/server/prisma/schema.prisma", sourceSchema],
            [`${generatedDir}/schema.prisma`, prismaGeneratedSchema],
            [`${generatedDir}/.happier-source-schema.sha256`, `${sourceDigest(sourceSchema)}\n`],
            [`${generatedDir}/index.js`, "module.exports = {}\n"],
            [`${generatedDir}/default.js`, "module.exports = {}\n"],
            [`${generatedDir}/package.json`, "{\n}\n"],
            [`${generatedDir}/libquery_engine-debian-openssl-3.0.x.so.node`, ""],
            [`${generatedDir}/libquery_engine-linux-arm64-openssl-3.0.x.so.node`, ""],
            [`${generatedDir}/libquery_engine-darwin.dylib.node`, ""],
            [`${generatedDir}/libquery_engine-darwin-arm64.dylib.node`, ""],
            [`${generatedDir}/query_engine-windows.dll.node`, ""],
        ]);

        await expect(areRequestedPrismaOutputsCurrent({
            serverRoot,
            providers: new Set(["postgres"]),
            fileExists: async (path) => files.has(path),
            readText: async (path) => {
                const value = files.get(path);
                if (typeof value !== "string") throw new Error(`Unexpected file read: ${path}`);
                return value;
            },
        })).resolves.toBe(true);
    });

    it("returns false when a requested generated schema drifts from the source schema", async () => {
        const serverRoot = "/repo/apps/server";
        const sharedSchema = `
            generator client {
                provider = "prisma-client-js"
                binaryTargets = ["native", "debian-openssl-3.0.x", "linux-arm64-openssl-3.0.x", "darwin", "darwin-arm64", "windows"]
            }
        `;
        const files = new Map<string, string>([
            ["/repo/apps/server/prisma/schema.prisma", sharedSchema],
            ["/repo/node_modules/.prisma/client/schema.prisma", `${sharedSchema}\n// drifted`],
            ["/repo/node_modules/.prisma/client/index.js", "module.exports = {}\n"],
            ["/repo/node_modules/.prisma/client/default.js", "module.exports = {}\n"],
            ["/repo/node_modules/.prisma/client/package.json", "{\n}\n"],
            ["/repo/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node", ""],
            ["/repo/node_modules/.prisma/client/libquery_engine-linux-arm64-openssl-3.0.x.so.node", ""],
            ["/repo/node_modules/.prisma/client/libquery_engine-darwin.dylib.node", ""],
            ["/repo/node_modules/.prisma/client/libquery_engine-darwin-arm64.dylib.node", ""],
            ["/repo/node_modules/.prisma/client/query_engine-windows.dll.node", ""],
        ]);

        const current = await areRequestedPrismaOutputsCurrent({
            serverRoot,
            providers: new Set(["postgres"]),
            fileExists: async (path) => files.has(path),
            readText: async (path) => {
                const value = files.get(path);
                if (typeof value !== "string") {
                    throw new Error(`Unexpected file read: ${path}`);
                }
                return value;
            },
        });

        expect(current).toBe(false);
    });

    it("returns false when a requested generated client is missing a declared Prisma engine binary", async () => {
        const serverRoot = "/repo/apps/server";
        const sharedSchema = `
            generator client {
                provider = "prisma-client-js"
                binaryTargets = ["native", "debian-openssl-3.0.x", "linux-arm64-openssl-3.0.x", "darwin", "darwin-arm64", "windows"]
            }
        `;
        const files = new Map<string, string>([
            ["/repo/apps/server/prisma/schema.prisma", sharedSchema],
            ["/repo/node_modules/.prisma/client/schema.prisma", sharedSchema],
            ["/repo/node_modules/.prisma/client/index.js", "module.exports = {}\n"],
            ["/repo/node_modules/.prisma/client/default.js", "module.exports = {}\n"],
            ["/repo/node_modules/.prisma/client/package.json", "{\n}\n"],
            ["/repo/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node", ""],
            ["/repo/node_modules/.prisma/client/libquery_engine-linux-arm64-openssl-3.0.x.so.node", ""],
            ["/repo/node_modules/.prisma/client/libquery_engine-darwin.dylib.node", ""],
            ["/repo/node_modules/.prisma/client/query_engine-windows.dll.node", ""],
        ]);

        const current = await areRequestedPrismaOutputsCurrent({
            serverRoot,
            providers: new Set(["postgres"]),
            fileExists: async (path) => files.has(path),
            readText: async (path) => {
                const value = files.get(path);
                if (typeof value !== "string") {
                    throw new Error(`Unexpected file read: ${path}`);
                }
                return value;
            },
        });

        expect(current).toBe(false);
    });
});
