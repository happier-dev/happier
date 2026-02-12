import { describe, expect, it } from "vitest";
import { resolveGeneratedClientEntrypoint, resolvePackagedGeneratedClientEntrypoint } from "./prisma";

describe("resolveGeneratedClientEntrypoint", () => {
    it("appends /index.js for directory specifiers", () => {
        expect(resolveGeneratedClientEntrypoint("../../generated/mysql-client")).toMatch(/\/index\.js$/);
        expect(resolveGeneratedClientEntrypoint("../../generated/mysql-client/")).toMatch(/\/index\.js$/);
    });

    it("keeps explicit file specifiers unchanged", () => {
        expect(resolveGeneratedClientEntrypoint("../../generated/sqlite-client/index.js")).toBe(
            "../../generated/sqlite-client/index.js",
        );
    });

    it("resolves packaged generated client entrypoints next to executable", () => {
        expect(resolvePackagedGeneratedClientEntrypoint("sqlite", "/opt/happier/happier-server")).toBe(
            "/opt/happier/generated/sqlite-client/index.js",
        );
        expect(resolvePackagedGeneratedClientEntrypoint("mysql", "/opt/happier/happier-server")).toBe(
            "/opt/happier/generated/mysql-client/index.js",
        );
    });
});
