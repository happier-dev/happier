import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function detectServerComponentDirMismatch({ rootDir, serverComponentName, serverDir }) {
  // Repo-only model: server flavors share the same monorepo checkout/worktree.
  // The previous "mismatch" check was specific to the legacy multi-repo components layout.
  void rootDir;
  void serverComponentName;
  void serverDir;
  return null;
}

export function assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir }) {
  void rootDir;
  void serverComponentName;
  void serverDir;
}

function detectPrismaProvider(schemaText) {
  // Best-effort parse of:
  // datasource db { provider = "sqlite" ... }
  const m = schemaText.match(/datasource\s+db\s*\{[\s\S]*?\bprovider\s*=\s*\"([a-zA-Z0-9_-]+)\"/m);
  return m?.[1] ?? '';
}

export function assertServerPrismaProviderMatches({ serverComponentName, serverDir }) {
  const schemaPath = join(serverDir, 'prisma', 'schema.prisma');
  const sqliteSchemaPaths = [
    join(serverDir, 'prisma', 'sqlite', 'schema.prisma'),
    join(serverDir, 'prisma', 'schema.sqlite.prisma'),
  ];

  let schemaText = '';
  try {
    schemaText = readFileSync(schemaPath, 'utf-8');
  } catch {
    // If it doesn't exist, skip validation; not every server component necessarily uses Prisma.
    return;
  }

  const provider = detectPrismaProvider(schemaText);
  if (!provider) return;

  // Unified happier-server flavors:
  // - full: prisma/schema.prisma (postgresql)
  // - light: prisma/sqlite/schema.prisma (sqlite) (legacy: prisma/schema.sqlite.prisma)
  if (serverComponentName === 'happier-server-light') {
    for (const sqliteSchemaPath of sqliteSchemaPaths) {
      try {
        const sqliteSchemaText = readFileSync(sqliteSchemaPath, 'utf-8');
        const sqliteProvider = detectPrismaProvider(sqliteSchemaText);
        if (sqliteProvider && sqliteProvider !== 'sqlite') {
          throw new Error(
            `[server] happier-server-light expects Prisma datasource provider \"sqlite\", but found \"${sqliteProvider}\" in:\n` +
              `- ${sqliteSchemaPath}\n` +
              `Fix: point happier-server-light at a checkout that includes sqlite support, or switch server flavor to happier-server.`
          );
        }
        if (sqliteProvider === 'sqlite') {
          return;
        }
        // Exists, but could not parse provider: keep checking other variants and fall through to legacy behavior.
      } catch {
        // missing/unreadable: try other variants and then fall through to legacy behavior below
      }
    }

    if (provider !== 'sqlite') {
      throw new Error(
        `[server] happier-server-light expects Prisma datasource provider \"sqlite\", but found \"${provider}\" in:\n` +
          `- ${schemaPath}\n` +
          `This usually means you're pointing happier-server-light at a postgres-only happier-server checkout/PR.\n` +
          `Fix: either switch server flavor to happier-server, or use a checkout that supports the light flavor (e.g. one that contains prisma/sqlite/schema.prisma or prisma/schema.sqlite.prisma).`
      );
    }
    return;
  }

  if (serverComponentName === 'happier-server' && provider === 'sqlite') {
    throw new Error(
      `[server] happier-server expects Prisma datasource provider \"postgresql\", but found \"sqlite\" in:\n` +
        `- ${schemaPath}\n` +
        `Fix: either switch server flavor to happier-server-light, or point happier-server at the full-server checkout.`
    );
  }
}
