import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function getScriptPath(): string {
  return resolve(__dirname, 'run-server.sh');
}

async function writeFakeYarn(params: Readonly<{ dir: string; logPath: string }>): Promise<string> {
  const yarnPath = join(params.dir, 'yarn');
  const content = `#!/bin/sh
set -e
echo "YARN $@" >> "${params.logPath}"
echo "ENV DATABASE_URL=$DATABASE_URL SQLITE_AUTO=$HAPPIER_SQLITE_AUTO_MIGRATE SQLITE_MIGRATIONS_DIR=$HAPPIER_SQLITE_MIGRATIONS_DIR" >> "${params.logPath}"
if echo "$*" | grep -q "prisma migrate deploy"; then
  echo "migrated"
  exit 0
fi
exit 0
`;
  await writeFile(yarnPath, content, { mode: 0o755 });
  await chmod(yarnPath, 0o755);
  return yarnPath;
}

async function writeFakePackagedRuntime(params: Readonly<{ dir: string; logPath: string }>): Promise<string> {
  const serverPath = join(params.dir, 'happier-server');
  const migrationPath = join(params.dir, 'happier-server-migrate');
  await writeFile(
    serverPath,
    `#!/bin/sh\nset -e\nif [ "\${1:-}" = "--migrate-only" ]; then\n  echo "SQLITE_MIGRATE provider=$HAPPIER_DB_PROVIDER url=$DATABASE_URL" >> "${params.logPath}"\n  exit 0\nfi\necho "SERVER flavor=$HAPPIER_SERVER_FLAVOR provider=$HAPPIER_DB_PROVIDER url=$DATABASE_URL sqlite_auto=$HAPPIER_SQLITE_AUTO_MIGRATE args=$*" >> "${params.logPath}"\n`,
    { mode: 0o755 },
  );
  await writeFile(
    migrationPath,
    `#!/bin/sh
set -e
if [ -n "\${MIGRATION_FAIL_ONCE_FILE:-}" ] && [ ! -f "$MIGRATION_FAIL_ONCE_FILE" ]; then
  : > "$MIGRATION_FAIL_ONCE_FILE"
  echo "P1001: Can't reach database server"
  exit 1
fi
echo "MIGRATE provider=$HAPPIER_DB_PROVIDER url=$DATABASE_URL" >> "${params.logPath}"
`,
    { mode: 0o755 },
  );
  await chmod(serverPath, 0o755);
  await chmod(migrationPath, 0o755);
  return serverPath;
}

