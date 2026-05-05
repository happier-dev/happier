import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveTypeScriptCliInvocation } from "./resolveTypeScriptCliInvocation.mjs";

describe("resolveTypeScriptCliInvocation", () => {
    it("prefers the JavaScript TypeScript CLI entrypoint over shell-wrapper bin paths", () => {
        const invocation = resolveTypeScriptCliInvocation({
            repoRoot: "/repo",
            processExecPath: "/node",
            requireResolve: (request: string) => {
                if (request === "typescript/lib/tsc.js") {
                    return "/repo/node_modules/typescript/lib/tsc.js";
                }
                throw new Error(`Unexpected request: ${request}`);
            },
            existsSync: () => false,
            platform: "linux",
        });

        expect(invocation).toEqual({
            command: "/node",
            argsPrefix: ["/repo/node_modules/typescript/lib/tsc.js"],
        });
    });

    it("falls back to the workspace bin path when the JavaScript CLI entrypoint cannot be resolved", () => {
        const invocation = resolveTypeScriptCliInvocation({
            repoRoot: "/repo",
            processExecPath: "/node",
            requireResolve: () => {
                throw new Error("missing typescript package");
            },
            existsSync: (path: string) => path === "/repo/node_modules/.bin/tsc",
            platform: "linux",
        });

        expect(invocation).toEqual({
            command: "/repo/node_modules/.bin/tsc",
            argsPrefix: [],
        });
    });
});

describe("server package TypeScript build script", () => {
    it("uses the server-local TypeScript CLI runner instead of the shell wrapper bin", () => {
        const packageJson = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")) as {
            scripts?: Record<string, string>;
        };

        expect(packageJson.scripts?.build).toContain("scripts/runTypeScriptCli.mjs");
        expect(packageJson.scripts?.build).not.toContain("tsc --noEmit");
    });
});
