import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";
import {
  hasServerSharedDepsOutputs,
  hasServerGeneratedProviderOutputs,
  resolveServerStartLaunchSpec,
  shouldRetryServerStartFromFailureContext,
  resolveSharedDepsBuildArgs,
  resolveTestDbProvider,
  resolveMigrateCommandArgs,
  resolveStartCommandArgs,
  shouldUseServerSourceEntrypoint,
  withServerSharedDepsBuildLock,
  type TestDbProvider,
} from "./serverLight";
import { resolveServerAppWorkspaceName } from "./serverWorkspaceName";

const normalizeForPathAssertions = (value: string): string => value.replace(/\\/g, "/");

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

  it("pins TSX_TSCONFIG_PATH for workspace-driven server launches", () => {
    const launch = resolveServerStartLaunchSpec({
      provider: "sqlite",
      env: {},
    });

    expect(launch.command).toMatch(/yarn(?:\.cmd)?$/);
    expect(launch.args).toEqual(["-s", "workspace", resolveServerAppWorkspaceName(), "start:light"]);
    expect(launch.cwd.length).toBeGreaterThan(0);
    expect(launch.env).toMatchObject({
      TSX_TSCONFIG_PATH: expect.stringContaining("tsconfig.json"),
    });
    const tsconfigPath = launch.env?.TSX_TSCONFIG_PATH;
    expect(tsconfigPath).toBeDefined();
    expect(normalizeForPathAssertions(tsconfigPath ?? "")).toContain("/apps/server/tsconfig.json");
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

  it("serializes shared deps builds across concurrent callers", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "happier-server-shared-deps-lock-"));
    const lockPath = resolve(rootDir, "server-shared-deps-build.lock");
    let releaseFirst = () => {};
    let secondEntered = false;

    const first = withServerSharedDepsBuildLock(
      async () =>
        await new Promise<void>((resolveFirst) => {
          releaseFirst = resolveFirst;
        }),
      {
        lockPath,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
        staleAfterMs: 5_000,
      },
    );

    const second = withServerSharedDepsBuildLock(
      async () => {
        secondEntered = true;
      },
      {
        lockPath,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
        staleAfterMs: 5_000,
      },
    );

    await sleep(50);
    expect(secondEntered).toBe(false);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(secondEntered).toBe(true);
  });

	  it("detects when shared server dependency outputs already exist", () => {
	    const rootDir = mkdtempSync(join(tmpdir(), "happier-server-shared-deps-"));
	    expect(hasServerSharedDepsOutputs(rootDir)).toBe(false);

	    mkdirSync(resolve(rootDir, "packages", "agents", "dist"), { recursive: true });
	    writeFileSync(resolve(rootDir, "packages", "agents", "dist", "index.js"), "export {};\n", "utf8");
	    expect(hasServerSharedDepsOutputs(rootDir)).toBe(false);

	    mkdirSync(resolve(rootDir, "packages", "protocol", "dist"), { recursive: true });
	    writeFileSync(resolve(rootDir, "packages", "protocol", "dist", "index.js"), "export {};\n", "utf8");
	    expect(hasServerSharedDepsOutputs(rootDir)).toBe(false);

	    mkdirSync(resolve(rootDir, "packages", "cli-common", "dist", "tailscale"), { recursive: true });
	    writeFileSync(resolve(rootDir, "packages", "cli-common", "dist", "tailscale", "index.js"), "export {};\n", "utf8");
	    expect(hasServerSharedDepsOutputs(rootDir)).toBe(true);
	  });

  it("detects when generated provider outputs are current", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "happier-server-generated-"));
    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(false);

    mkdirSync(resolve(rootDir, "apps", "server", "prisma", "sqlite"), { recursive: true });
    mkdirSync(resolve(rootDir, "apps", "server", "prisma", "mysql"), { recursive: true });
    mkdirSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client"), { recursive: true });
    mkdirSync(resolve(rootDir, "apps", "server", "generated", "mysql-client"), { recursive: true });
    mkdirSync(resolve(rootDir, "node_modules", ".prisma", "client"), { recursive: true });

    writeFileSync(resolve(rootDir, "apps", "server", "prisma", "schema.prisma"), "datasource db { provider = \"postgresql\" }\n", "utf8");
    writeFileSync(resolve(rootDir, "apps", "server", "prisma", "sqlite", "schema.prisma"), "datasource db { provider = \"sqlite\" }\n", "utf8");
    writeFileSync(
      resolve(rootDir, "apps", "server", "prisma", "mysql", "schema.prisma"),
      [
        "datasource db { provider = \"mysql\" }",
        "model PublicSessionShare {",
        "  id String @id",
        "  tokenHash Bytes @db.VarBinary(32) @unique",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client", "index.js"), "export {};\n", "utf8");
    writeFileSync(resolve(rootDir, "apps", "server", "generated", "mysql-client", "index.js"), "export {};\n", "utf8");
    writeFileSync(resolve(rootDir, "node_modules", ".prisma", "client", "default.js"), "module.exports={};\n", "utf8");

    writeFileSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client", "schema.prisma"), "datasource db { provider = \"sqlite\" }\n", "utf8");
    writeFileSync(
      resolve(rootDir, "apps", "server", "generated", "mysql-client", "schema.prisma"),
      [
        "datasource db { provider = \"mysql\" }",
        "model PublicSessionShare {",
        "  id String @id",
        "  tokenHash Bytes @unique @db.VarBinary(32)",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(resolve(rootDir, "node_modules", ".prisma", "client", "schema.prisma"), "datasource db { provider = \"postgresql\" }\n", "utf8");

    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(true);
    expect(hasServerGeneratedProviderOutputs(rootDir, "mysql")).toBe(true);

    writeFileSync(resolve(rootDir, "apps", "server", "generated", "mysql-client", "schema.prisma"), "stale mysql\n", "utf8");
    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(true);
    expect(hasServerGeneratedProviderOutputs(rootDir, "mysql")).toBe(false);

    writeFileSync(resolve(rootDir, "apps", "server", "prisma", "sqlite", "schema.prisma"), "changed\n", "utf8");
    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(false);
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

  it("retries server start when auth initialization stalls before health is ready", () => {
    const retry = shouldRetryServerStartFromFailureContext({
      attempt: 1,
      maxAttempts: 5,
      preflightPortAvailable: true,
      error: new Error("Timed out waiting for /health at http://127.0.0.1:50133 | lastStatus=none | lastBodyStatus=none | lastError=fetch failed"),
      stderrTail: "",
      stdoutTail: "[16:04:06.479] INFO: Initializing auth module...",
    });
    expect(retry).toBe(true);
  });

  it("supports explicit server source-entrypoint mode flags", () => {
    expect(shouldUseServerSourceEntrypoint({})).toBe(false);
    expect(shouldUseServerSourceEntrypoint({ HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: "1" })).toBe(true);
    expect(shouldUseServerSourceEntrypoint({ HAPPY_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: "yes" })).toBe(true);
  });

  it.each<[
    TestDbProvider,
    string,
  ]>([
    ["sqlite", "main.light.ts"],
    ["pglite", "main.light.ts"],
    ["postgres", "main.ts"],
  ])("uses the direct server source entrypoint for %s when enabled", (provider, expectedEntrypoint) => {
    const launch = resolveServerStartLaunchSpec({
      provider,
      env: { HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: "1" },
    });

    expect(launch.command).toBe(process.execPath);
    expect(normalizeForPathAssertions(launch.cwd)).toContain(`/apps/server`);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--import",
        expect.stringContaining("tsx/dist/esm/index.mjs"),
        expect.stringContaining(expectedEntrypoint),
      ]),
    );
    expect(launch.env).toMatchObject({
      TSX_TSCONFIG_PATH: expect.stringContaining("tsconfig.json"),
    });
    const tsconfigPath = launch.env?.TSX_TSCONFIG_PATH;
    expect(tsconfigPath).toBeDefined();
    expect(normalizeForPathAssertions(tsconfigPath ?? "")).toContain("/apps/server/tsconfig.json");
  });
});
