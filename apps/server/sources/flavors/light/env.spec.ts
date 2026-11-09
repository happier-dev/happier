import { mkdtemp, mkdir, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePersonalHomeRuntimeLayout } from "@happier-dev/cli-common/firstPartyRuntime";
import {
  applyLightDefaultEnv,
  applyPackagedLightRuntimeSqliteDefaults,
  ensureHandyMasterSecret,
  loadExistingHandyMasterSecret,
  resolveLightDataDir,
  resolveLightDatabaseDir,
  resolveLightFilesDir,
  resolveLightSqliteDatabaseUrl,
} from "./env";
import { resolveLocalPrivateFilesDir } from "../../storage/privateFiles/privateFilesLocal";

describe("light env helpers", () => {
  it("applyLightDefaultEnv fills defaults without overriding explicit values", () => {
    const env: NodeJS.ProcessEnv = {
      PORT: "4000",
      DATABASE_URL: "file:/custom.sqlite",
      PUBLIC_URL: "http://example.com/",
      HAPPY_SERVER_LIGHT_DATA_DIR: "/custom/data",
      HAPPY_SERVER_LIGHT_FILES_DIR: "/custom/files",
      HAPPY_SERVER_LIGHT_DB_DIR: "/custom/db",
    };

    applyLightDefaultEnv(env, { homedir: "/home/ignored" });

    expect(env.HAPPY_SERVER_LIGHT_DATA_DIR).toBe("/custom/data");
    expect(env.HAPPY_SERVER_LIGHT_FILES_DIR).toBe("/custom/files");
    expect(env.HAPPY_SERVER_LIGHT_DB_DIR).toBe("/custom/db");
    // DATABASE_URL is not managed by the light env helpers (runtime provider wiring assigns it).
    expect(env.DATABASE_URL).toBe("file:/custom.sqlite");
    expect(env.PUBLIC_URL).toBe("http://example.com");
  });

  it("applyLightDefaultEnv derives defaults from homedir and PORT when missing", () => {
    const env: NodeJS.ProcessEnv = { PORT: "4000" };
    applyLightDefaultEnv(env, { homedir: "/home/test" });

    expect(env.HAPPY_SERVER_LIGHT_DATA_DIR).toBe(
      "/home/test/.happy/server-light",
    );
    expect(env.HAPPY_SERVER_LIGHT_FILES_DIR).toBe(
      "/home/test/.happy/server-light/files",
    );
    expect(env.HAPPY_SERVER_LIGHT_DB_DIR).toBe(
      "/home/test/.happy/server-light/pglite",
    );
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PUBLIC_URL).toBe("http://localhost:4000");
  });

  it("resolves current HAPPIER_* paths over conflicting legacy HAPPY_* aliases and agrees with the Personal Home layout owner", () => {
    const env: NodeJS.ProcessEnv = {
      HAPPIER_SERVER_LIGHT_DATA_DIR: "/current/data",
      HAPPY_SERVER_LIGHT_DATA_DIR: "/legacy/data",
      HAPPIER_SERVER_LIGHT_FILES_DIR: "/current/files",
      HAPPY_SERVER_LIGHT_FILES_DIR: "/legacy/files",
      HAPPIER_SERVER_LIGHT_DB_DIR: "/current/db",
      HAPPY_SERVER_LIGHT_DB_DIR: "/legacy/db",
    };

    expect(resolveLightDataDir(env)).toBe("/current/data");
    expect(resolveLightFilesDir(env, resolveLightDataDir(env))).toBe("/current/files");
    expect(resolveLightDatabaseDir(env, resolveLightDataDir(env))).toBe("/current/db");

    // applyLightDefaultEnv normalizes the legacy aliases to the authoritative current
    // roots without overwriting the supplied current values.
    const normalized: NodeJS.ProcessEnv = { ...env };
    applyLightDefaultEnv(normalized, { homedir: "/home/ignored" });
    expect(normalized.HAPPIER_SERVER_LIGHT_DATA_DIR).toBe("/current/data");
    expect(normalized.HAPPY_SERVER_LIGHT_DATA_DIR).toBe("/current/data");
    expect(normalized.HAPPIER_SERVER_LIGHT_FILES_DIR).toBe("/current/files");
    expect(normalized.HAPPY_SERVER_LIGHT_FILES_DIR).toBe("/current/files");
    expect(normalized.HAPPIER_SERVER_LIGHT_DB_DIR).toBe("/current/db");
    expect(normalized.HAPPY_SERVER_LIGHT_DB_DIR).toBe("/current/db");

    // Cross-owner regression: the cli-common Personal Home layout and the server
    // private-files operation adapter must resolve the same current roots from the
    // same environment as the server-light startup owner.
    const layout = resolvePersonalHomeRuntimeLayout({
      env,
      homeDir: "/home/tester",
      platform: process.platform,
    });
    expect(layout.dataDir).toBe(resolveLightDataDir(env));
    expect(layout.publicFilesDir).toBe(resolveLightFilesDir(env, resolveLightDataDir(env)));
    expect(resolveLocalPrivateFilesDir(env)).toBe(layout.privateFilesDir);
  });

  it("falls back to non-empty legacy HAPPY_* paths only when the current HAPPIER_* name is absent", () => {
    const env: NodeJS.ProcessEnv = {
      HAPPY_SERVER_LIGHT_DATA_DIR: "/legacy/data",
      HAPPY_SERVER_LIGHT_FILES_DIR: "/legacy/files",
      HAPPIER_SERVER_LIGHT_FILES_DIR: "",
    };

    expect(resolveLightDataDir(env)).toBe("/legacy/data");
    // An explicitly empty current value resolves to the default rather than the legacy alias.
    expect(resolveLightFilesDir(env, resolveLightDataDir(env))).toBe("/legacy/data/files");

    applyLightDefaultEnv(env);
    expect(env.HAPPIER_SERVER_LIGHT_FILES_DIR).toBe("/legacy/data/files");
    expect(env.HAPPY_SERVER_LIGHT_FILES_DIR).toBe("/legacy/data/files");
  });

  it("applyLightDefaultEnv expands ~ in explicit light path overrides", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/Users/tester",
      HAPPY_SERVER_LIGHT_DATA_DIR: "~/server-light",
      HAPPY_SERVER_LIGHT_FILES_DIR: "~/server-light-files",
      HAPPY_SERVER_LIGHT_DB_DIR: "~/server-light-db",
    };

    applyLightDefaultEnv(env, { homedir: "/home/ignored" });

    expect(env.HAPPY_SERVER_LIGHT_DATA_DIR).toBe("/Users/tester/server-light");
    expect(env.HAPPY_SERVER_LIGHT_FILES_DIR).toBe("/Users/tester/server-light-files");
    expect(env.HAPPY_SERVER_LIGHT_DB_DIR).toBe("/Users/tester/server-light-db");
  });

  it("resolveLightSqliteDatabaseUrl includes canonical sqlite URL params", () => {
    expect(resolveLightSqliteDatabaseUrl("/tmp/happier-data", "linux", {})).toBe(
      "file:/tmp/happier-data/happier-server-light.sqlite?socket_timeout=30&connection_limit=1",
    );
  });

  it("resolveLightSqliteDatabaseUrl honors explicit sqlite connection limit env", () => {
    const render = resolveLightSqliteDatabaseUrl as (
      dataDir: string,
      platform?: NodeJS.Platform,
      env?: NodeJS.ProcessEnv,
    ) => string;

    expect(render("/tmp/happier-data", "linux", { HAPPIER_SQLITE_CONNECTION_LIMIT: "2" })).toBe(
      "file:/tmp/happier-data/happier-server-light.sqlite?socket_timeout=30&connection_limit=2",
    );
  });

  it("resolveLightSqliteDatabaseUrl ignores the PostgreSQL connection limit env", () => {
    const render = resolveLightSqliteDatabaseUrl as (
      dataDir: string,
      platform?: NodeJS.Platform,
      env?: NodeJS.ProcessEnv,
    ) => string;

    expect(render("/tmp/happier-data", "linux", { HAPPIER_DB_CONNECTION_LIMIT: "1" })).toBe(
      "file:/tmp/happier-data/happier-server-light.sqlite?socket_timeout=30&connection_limit=1",
    );
  });

  it("resolveLightSqliteDatabaseUrl rejects invalid sqlite connection limit env", () => {
    const render = resolveLightSqliteDatabaseUrl as (
      dataDir: string,
      platform?: NodeJS.Platform,
      env?: NodeJS.ProcessEnv,
    ) => string;

    expect(() => render("/tmp/happier-data", "linux", { HAPPIER_SQLITE_CONNECTION_LIMIT: "0" })).toThrow(
      /HAPPIER_SQLITE_CONNECTION_LIMIT/i,
    );
  });

  it("applyLightDefaultEnv falls back to default port when PORT is invalid", () => {
    const env: NodeJS.ProcessEnv = { PORT: "oops" };
    applyLightDefaultEnv(env, { homedir: "/home/test" });
    expect(env.PUBLIC_URL).toBe("http://localhost:3005");
  });

  it("applyLightDefaultEnv avoids bunfs homedir defaults", () => {
    const env: NodeJS.ProcessEnv = {};
    applyLightDefaultEnv(env, { homedir: "/$bunfs/root" });
    const expectedBase = join(tmpdir(), "happier-server-light");
    expect(env.HAPPY_SERVER_LIGHT_DATA_DIR).toBe(expectedBase);
    expect(env.HAPPY_SERVER_LIGHT_DB_DIR).toBe(join(expectedBase, "pglite"));
  });

  it("applyPackagedLightRuntimeSqliteDefaults enables sqlite auto-migrate for extracted server binaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "happy-server-packaged-sqlite-"));
    try {
      const binDir = join(root, "artifact");
      const migrationsDir = join(binDir, "prisma", "sqlite", "migrations");
      await mkdir(migrationsDir, { recursive: true });
      const executablePath = join(binDir, "happier-server");
      await writeFile(executablePath, "", "utf8");
      const env: NodeJS.ProcessEnv = {
        HAPPIER_SERVER_LIGHT_DATA_DIR: "/tmp/happier-data",
      };

      applyPackagedLightRuntimeSqliteDefaults(env, { executablePath });

      expect(env.DATABASE_URL).toBe("file:/tmp/happier-data/happier-server-light.sqlite?socket_timeout=30&connection_limit=1");
      expect(env.HAPPIER_SQLITE_AUTO_MIGRATE).toBe("1");
      expect(env.HAPPIER_SQLITE_MIGRATIONS_DIR).toBe(migrationsDir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applyPackagedLightRuntimeSqliteDefaults preserves explicit sqlite runtime overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "happy-server-packaged-sqlite-keep-"));
    try {
      const binDir = join(root, "artifact");
      const migrationsDir = join(binDir, "prisma", "sqlite", "migrations");
      await mkdir(migrationsDir, { recursive: true });
      const executablePath = join(binDir, "happier-server");
      await writeFile(executablePath, "", "utf8");
      const env: NodeJS.ProcessEnv = {
        HAPPIER_SERVER_LIGHT_DATA_DIR: "/tmp/happier-data",
        DATABASE_URL: "file:/custom.sqlite",
        HAPPIER_SQLITE_AUTO_MIGRATE: "0",
        HAPPIER_SQLITE_MIGRATIONS_DIR: "/custom/migrations",
      };

      applyPackagedLightRuntimeSqliteDefaults(env, { executablePath });

      expect(env.DATABASE_URL).toBe("file:/custom.sqlite");
      expect(env.HAPPIER_SQLITE_AUTO_MIGRATE).toBe("0");
      expect(env.HAPPIER_SQLITE_MIGRATIONS_DIR).toBe("/custom/migrations");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ensureHandyMasterSecret persists a generated secret and reuses it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "happy-server-light-"));
    try {
      const env: NodeJS.ProcessEnv = { HAPPY_SERVER_LIGHT_DATA_DIR: dir };
      await ensureHandyMasterSecret(env, { dataDir: dir });
      expect(typeof env.HANDY_MASTER_SECRET).toBe("string");
      const first = env.HANDY_MASTER_SECRET as string;
      expect(first.length).toBeGreaterThan(0);

      // New env should pick up persisted value.
      const env2: NodeJS.ProcessEnv = { HAPPY_SERVER_LIGHT_DATA_DIR: dir };
      await ensureHandyMasterSecret(env2, { dataDir: dir });
      expect(env2.HANDY_MASTER_SECRET).toBe(first);

      const onDisk = (
        await readFile(join(dir, "handy-master-secret.txt"), "utf-8")
      ).trim();
      expect(onDisk).toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads an existing master secret for stopped attestation without creating one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "happier-light-existing-secret-"));
    try {
      const env: NodeJS.ProcessEnv = {};

      await expect(loadExistingHandyMasterSecret(env, { dataDir: dir })).rejects.toThrow(
        /does not exist/u,
      );
      await expect(readFile(join(dir, "handy-master-secret.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      await writeFile(join(dir, "handy-master-secret.txt"), "restored-secret\n", { mode: 0o600 });
      await loadExistingHandyMasterSecret(env, { dataDir: dir });
      expect(env.HANDY_MASTER_SECRET).toBe("restored-secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ensureHandyMasterSecret ensures the data directory exists even when secret is already set", async () => {
    const base = await mkdtemp(join(tmpdir(), "happy-server-light-"));
    const dir = join(base, "data");
    try {
      const env: NodeJS.ProcessEnv = {
        HAPPY_SERVER_LIGHT_DATA_DIR: dir,
        HANDY_MASTER_SECRET: "pre-set",
      };
      await ensureHandyMasterSecret(env, { dataDir: dir });
      expect((await stat(dir)).isDirectory()).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
