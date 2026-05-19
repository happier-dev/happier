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

  let schemaText = '';
  try {
    schemaText = readFileSync(schemaPath, 'utf-8');
  } catch {
    // If it doesn't exist, skip validation; not every server component necessarily uses Prisma.
    return;
  }

  const provider = detectPrismaProvider(schemaText);
  if (!provider) return;

  // Happier server-light supports SQLite by default and still supports explicit PGlite opt-in.
  if (serverComponentName === 'happier-server-light') {
    if (provider !== 'postgresql' && provider !== 'sqlite') {
      throw new Error(
        `[server] happier-server-light expects Prisma datasource provider \"sqlite\" or \"postgresql\", but found \"${provider}\" in:\n` +
          `- ${schemaPath}\n` +
          `Fix: point happier-server-light at a checkout that includes the current light flavor implementation.`
      );
    }
    return;
  }

  if (serverComponentName === 'happier-server' && provider === 'sqlite') {
    throw new Error(
      `[server] happier-server expects Prisma datasource provider \"postgresql\", but found \"sqlite\" in:\n` +
        `- ${schemaPath}\n` +
        `Fix: point happier-server at a checkout that uses the Postgres schema.`
    );
  }
}
