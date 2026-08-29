import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolvePrismaClientImportForDbProvider({ serverDir, provider }) {
  const normalizedProvider = String(provider ?? '').trim().toLowerCase();
  if (normalizedProvider === 'postgres' || normalizedProvider === 'postgresql' || normalizedProvider === 'pglite') {
    return '@prisma/client';
  }
  if (normalizedProvider !== 'sqlite' && normalizedProvider !== 'mysql') {
    throw new Error(`Unsupported database provider for Prisma client import: ${normalizedProvider || '<empty>'}`);
  }
  const entrypoint = join(serverDir, 'generated', `${normalizedProvider}-client`, 'index.js');
  if (!existsSync(entrypoint)) {
    throw new Error(`Missing generated Prisma client for ${normalizedProvider}: ${entrypoint}`);
  }
  return pathToFileURL(entrypoint).href;
}
