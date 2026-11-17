import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { resolveServerPrismaInstallLayout } from '../../../server/scripts/prismaInstallLayout.mjs';

/** The server's Prisma generator (apps/server/scripts/generateClients.ts) writes
 * each client from one schema and stamps it with the sha256 of that schema. */
export const SERVER_GENERATED_CLIENTS = Object.freeze([
  { schema: 'apps/server/prisma/schema.prisma' },
  { schema: 'apps/server/prisma/sqlite/schema.prisma', client: 'apps/server/generated/sqlite-client' },
  { schema: 'apps/server/prisma/mysql/schema.prisma', client: 'apps/server/generated/mysql-client' },
]);
export const SERVER_GENERATED_CLIENT_STAMP = '.happier-source-schema.sha256';

/** Resolve output placement through the server owner, including borrowed installations. */
export function resolveServerGeneratedClients({ repoDir, sourceDir = repoDir }) {
  const requireFromServer = createRequire(join(sourceDir, 'apps/server/package.json'));
  return SERVER_GENERATED_CLIENTS.map(entry => ({
    schema: entry.schema,
    client: entry.client ?? relative(repoDir, resolveServerPrismaInstallLayout({
      serverRoot: join(repoDir, 'apps/server'), resolveInstalledPath: specifier => requireFromServer.resolve(specifier),
    }).defaultClientDir).split('\\').join('/'),
  }));
}

/**
 * The one reuse rule for generated server clients: a client serves a tree only
 * while its stamp names that tree's schema bytes. Readers are synchronous and
 * return bytes or null (`readSchema` from the judged tree, `readStamp` from where
 * the candidate client lives), so build captures and Git-tree checks share it.
 * @returns {string[]} the client directories that do not match
 */
export function readStaleServerGeneratedClients({ readSchema, readStamp,
  repoDir, clients }) {
  const stale = [];
  for (const entry of SERVER_GENERATED_CLIENTS) {
    const { schema } = entry;
    const source = readSchema(schema);
    if (!source) continue;
    clients ??= resolveServerGeneratedClients({ repoDir });
    const { client } = clients.find(candidate => candidate.schema === schema);
    const stamp = readStamp(`${client}/${SERVER_GENERATED_CLIENT_STAMP}`);
    if (stamp?.toString('utf8').trim() !== createHash('sha256').update(source).digest('hex')) stale.push(client);
  }
  return stale;
}
