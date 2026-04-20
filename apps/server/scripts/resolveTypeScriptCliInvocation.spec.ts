import { describe, expect, it } from "vitest";

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
