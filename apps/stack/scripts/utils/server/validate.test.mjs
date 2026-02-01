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
