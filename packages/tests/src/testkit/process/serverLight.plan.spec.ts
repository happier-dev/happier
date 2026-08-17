import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";
import {
  hasServerSharedDepsOutputs,
  hasServerGeneratedProviderOutputs,
  renderServerLightSqliteDatabaseUrl,
  resolveServerLightDatabaseUrlEnv,
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

  it("allows a suite SQLite fallback without overriding an explicitly selected provider", () => {
    const options = { fallbackProvider: "sqlite" as const };

    expect(resolveTestDbProvider({}, options)).toBe("sqlite");
    expect(resolveTestDbProvider({ HAPPIER_E2E_DB_PROVIDER: "pglite" }, options)).toBe("pglite");
    expect(resolveTestDbProvider({ HAPPIER_E2E_DB_PROVIDER: "postgres" }, options)).toBe("postgres");
    expect(resolveTestDbProvider({ HAPPIER_E2E_DB_PROVIDER: "mysql" }, options)).toBe("mysql");
  });

  it("preserves explicit sqlite DATABASE_URL for server launch env", () => {
    expect(
      resolveServerLightDatabaseUrlEnv({
        dbProvider: "sqlite",
        generatedSqliteUrl: "file:/generated.sqlite?connection_limit=1",
        explicitDatabaseUrl: "file:/custom.sqlite?connection_limit=4",
      }),
    ).toEqual({
      DATABASE_URL: "file:/custom.sqlite?connection_limit=4",
    });
  });

  it("uses generated sqlite DATABASE_URL when no explicit DATABASE_URL is provided", () => {
    expect(
      resolveServerLightDatabaseUrlEnv({
        dbProvider: "sqlite",
        generatedSqliteUrl: "file:/generated.sqlite?connection_limit=1",
      }),
    ).toEqual({
      DATABASE_URL: "file:/generated.sqlite?connection_limit=1",
    });
  });

  it("renders generated server-light sqlite DATABASE_URL with a bounded multi-connection pool", () => {
    expect(renderServerLightSqliteDatabaseUrl({ dbPath: "/tmp/happier-e2e/happier-server-light.sqlite", platform: "linux" })).toBe(
      "file:///tmp/happier-e2e/happier-server-light.sqlite?socket_timeout=30&connection_limit=4",
    );
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

  it("does not reclaim a shared deps build lock from a live owner solely because the owner file is old", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "happier-server-shared-deps-live-lock-"));
    const lockPath = resolve(rootDir, "server-shared-deps-build.lock");
    const ownerRaw = JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now() - 60_000,
    });
    writeFileSync(lockPath, ownerRaw, "utf8");

    let entered = false;
    try {
      await expect(
        withServerSharedDepsBuildLock(
          async () => {
            entered = true;
          },
          {
            lockPath,
            timeoutMs: 50,
            pollIntervalMs: 5,
            staleAfterMs: 1,
          },
        ),
      ).rejects.toThrow(/Timed out waiting for server shared deps build lock/);

      expect(entered).toBe(false);
      expect(readFileSync(lockPath, "utf8")).toBe(ownerRaw);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite or unlink a successor shared deps build lock after ownership changes", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "happier-server-shared-deps-successor-lock-"));
    const lockPath = resolve(rootDir, "server-shared-deps-build.lock");
    const successorRaw = JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      owner: "successor",
    });

    try {
      await withServerSharedDepsBuildLock(
        async () => {
          unlinkSync(lockPath);
          writeFileSync(lockPath, successorRaw, "utf8");

          await sleep(600);
          expect(readFileSync(lockPath, "utf8")).toBe(successorRaw);
        },
        {
          lockPath,
          timeoutMs: 5_000,
          pollIntervalMs: 5,
          staleAfterMs: 1,
        },
      );

      expect(readFileSync(lockPath, "utf8")).toBe(successorRaw);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
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

    expect(hasServerGeneratedProviderOutputs(rootDir, "pglite")).toBe(true);
    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(true);
    expect(hasServerGeneratedProviderOutputs(rootDir, "mysql")).toBe(true);

    writeFileSync(resolve(rootDir, "apps", "server", "generated", "mysql-client", "schema.prisma"), "stale mysql\n", "utf8");
    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(true);
    expect(hasServerGeneratedProviderOutputs(rootDir, "mysql")).toBe(false);

    writeFileSync(resolve(rootDir, "apps", "server", "prisma", "sqlite", "schema.prisma"), "changed\n", "utf8");
    expect(hasServerGeneratedProviderOutputs(rootDir, "pglite")).toBe(true);
    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(false);
  });

  it("accepts generated provider schemas with reordered Prisma model attributes", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "happier-server-generated-reordered-model-attributes-"));
    const sourceSchema = [
      "datasource db { provider = \"postgresql\" }",
      "model PluginPermissionGrant {",
      "  id String @id",
      "  accountId String",
      "  activeIdentityKey String",
      "  pluginId String",
      "  @@index([accountId, pluginId], map: \"plugin_permission_grants_scope_idx\")",
      "  @@unique([accountId, activeIdentityKey], map: \"plugin_permission_grants_active_identity_key\")",
      "}",
      "",
    ].join("\n");
    const generatedSchema = [
      "datasource db { provider = \"postgresql\" }",
      "model PluginPermissionGrant {",
      "  id String @id",
      "  accountId String",
      "  activeIdentityKey String",
      "  pluginId String",
      "  @@unique([accountId, activeIdentityKey], map: \"plugin_permission_grants_active_identity_key\")",
      "  @@index([accountId, pluginId], map: \"plugin_permission_grants_scope_idx\")",
      "}",
      "",
    ].join("\n");

    mkdirSync(resolve(rootDir, "apps", "server", "prisma", "sqlite"), { recursive: true });
    mkdirSync(resolve(rootDir, "apps", "server", "prisma", "mysql"), { recursive: true });
    mkdirSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client"), { recursive: true });
    mkdirSync(resolve(rootDir, "node_modules", ".prisma", "client"), { recursive: true });

    writeFileSync(resolve(rootDir, "apps", "server", "prisma", "schema.prisma"), sourceSchema, "utf8");
    writeFileSync(resolve(rootDir, "apps", "server", "prisma", "sqlite", "schema.prisma"), sourceSchema, "utf8");
    writeFileSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client", "index.js"), "export {};\n", "utf8");
    writeFileSync(resolve(rootDir, "node_modules", ".prisma", "client", "default.js"), "module.exports={};\n", "utf8");
    writeFileSync(resolve(rootDir, "node_modules", ".prisma", "client", "schema.prisma"), generatedSchema, "utf8");
    writeFileSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client", "schema.prisma"), generatedSchema, "utf8");

    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(true);
  });

  it("accepts generated provider schemas when Prisma removes blank lines between model attributes", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "happier-server-generated-model-attribute-spacing-"));
    const sourceSchema = [
      "datasource db { provider = \"postgresql\" }",
      "model ProviderUsageRecord {",
      "  id String @id",
      "  accountId String",
      "  providerId String",
      "  @@unique([accountId, id])",
      "",
      "  @@index([accountId, providerId])",
      "}",
      "",
    ].join("\n");
    const generatedSchema = sourceSchema.replace(
      "  @@unique([accountId, id])\n\n  @@index([accountId, providerId])",
      "  @@unique([accountId, id])\n  @@index([accountId, providerId])",
    );

    mkdirSync(resolve(rootDir, "apps", "server", "prisma", "sqlite"), { recursive: true });
    mkdirSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client"), { recursive: true });
    mkdirSync(resolve(rootDir, "node_modules", ".prisma", "client"), { recursive: true });

    writeFileSync(resolve(rootDir, "apps", "server", "prisma", "schema.prisma"), sourceSchema, "utf8");
    writeFileSync(resolve(rootDir, "apps", "server", "prisma", "sqlite", "schema.prisma"), sourceSchema, "utf8");
    writeFileSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client", "index.js"), "export {};\n", "utf8");
    writeFileSync(resolve(rootDir, "node_modules", ".prisma", "client", "default.js"), "module.exports={};\n", "utf8");
    writeFileSync(resolve(rootDir, "node_modules", ".prisma", "client", "schema.prisma"), generatedSchema, "utf8");
    writeFileSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client", "schema.prisma"), generatedSchema, "utf8");

    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(true);
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

  it("retries server start when health never becomes reachable and the process only emitted Node warnings", () => {
    const retry = shouldRetryServerStartFromFailureContext({
      attempt: 1,
      maxAttempts: 5,
      preflightPortAvailable: true,
      error: new Error("Timed out waiting for /health at http://127.0.0.1:57300 | lastStatus=none | lastBodyStatus=none | lastError=fetch failed"),
      stderrTail: [
        "(node:79199) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.",
        "(Use `node --trace-warnings ...` to show where the warning was created)",
      ].join("\n"),
      stdoutTail: "",
    });
    expect(retry).toBe(true);
  });

  it("retries server start when health never becomes reachable and stdout only contains the Yarn script echo", () => {
    const retry = shouldRetryServerStartFromFailureContext({
      attempt: 1,
      maxAttempts: 5,
      preflightPortAvailable: true,
      error: new Error("Timed out waiting for /health at http://127.0.0.1:40550 | lastStatus=none | lastBodyStatus=none | lastError=fetch failed"),
      stderrTail: "",
      stdoutTail: "$ node ./scripts/runTsx.mjs --tsconfig ./tsconfig.json ./sources/main.light.ts\n",
    });
    expect(retry).toBe(true);
  });

  it("does not retry a health timeout when the Yarn script echo is followed by substantive server stdout", () => {
    const retry = shouldRetryServerStartFromFailureContext({
      attempt: 1,
      maxAttempts: 5,
      preflightPortAvailable: true,
      error: new Error("Timed out waiting for /health at http://127.0.0.1:40550 | lastStatus=none | lastBodyStatus=none | lastError=fetch failed"),
      stderrTail: "",
      stdoutTail: [
        "$ node ./scripts/runTsx.mjs --tsconfig ./tsconfig.json ./sources/main.light.ts",
        "Fatal startup configuration error",
      ].join("\n"),
    });
    expect(retry).toBe(false);
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
