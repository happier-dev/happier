import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  importPrismaClientFromNodeModules,
} from './prisma_import.mjs';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function withPrismaFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'hs-prisma-import-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writePrismaNodeModule(dir, body = 'export class PrismaClient {}\n') {
  await mkdir(join(dir, 'node_modules', '@prisma', 'client'), { recursive: true });
  await writeJson(join(dir, 'node_modules', '@prisma', 'client', 'package.json'), {
    name: '@prisma/client',
    type: 'module',
    main: './index.js',
  });
  await writeFile(join(dir, 'node_modules', '@prisma', 'client', 'index.js'), body, 'utf-8');
}

test('importPrismaClientFromNodeModules imports PrismaClient via node_modules resolution', async () => {
  await withPrismaFixture(async (dir) => {
    await writePrismaNodeModule(dir);
    const PrismaClient = await importPrismaClientFromNodeModules({ dir });
    assert.equal(typeof PrismaClient, 'function');
    assert.equal(PrismaClient.name, 'PrismaClient');
  });
});
