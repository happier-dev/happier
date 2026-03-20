import { describe, expect, it } from "vitest";
import {
  shouldRetryServerStartFromFailureContext,
  resolveSharedDepsBuildArgs,
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

  it("builds shared server dependencies before startup", () => {
    expect(resolveSharedDepsBuildArgs()).toEqual(["-s", "workspace", resolveServerAppWorkspaceName(), "build:shared"]);
  });

  it("retries server start when startup failure tail contains EADDRINUSE", () => {
    const retry = shouldRetryServerStartFromFailureContext({
      attempt: 1,
      maxAttempts: 5,
      preflightPortAvailable: true,
      error: new Error("server-light exited before /health was ready (code=1)"),
      stderrTail: "Error: listen EADDRINUSE: address already in use 127.0.0.1:58786",
      stdoutTail: "",
    });
    expect(retry).toBe(true);
  });
});
