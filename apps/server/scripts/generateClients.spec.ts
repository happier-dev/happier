import { describe, expect, it } from "vitest";
import { isMainModule, resolveBuildDbProvidersFromEnv } from "./generateClients";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
