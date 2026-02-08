import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertServerPrismaProviderMatches } from './validate.mjs';

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

async function withValidateDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'hs-validate-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('assertServerPrismaProviderMatches accepts happier-server-light when schema.prisma is postgresql', async () => {
  await withValidateDir(async (dir) => {
    await writeSchemas({ dir, schemaPrisma: PG_SCHEMA, schemaSqlitePrisma: SQLITE_SCHEMA });
    assert.doesNotThrow(() => assertServerPrismaProviderMatches({ serverComponentName: 'happier-server-light', serverDir: dir }));
  });
});

test('assertServerPrismaProviderMatches rejects happier-server-light when schema.prisma is sqlite', async () => {
  await withValidateDir(async (dir) => {
    await writeSchemas({ dir, schemaPrisma: SQLITE_SCHEMA, schemaSqlitePrisma: SQLITE_SCHEMA });
    assert.throws(() => assertServerPrismaProviderMatches({ serverComponentName: 'happier-server-light', serverDir: dir }));
  });
});

test('assertServerPrismaProviderMatches rejects happier-server when schema.prisma is sqlite', async () => {
  await withValidateDir(async (dir) => {
    await writeSchemas({ dir, schemaPrisma: SQLITE_SCHEMA, schemaSqlitePrisma: null });
    assert.throws(() => assertServerPrismaProviderMatches({ serverComponentName: 'happier-server', serverDir: dir }));
  });
});

test('assertServerPrismaProviderMatches accepts happier-server when schema.prisma is postgresql', async () => {
  await withValidateDir(async (dir) => {
    await writeSchemas({ dir, schemaPrisma: PG_SCHEMA, schemaSqlitePrisma: null });
    assert.doesNotThrow(() => assertServerPrismaProviderMatches({ serverComponentName: 'happier-server', serverDir: dir }));
  });
});

test('assertServerPrismaProviderMatches is a no-op when schema.prisma is missing', async () => {
  await withValidateDir(async (dir) => {
    assert.doesNotThrow(() => assertServerPrismaProviderMatches({ serverComponentName: 'happier-server-light', serverDir: dir }));
  });
});
