import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isUnifiedHappyServerLight } from './flavor_scripts.mjs';

function extractPrismaClient(mod) {
  return mod?.PrismaClient ?? mod?.default?.PrismaClient ?? null;
}

async function importPrismaClientFromFile(path) {
  const mod = await import(pathToFileURL(path).href);
  const PrismaClient = extractPrismaClient(mod);
  if (!PrismaClient) {
    throw new Error(`[prisma] PrismaClient export not found in: ${path}`);
  }
  return PrismaClient;
}

export async function importPrismaClientFromNodeModules({ dir }) {
  const req = createRequire(import.meta.url);
  const resolved = req.resolve('@prisma/client', { paths: [dir] });
  return await importPrismaClientFromFile(resolved);
}

export async function importPrismaClientFromGeneratedSqlite({ dir }) {
  const path = join(dir, 'generated', 'sqlite-client', 'index.js');
  return await importPrismaClientFromFile(path);
}

export async function importPrismaClientForHappyServerLight({ serverDir }) {
  if (isUnifiedHappyServerLight({ serverDir })) {
    return await importPrismaClientFromGeneratedSqlite({ dir: serverDir });
  }
  return await importPrismaClientFromNodeModules({ dir: serverDir });
}

