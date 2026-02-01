import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  importPrismaClientForHappyServerLight,
  importPrismaClientFromGeneratedSqlite,
  importPrismaClientFromNodeModules,
} from './prisma_import.mjs';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

test('importPrismaClientFromNodeModules imports PrismaClient via node_modules resolution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-prisma-import-'));
  try {
    await mkdir(join(dir, 'node_modules', '@prisma', 'client'), { recursive: true });
    await writeJson(join(dir, 'node_modules', '@prisma', 'client', 'package.json'), { name: '@prisma/client', type: 'module', main: './index.js' });
    await writeFile(join(dir, 'node_modules', '@prisma', 'client', 'index.js'), 'export class PrismaClient {}\n', 'utf-8');

    const PrismaClient = await importPrismaClientFromNodeModules({ dir });
    assert.equal(typeof PrismaClient, 'function');
    assert.equal(PrismaClient.name, 'PrismaClient');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('importPrismaClientFromGeneratedSqlite imports PrismaClient from generated/sqlite-client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-prisma-import-'));
  try {
    await writeJson(join(dir, 'package.json'), { type: 'module' });
    await mkdir(join(dir, 'generated', 'sqlite-client'), { recursive: true });
    await writeFile(join(dir, 'generated', 'sqlite-client', 'index.js'), 'export class PrismaClient {}\n', 'utf-8');

    const PrismaClient = await importPrismaClientFromGeneratedSqlite({ dir });
    assert.equal(typeof PrismaClient, 'function');
    assert.equal(PrismaClient.name, 'PrismaClient');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('importPrismaClientForHappyServerLight prefers generated sqlite client when prisma/sqlite/schema.prisma exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-prisma-import-'));
  try {
    await writeJson(join(dir, 'package.json'), { type: 'module' });
    await mkdir(join(dir, 'prisma', 'sqlite'), { recursive: true });
    await writeFile(join(dir, 'prisma', 'sqlite', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');

    await mkdir(join(dir, 'generated', 'sqlite-client'), { recursive: true });
    await writeFile(join(dir, 'generated', 'sqlite-client', 'index.js'), 'export class PrismaClient {}\n', 'utf-8');

    // Also create a node_modules PrismaClient, but unified should prefer generated.
    await mkdir(join(dir, 'node_modules', '@prisma', 'client'), { recursive: true });
    await writeJson(join(dir, 'node_modules', '@prisma', 'client', 'package.json'), { name: '@prisma/client', type: 'module', main: './index.js' });
    await writeFile(join(dir, 'node_modules', '@prisma', 'client', 'index.js'), 'export class PrismaClient { static which = "node_modules"; }\n', 'utf-8');

    const PrismaClient = await importPrismaClientForHappyServerLight({ serverDir: dir });
    assert.equal(typeof PrismaClient, 'function');
    assert.equal(PrismaClient.name, 'PrismaClient');
    // If we imported node_modules we'd have this static property.
    assert.equal(PrismaClient.which, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
