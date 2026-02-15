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
echo "ENV DATABASE_URL=$DATABASE_URL" >> "${params.logPath}"
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

  it('runs migrate deploy for sqlite and derives DATABASE_URL from HAPPIER_SERVER_LIGHT_DATA_DIR when missing', async () => {
    const res = spawnSync('sh', [getScriptPath()], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HAPPIER_SERVER_FLAVOR: 'light',
        HAPPIER_DB_PROVIDER: 'sqlite',
        HAPPIER_SERVER_LIGHT_DATA_DIR: '/data/server-light',
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
    expect(yarnLines[0]).toContain('YARN --cwd apps/server prisma migrate deploy --schema prisma/sqlite/schema.prisma');
    expect(lines.join('\n')).toContain('ENV DATABASE_URL=file:/data/server-light/happier-server-light.sqlite');
    expect(yarnLines[yarnLines.length - 1]).toContain('YARN --cwd apps/server start:light');
  });
});
