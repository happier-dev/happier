import { describe, expect, it } from "vitest";

import { resolveTsxCliInvocation } from "./resolveTsxCliInvocation.mjs";

describe("resolveTsxCliInvocation", () => {
    it("prefers the CommonJS tsx CLI entrypoint over shell-wrapper mjs files", () => {
        const invocation = resolveTsxCliInvocation({
            repoRoot: "/repo",
            processExecPath: "/node",
            existsSync: (path: string) => path === "/repo/node_modules/tsx/dist/cli.cjs",
            platform: "linux",
        });

        expect(invocation).toEqual({
            command: "/node",
            argsPrefix: ["/repo/node_modules/tsx/dist/cli.cjs"],
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
            argsPrefix: [],
        });
    });
});
