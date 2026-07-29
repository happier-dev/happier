import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("server package TypeScript build script", () => {
    it("uses the server runner that delegates to the shared native compiler resolver", () => {
        const packageJson = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")) as {
            scripts?: Record<string, string>;
        };

        expect(packageJson.scripts?.build).toContain("scripts/runTypeScriptCli.mjs");
        expect(packageJson.scripts?.build).not.toContain("tsc --noEmit");

        const runner = readFileSync(resolve(__dirname, "runTypeScriptCli.mjs"), "utf8");
        expect(runner).toContain("scripts/workspaces/resolveTypeScriptCliInvocation.mjs");
    });
});
