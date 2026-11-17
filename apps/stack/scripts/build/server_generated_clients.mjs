import { createHash } from 'node:crypto';

/** The server's Prisma generator (apps/server/scripts/generateClients.ts) writes
 * each client from one schema and stamps it with the sha256 of that schema. */
export const SERVER_GENERATED_CLIENTS = Object.freeze([
  { schema: 'apps/server/prisma/schema.prisma', client: 'apps/server/node_modules/.prisma/client' },
  { schema: 'apps/server/prisma/sqlite/schema.prisma', client: 'apps/server/generated/sqlite-client' },
  { schema: 'apps/server/prisma/mysql/schema.prisma', client: 'apps/server/generated/mysql-client' },
]);
export const SERVER_GENERATED_CLIENT_STAMP = '.happier-source-schema.sha256';

/**
 * The one reuse rule for generated server clients: a client serves a tree only
 * while its stamp names that tree's schema bytes. Readers are synchronous and
 * return bytes or null (`readSchema` from the judged tree, `readStamp` from where
 * the candidate client lives), so build captures and Git-tree checks share it.
 * @returns {string[]} the client directories that do not match
 */
export function readStaleServerGeneratedClients({ readSchema, readStamp }) {
  const stale = [];
  for (const { schema, client } of SERVER_GENERATED_CLIENTS) {
    const source = readSchema(schema);
    if (!source) continue;
    const stamp = readStamp(`${client}/${SERVER_GENERATED_CLIENT_STAMP}`);
    if (stamp?.toString('utf8').trim() !== createHash('sha256').update(source).digest('hex')) stale.push(client);
  }
  return stale;
}
