import { describe, expect, it } from "vitest";

import { buildPrismaCliEnv, classifyPrismaCliEntrypointSource, ensurePrismaCliReady } from "./prismaCli";

describe("classifyPrismaCliEntrypointSource", () => {
    it("detects recursive shell wrappers that exec the same prisma entrypoint", () => {
        const entryPath = "/repo/node_modules/prisma/build/index.js";
        const source = [
            "#!/bin/sh",
            `exec "/usr/local/bin/node" "${entryPath}" "$@"`,
            "",
        ].join("\n");

        expect(classifyPrismaCliEntrypointSource({ entryPath, source })).toBe("recursive_shell_wrapper");
    });

    it("treats node-backed prisma entrypoints as healthy", () => {
        const entryPath = "/repo/node_modules/prisma/build/index.js";
        const source = [
            "#!/usr/bin/env node",
            "console.log('prisma');",
            "",
        ].join("\n");

        expect(classifyPrismaCliEntrypointSource({ entryPath, source })).toBe("healthy");
    });
});

describe("ensurePrismaCliReady", () => {
    it("repairs a recursive prisma wrapper before returning the CLI entrypoint", async () => {
        const serverRoot = "/repo/apps/server";
        const entryPath = "/repo/node_modules/prisma/build/index.js";
        let currentSource = [
            "#!/bin/sh",
            `exec "/usr/local/bin/node" "${entryPath}" "$@"`,
            "",
        ].join("\n");

        const res = await ensurePrismaCliReady({
            serverRoot,
            entryPath,
            quiet: true,
            readText: async (path) => {
                expect(path).toBe(entryPath);
                return currentSource;
            },
            fileExists: async (path) => path === entryPath,
            installFn: async ({ repoRoot }) => {
                expect(repoRoot).toBe("/repo");
                currentSource = [
                    "#!/usr/bin/env node",
                    "console.log('healthy prisma cli');",
                    "",
                ].join("\n");
            },
        });

        expect(res.entryPath).toBe(entryPath);
        expect(res.repaired).toBe(true);
    });
});

describe("buildPrismaCliEnv", () => {
    it("prepends the server and repo node_modules bin directories", () => {
        const env = buildPrismaCliEnv({
            serverRoot: "/repo/apps/server",
            env: { PATH: "/usr/bin:/bin" },
        });

        expect(env.PATH?.split(":").slice(0, 4)).toEqual([
            "/repo/apps/server/node_modules/.bin",
            "/repo/node_modules/.bin",
            "/usr/bin",
            "/bin",
        ]);
    });
});
