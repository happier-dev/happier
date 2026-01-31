import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertServerPrismaProviderMatches, detectServerComponentDirMismatch } from './validate.mjs';

const PG_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`.trim();

const SQLITE_SCHEMA = `
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
`.trim();

async function writeSchemas({ dir, schemaPrisma, schemaSqlitePrisma }) {
  const prismaDir = join(dir, 'prisma');
  await mkdir(prismaDir, { recursive: true });
  if (schemaPrisma != null) {
    await writeFile(join(prismaDir, 'schema.prisma'), schemaPrisma + '\n', 'utf-8');
  }
  if (schemaSqlitePrisma != null) {
    await mkdir(join(prismaDir, 'sqlite'), { recursive: true });
    await writeFile(join(prismaDir, 'sqlite', 'schema.prisma'), schemaSqlitePrisma + '\n', 'utf-8');
  }
}

test('assertServerPrismaProviderMatches accepts unified light flavor (prisma/sqlite/schema.prisma)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-validate-'));
  try {
    await writeSchemas({ dir, schemaPrisma: PG_SCHEMA, schemaSqlitePrisma: SQLITE_SCHEMA });
    assert.doesNotThrow(() => assertServerPrismaProviderMatches({ serverComponentName: 'happy-server-light', serverDir: dir }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assertServerPrismaProviderMatches rejects happy-server-light when only postgres schema exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-validate-'));
  try {
    await writeSchemas({ dir, schemaPrisma: PG_SCHEMA, schemaSqlitePrisma: null });
    assert.throws(() => assertServerPrismaProviderMatches({ serverComponentName: 'happy-server-light', serverDir: dir }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assertServerPrismaProviderMatches rejects happy-server when schema.prisma is sqlite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-validate-'));
  try {
    await writeSchemas({ dir, schemaPrisma: SQLITE_SCHEMA, schemaSqlitePrisma: null });
    assert.throws(() => assertServerPrismaProviderMatches({ serverComponentName: 'happy-server', serverDir: dir }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detectServerComponentDirMismatch allows unified happy-server-light pointing at happy-server dir', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'hs-validate-root-'));
  const envKeys = ['HAPPIER_STACK_WORKSPACE_DIR', 'HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER', 'HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER_LIGHT'];
  const old = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  try {
    process.env.HAPPIER_STACK_WORKSPACE_DIR = rootDir;
    const unifiedDir = join(rootDir, 'components', 'happy-server');
    await mkdir(unifiedDir, { recursive: true });
    process.env.HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER = unifiedDir;
    process.env.HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER_LIGHT = unifiedDir;

    const mismatch = detectServerComponentDirMismatch({
      rootDir,
      serverComponentName: 'happy-server-light',
      serverDir: unifiedDir,
    });
    assert.equal(mismatch, null);
  } finally {
    for (const k of envKeys) {
      if (old[k] == null) delete process.env[k];
      else process.env[k] = old[k];
    }
    await rm(rootDir, { recursive: true, force: true });
  }
});
