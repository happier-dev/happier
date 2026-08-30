import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

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