async function readLogLines(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

describe('run-server.sh', () => {
  let tmpDir = '';
  let binDir = '';
  let logPath = '';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'happier-run-server-'));
    binDir = join(tmpDir, 'bin');
    logPath = join(tmpDir, 'yarn.log');
    await writeFile(logPath, '', 'utf8');
    await rm(binDir, { recursive: true, force: true });
    await (await import('node:fs/promises')).mkdir(binDir, { recursive: true });
    await writeFakeYarn({ dir: binDir, logPath });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('starts the light flavor when HAPPIER_SERVER_FLAVOR=light', async () => {
    const res = spawnSync('sh', [getScriptPath()], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HAPPIER_SERVER_FLAVOR: 'light',
        HAPPIER_DB_PROVIDER: 'postgres',
        RUN_MIGRATIONS: '0',
      },
      stdio: 'pipe',
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    const lines = await readLogLines(logPath);
    const yarnLines = lines.filter((l) => l.startsWith('YARN '));
    expect(yarnLines.join('\n')).toContain('YARN --cwd apps/server start:light');
  });

  it('runs migrate deploy for postgres then starts full flavor by default', async () => {
    const res = spawnSync('sh', [getScriptPath()], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HAPPIER_DB_PROVIDER: 'postgres',
        RUN_MIGRATIONS: '1',
        MIGRATIONS_MAX_ATTEMPTS: '1',
        MIGRATIONS_RETRY_DELAY_SECONDS: '0',
      },
      stdio: 'pipe',
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    const lines = await readLogLines(logPath);
    const yarnLines = lines.filter((l) => l.startsWith('YARN '));
    expect(yarnLines[0]).toContain('YARN --cwd apps/server prisma migrate deploy --schema prisma/schema.prisma');
    expect(yarnLines[yarnLines.length - 1]).toContain('YARN --cwd apps/server start');
  });

  it('runs migrate deploy with the mysql schema when HAPPIER_DB_PROVIDER=mysql', async () => {
    const res = spawnSync('sh', [getScriptPath()], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HAPPIER_DB_PROVIDER: 'mysql',
        RUN_MIGRATIONS: '1',
        MIGRATIONS_MAX_ATTEMPTS: '1',
        MIGRATIONS_RETRY_DELAY_SECONDS: '0',
      },
      stdio: 'pipe',
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    const lines = await readLogLines(logPath);
    const yarnLines = lines.filter((l) => l.startsWith('YARN '));
    expect(yarnLines[0]).toContain('YARN --cwd apps/server prisma migrate deploy --schema prisma/mysql/schema.prisma');
  });

  it('runs the canonical SQLite deploy command before source-backed server startup', async () => {
    const res = spawnSync('sh', [getScriptPath()], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HAPPIER_SERVER_FLAVOR: 'light',
        HAPPIER_DB_PROVIDER: 'sqlite',
        HAPPIER_SERVER_LIGHT_DATA_DIR: '/data/server-light',
        HAPPIER_SQLITE_AUTO_MIGRATE: '0',
        RUN_MIGRATIONS: '1',
        MIGRATIONS_MAX_ATTEMPTS: '1',
        MIGRATIONS_RETRY_DELAY_SECONDS: '0',
      },
      stdio: 'pipe',
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    const lines = await readLogLines(logPath);
    const yarnLines = lines.filter((l) => l.startsWith('YARN '));
    expect(yarnLines).toHaveLength(2);
    expect(yarnLines[0]).toContain('YARN --cwd apps/server migrate:sqlite:deploy');
    expect(yarnLines[0]).not.toContain('prisma migrate deploy');
    expect(lines.join('\n')).toContain('ENV DATABASE_URL= SQLITE_AUTO=1');
    expect(lines.join('\n')).toContain('SQLITE_AUTO=1');
    expect(lines.join('\n')).toContain(`SQLITE_MIGRATIONS_DIR=${resolve(__dirname, '../prisma/sqlite/migrations')}`);
    expect(yarnLines[1]).toContain('YARN --cwd apps/server start:light');
  });

  it('runs the packaged postgres migration owner before the configured full server', async () => {
    const serverPath = await writeFakePackagedRuntime({ dir: tmpDir, logPath });
    const res = spawnSync('sh', [getScriptPath(), serverPath], {
      env: {
        ...process.env,
        HAPPIER_SERVER_FLAVOR: 'full',
        HAPPIER_DB_PROVIDER: 'postgres',
        DATABASE_URL: 'postgresql://postgres@db/happier',
        RUN_MIGRATIONS: '1',
        MIGRATIONS_MAX_ATTEMPTS: '1',
        MIGRATIONS_RETRY_DELAY_SECONDS: '0',
      },
      stdio: 'pipe',
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(await readLogLines(logPath)).toEqual([
      'MIGRATE provider=postgres url=postgresql://postgres@db/happier',
      'SERVER flavor=full provider=postgres url=postgresql://postgres@db/happier sqlite_auto= args=',
    ]);
  });

  it('delegates packaged SQLite migration to normal server startup', async () => {
    const serverPath = await writeFakePackagedRuntime({ dir: tmpDir, logPath });
    const res = spawnSync('sh', [getScriptPath(), serverPath], {
      env: {
        ...process.env,
        HAPPIER_SERVER_FLAVOR: 'light',
        HAPPIER_DB_PROVIDER: 'sqlite',
        HAPPIER_SERVER_LIGHT_DATA_DIR: '/data/server-light',
        RUN_MIGRATIONS: '1',
      },
      stdio: 'pipe',
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(await readLogLines(logPath)).toEqual([
      'SERVER flavor=light provider=sqlite url= sqlite_auto=1 args=',
    ]);
  });

  it('retries a packaged migration while the database is not reachable', async () => {
    const serverPath = await writeFakePackagedRuntime({ dir: tmpDir, logPath });
    const failOncePath = join(tmpDir, 'migration-failed-once');
    const res = spawnSync('sh', [getScriptPath(), serverPath], {
      env: {
        ...process.env,
        HAPPIER_DB_PROVIDER: 'postgres',
        DATABASE_URL: 'postgresql://postgres@db/happier',
        RUN_MIGRATIONS: '1',
        MIGRATIONS_MAX_ATTEMPTS: '2',
        MIGRATIONS_RETRY_DELAY_SECONDS: '0',
        MIGRATION_FAIL_ONCE_FILE: failOncePath,
      },
      stdio: 'pipe',
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Database not reachable yet; retrying');
    expect(await readLogLines(logPath)).toEqual([
      'MIGRATE provider=postgres url=postgresql://postgres@db/happier',
      'SERVER flavor=full provider=postgres url=postgresql://postgres@db/happier sqlite_auto= args=',
    ]);
  });

  it('runs the packaged pglite migration owner before either preset starts', async () => {
    const serverPath = await writeFakePackagedRuntime({ dir: tmpDir, logPath });
    const res = spawnSync('sh', [getScriptPath(), serverPath], {
      env: {
        ...process.env,
        HAPPIER_SERVER_FLAVOR: 'full',
        HAPPIER_DB_PROVIDER: 'pglite',
        HAPPIER_SERVER_LIGHT_DB_DIR: '/data/pglite',
        RUN_MIGRATIONS: '1',
        MIGRATIONS_MAX_ATTEMPTS: '1',
      },
      stdio: 'pipe',
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(await readLogLines(logPath)).toEqual([
      'MIGRATE provider=pglite url=',
      'SERVER flavor=full provider=pglite url= sqlite_auto= args=',
    ]);
  });

  it('disables normal startup SQLite migration when RUN_MIGRATIONS=0', async () => {
    const serverPath = await writeFakePackagedRuntime({ dir: tmpDir, logPath });
    const res = spawnSync('sh', [getScriptPath(), serverPath], {
      env: {
        ...process.env,
        HAPPIER_SERVER_FLAVOR: 'light',
        HAPPIER_DB_PROVIDER: 'sqlite',
        HAPPIER_SERVER_LIGHT_DATA_DIR: '/data/server-light',
        HAPPIER_SQLITE_AUTO_MIGRATE: '1',
        RUN_MIGRATIONS: '0',
      },
      stdio: 'pipe',
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(await readLogLines(logPath)).toEqual([
      'SERVER flavor=light provider=sqlite url= sqlite_auto=0 args=',
    ]);
  });

  it('honors RUN_MIGRATIONS=0 for a packaged postgres runtime', async () => {
    const serverPath = await writeFakePackagedRuntime({ dir: tmpDir, logPath });
    const res = spawnSync('sh', [getScriptPath(), serverPath], {
      env: {
        ...process.env,
        HAPPIER_SERVER_FLAVOR: 'full',
        HAPPIER_DB_PROVIDER: 'postgres',
        DATABASE_URL: 'postgresql://postgres@db/happier',
        RUN_MIGRATIONS: '0',
      },
      stdio: 'pipe',
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(await readLogLines(logPath)).toEqual([
      'SERVER flavor=full provider=postgres url=postgresql://postgres@db/happier sqlite_auto= args=',
    ]);
  });
});
