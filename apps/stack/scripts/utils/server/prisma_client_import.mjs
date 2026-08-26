import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolvePrismaClientImportForDbProvider({ serverDir, provider }) {
  const normalizedProvider = String(provider ?? '').trim().toLowerCase();
  const entrypoint = normalizedProvider === 'sqlite'
    ? join(serverDir, 'generated', 'sqlite-client', 'index.js')
    : normalizedProvider === 'mysql'
      ? join(serverDir, 'generated', 'mysql-client', 'index.js')
      : '';
  if (entrypoint && existsSync(entrypoint)) return pathToFileURL(entrypoint).href;
  return '@prisma/client';
}
