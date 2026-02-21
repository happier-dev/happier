import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    resolveGeneratedClientEntrypoint,
    resolvePackagedGeneratedClientEntrypoint,
    resolvePreferredGeneratedClientEntrypoint,
} from "./prisma";

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

    it("prefers packaged generated clients when present next to executable", async () => {
        const root = await mkdtemp(join(tmpdir(), "happier-server-packaged-prisma-"));
        const execPath = join(root, "happier-server");
        const packaged = join(root, "generated", "sqlite-client", "index.js");
        await mkdir(join(root, "generated", "sqlite-client"), { recursive: true });
        await writeFile(packaged, "export const PrismaClient = class PrismaClient {};\n", "utf-8");

        const resolved = resolvePreferredGeneratedClientEntrypoint("sqlite", execPath);
        expect(resolved).toBe(packaged);
    });
});
