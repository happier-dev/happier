import { describe, expect, it } from "vitest";
import { resolveGeneratedClientEntrypoint } from "./prisma";

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
});
