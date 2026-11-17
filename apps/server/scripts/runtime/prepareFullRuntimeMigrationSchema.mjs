const DATASOURCE_BLOCK = /^(datasource db \{\n(\s*)provider\s*=\s*"[^"]+"\n)(\})/m;

/**
 * The packaged `prisma-migrate` is the Prisma 6.19.2 CLI (see apps/server/scripts/prismaInstallLayout.mjs),
 * which takes the database URL only from the schema's datasource block. The server's Prisma 7 schemas
 * have no `url` (Prisma 7 rejects it), so the server-support artifact stages its migration schemas
 * with `url = env("DATABASE_URL")`; `happier-server-migrate` sets DATABASE_URL for that child.
 *
 * @param {string} schema
 * @returns {string}
 */
export function withPackagedMigrationDatasourceUrl(schema) {
  const match = DATASOURCE_BLOCK.exec(schema);
  if (!match) {
    throw new Error('[server-runtime] migration schema has no provider-only `datasource db` block to receive the URL');
  }
  const [, head, indent, close] = match;
  return schema.replace(DATASOURCE_BLOCK, `${head}${indent}url      = env("DATABASE_URL")\n${close}`);
}
