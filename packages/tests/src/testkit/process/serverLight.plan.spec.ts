import { describe, expect, it } from "vitest";
import {
  resolveTestDbProvider,
  resolveMigrateCommandArgs,
  resolveStartCommandArgs,
  type TestDbProvider,
} from "./serverLight";
import { resolveServerAppWorkspaceName } from "./serverWorkspaceName";

describe("startServerLight planning helpers", () => {
  it("defaults to pglite when HAPPIER_E2E_DB_PROVIDER is unset", () => {
    expect(resolveTestDbProvider({})).toBe("pglite");
  });

  it("accepts sqlite via HAPPIER_E2E_DB_PROVIDER", () => {
    expect(resolveTestDbProvider({ HAPPIER_E2E_DB_PROVIDER: "sqlite" })).toBe("sqlite");
  });

  it("accepts postgres via HAPPIER_E2E_DB_PROVIDER", () => {
    expect(resolveTestDbProvider({ HAPPIER_E2E_DB_PROVIDER: "postgres" })).toBe("postgres");
    expect(resolveTestDbProvider({ HAPPIER_E2E_DB_PROVIDER: "postgresql" })).toBe("postgres");
  });

  it("accepts mysql via HAPPIER_E2E_DB_PROVIDER", () => {
    expect(resolveTestDbProvider({ HAPPIER_E2E_DB_PROVIDER: "mysql" })).toBe("mysql");
  });

  it.each<[TestDbProvider, string]>([
    ["pglite", "start:light"],
    ["sqlite", "start:light"],
    ["postgres", "start"],
    ["mysql", "start"],
  ])("uses the expected start command for %s", (provider, expectedScript) => {
    expect(resolveStartCommandArgs(provider)).toEqual(["-s", "workspace", resolveServerAppWorkspaceName(), expectedScript]);
  });

  it.each<[TestDbProvider, string]>([
    ["pglite", "migrate:light:deploy"],
    ["sqlite", "migrate:sqlite:deploy"],
    ["postgres", "prisma migrate deploy"],
    ["mysql", "migrate:mysql:deploy"],
  ])("uses the expected migration command for %s", (provider, expected) => {
    const args = resolveMigrateCommandArgs(provider).join(" ");
    expect(args).toContain(expected);
  });
});
