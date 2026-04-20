import { describe, expect, it } from "vitest";

import { resolveServerRepoRoot } from "./resolveServerRepoRoot.mjs";

describe("resolveServerRepoRoot", () => {
    it("walks upward until it finds the monorepo root markers", () => {
        const root = resolveServerRepoRoot({
            startDir: "/repo/apps/server/scripts",
            existsSync: (path: string) => (
                path === "/repo/package.json"
                || path === "/repo/yarn.lock"
            ),
        });

        expect(root).toBe("/repo");
    });
});
