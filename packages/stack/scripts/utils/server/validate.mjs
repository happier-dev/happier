import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getComponentRepoDir, getComponentsDir, isHappyMonorepoRoot } from '../paths/paths.mjs';

function isInside(path, dir) {
  const p = resolve(path);
  const d = resolve(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

export function detectServerComponentDirMismatch({ rootDir, serverComponentName, serverDir }) {
  const componentsDir = getComponentsDir(rootDir);

  const other = serverComponentName === 'happy-server-light' ? 'happy-server' : serverComponentName === 'happy-server' ? 'happy-server-light' : null;
  if (!other) {
    return null;
  }

  const expectedRepo = resolve(getComponentRepoDir(rootDir, serverComponentName));
  const otherRepo = resolve(getComponentRepoDir(rootDir, other));
  // Unified server flavors can legitimately share a single repo/dir.
  if (expectedRepo === otherRepo) {
    return null;
  }
  const otherKey = isHappyMonorepoRoot(otherRepo) ? 'happy' : other;
  const otherWts = resolve(componentsDir, '.worktrees', otherKey);

  if (isInside(serverDir, otherRepo) || isInside(serverDir, otherWts)) {
    return { expected: serverComponentName, actual: other, serverDir };
  }

  return null;
}

export function assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir }) {
  const mismatch = detectServerComponentDirMismatch({ rootDir, serverComponentName, serverDir });
  if (!mismatch) {
    return;
  }

  const expectedRepoDir = getComponentRepoDir(rootDir, mismatch.expected);
  const expectedRepoKey = isHappyMonorepoRoot(expectedRepoDir) ? 'happy' : mismatch.expected;

  const hint =
    mismatch.expected === 'happy-server-light'
      ? `Fix: either switch flavor (\`hapsta srv use happy-server\`) or switch the active checkout for happy-server-light (\`hapsta wt use happy-server-light default\` or a worktree under .worktrees/${expectedRepoKey}/).`
      : `Fix: either switch flavor (\`hapsta srv use happy-server-light\`) or switch the active checkout for happy-server (\`hapsta wt use happy-server default\` or a worktree under .worktrees/${expectedRepoKey}/).`;

  throw new Error(
    `[server] server component dir mismatch:\n` +
      `- selected flavor: ${mismatch.expected}\n` +
      `- but HAPPIER_STACK_COMPONENT_DIR_* points inside: ${mismatch.actual}\n` +
      `- path: ${mismatch.serverDir}\n` +
      `${hint}`
  );
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

  // Unified happy-server flavors:
  // - full: prisma/schema.prisma (postgresql)
  // - light: prisma/sqlite/schema.prisma (sqlite) (legacy: prisma/schema.sqlite.prisma)
  if (serverComponentName === 'happy-server-light') {
    for (const sqliteSchemaPath of sqliteSchemaPaths) {
      try {
        const sqliteSchemaText = readFileSync(sqliteSchemaPath, 'utf-8');
        const sqliteProvider = detectPrismaProvider(sqliteSchemaText);
        if (sqliteProvider && sqliteProvider !== 'sqlite') {
          throw new Error(
            `[server] happy-server-light expects Prisma datasource provider \"sqlite\", but found \"${sqliteProvider}\" in:\n` +
              `- ${sqliteSchemaPath}\n` +
              `Fix: point happy-server-light at a checkout that includes sqlite support, or switch server flavor to happy-server.`
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
        `[server] happy-server-light expects Prisma datasource provider \"sqlite\", but found \"${provider}\" in:\n` +
          `- ${schemaPath}\n` +
          `This usually means you're pointing happy-server-light at a postgres-only happy-server checkout/PR.\n` +
          `Fix: either switch server flavor to happy-server, or use a checkout that supports the light flavor (e.g. one that contains prisma/sqlite/schema.prisma or prisma/schema.sqlite.prisma).`
      );
    }
    return;
  }

  if (serverComponentName === 'happy-server' && provider === 'sqlite') {
    throw new Error(
      `[server] happy-server expects Prisma datasource provider \"postgresql\", but found \"sqlite\" in:\n` +
        `- ${schemaPath}\n` +
        `Fix: either switch server flavor to happy-server-light, or point happy-server at the full-server checkout.`
    );
  }
}
