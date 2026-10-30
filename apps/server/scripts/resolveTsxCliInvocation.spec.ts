import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTsxCliInvocation } from "./resolveTsxCliInvocation.mjs";

describe("resolveTsxCliInvocation", () => {
    it("runs server source against workspace source exports even when dist lacks them", () => {
        const fixtureDir = mkdtempSync(join(tmpdir(), "happier-server-source-resolution-"));
        try {
            const packageDir = join(fixtureDir, "node_modules", "@happier-dev", "source-resolution-fixture");
            mkdirSync(join(packageDir, "src"), { recursive: true });
            mkdirSync(join(packageDir, "dist"));
            writeFileSync(join(packageDir, "package.json"), JSON.stringify({
                name: "@happier-dev/source-resolution-fixture",
                type: "module",
                exports: {
                    ".": {
                        "happier-source": "./src/index.ts",
                        default: "./dist/index.js",
                    },
                },
            }));
            writeFileSync(join(packageDir, "src", "index.ts"), 'export const sourceOnly: string = "SOURCE_EXPORT_READY";');
            writeFileSync(join(packageDir, "dist", "index.js"), 'export const staleOnly = true;');
            const entry = join(fixtureDir, "entry.mts");
            const tsconfig = join(fixtureDir, "tsconfig.json");
            writeFileSync(entry, 'import { sourceOnly } from "@happier-dev/source-resolution-fixture"; console.log(sourceOnly);');
            writeFileSync(tsconfig, "{}");
            const options = { cwd: fixtureDir, env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8" as const };
            const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
            // The default condition deliberately retains the stale built-package behavior.
            const built = spawnSync(process.execPath, [tsxCli, "--tsconfig", tsconfig, entry], options);
            expect(built.status).not.toBe(0);
            expect(built.stderr).toContain("does not provide an export named 'sourceOnly'");

            const launcher = join(dirname(fileURLToPath(import.meta.url)), "runTsx.mjs");
            const source = spawnSync(process.execPath, [launcher, "--tsconfig", tsconfig, entry], options);
            expect(source.status, source.stderr).toBe(0);
            expect(source.stdout.trim()).toBe("SOURCE_EXPORT_READY");
        } finally {
            rmSync(fixtureDir, { recursive: true, force: true });
        }
    });

    it("prefers the CommonJS tsx CLI entrypoint over shell-wrapper mjs files", () => {
        const invocation = resolveTsxCliInvocation({
            repoRoot: "/repo",
            processExecPath: "/node",
            existsSync: (path: string) => path === "/repo/node_modules/tsx/dist/cli.cjs",
            platform: "linux",
        });

        expect(invocation).toEqual({
            command: "/node",
            argsPrefix: ["/repo/node_modules/tsx/dist/cli.cjs", "--conditions=happier-source"],
        });
    });

    it("falls back to the workspace bin path when no direct tsx cli file is available", () => {
        const invocation = resolveTsxCliInvocation({
            repoRoot: "/repo",
            processExecPath: "/node",
            existsSync: (path: string) => path === "/repo/node_modules/.bin/tsx",
            platform: "linux",
        });

        expect(invocation).toEqual({
            command: "/repo/node_modules/.bin/tsx",
            argsPrefix: ["--conditions=happier-source"],
        });
    });
});
