import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function readScripts(serverDir) {
  try {
    const pkgPath = join(serverDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    return scripts;
  } catch {
    return {};
  }
}

function hasScript(scripts, name) {
  return typeof scripts?.[name] === 'string' && scripts[name].trim().length > 0;
}

function detectServerLightDbFlavor({ serverDir }) {
  const scripts = readScripts(serverDir);
  if (hasScript(scripts, 'migrate:light:deploy')) {
    // Current Happier "light" flavor uses embedded Postgres via PGlite.
    return 'pglite';
  }
  // Legacy SQLite-era layouts (kept for old checkouts and potential future reintroduction).
  if (existsSync(join(serverDir, 'prisma', 'sqlite', 'schema.prisma'))) return 'sqlite';
  if (existsSync(join(serverDir, 'prisma', 'schema.sqlite.prisma'))) return 'sqlite';
  return 'unknown';
}

export function isUnifiedHappyServerLight({ serverDir }) {
  // "Unified" means the monorepo server package supports a first-class light flavor.
  // Today that is PGlite-based.
  return detectServerLightDbFlavor({ serverDir }) === 'pglite';
}

export function resolveServerLightPrismaSchemaArgs({ serverDir }) {
  const flavor = detectServerLightDbFlavor({ serverDir });
  if (flavor === 'pglite') {
    // Light flavor uses the main Postgres schema.
    return ['--schema', 'prisma/schema.prisma'];
  }
  if (flavor === 'sqlite') {
    if (existsSync(join(serverDir, 'prisma', 'sqlite', 'schema.prisma'))) {
      return ['--schema', 'prisma/sqlite/schema.prisma'];
    }
    if (existsSync(join(serverDir, 'prisma', 'schema.sqlite.prisma'))) {
      return ['--schema', 'prisma/schema.sqlite.prisma'];
    }
  }
  return [];
}

export function resolveServerLightPrismaMigrateDeployArgs({ serverDir }) {
  return ['migrate', 'deploy', ...resolveServerLightPrismaSchemaArgs({ serverDir })];
}

export function resolveServerLightPrismaClientImport({ serverDir }) {
  const flavor = detectServerLightDbFlavor({ serverDir });
  if (flavor === 'pglite') {
    // Light flavor uses the standard Postgres Prisma client (schema.prisma).
    return '@prisma/client';
  }
  if (flavor === 'sqlite') {
    const clientPath = join(serverDir, 'generated', 'sqlite-client', 'index.js');
    return pathToFileURL(clientPath).href;
  }
  return '@prisma/client';
}

export function resolvePrismaClientImportForServerComponent({ serverComponentName, serverComponent, serverDir }) {
  const name = serverComponentName ?? serverComponent;
  if (name === 'happier-server-light') {
    return resolveServerLightPrismaClientImport({ serverDir });
  }
  return '@prisma/client';
}

function resolveGeneratedClientEntrypoint({ serverDir, provider }) {
  const p = String(provider ?? '').trim().toLowerCase();
  if (p === 'sqlite') {
    return join(serverDir, 'generated', 'sqlite-client', 'index.js');
  }
  if (p === 'mysql') {
    return join(serverDir, 'generated', 'mysql-client', 'index.js');
  }
  return '';
}

export function resolvePrismaClientImportForDbProvider({ serverDir, provider }) {
  const entry = resolveGeneratedClientEntrypoint({ serverDir, provider });
  if (entry && existsSync(entry)) {
    return pathToFileURL(entry).href;
  }
  // postgres + pglite share the default Prisma client.
  return '@prisma/client';
}

export function resolveServerDevScript({ serverComponentName, serverDir, prismaPush }) {
  const scripts = readScripts(serverDir);

  if (serverComponentName === 'happier-server') {
    return 'start';
  }

  if (serverComponentName === 'happier-server-light') {
    // Prefer the dedicated dev script that ensures migrations are applied before starting.
    if (hasScript(scripts, 'dev:light')) {
      return 'dev:light';
    }
    // Fallback: no dev script, run the light start script.
    if (hasScript(scripts, 'start:light')) {
      return 'start:light';
    }

    // Legacy behavior: prefer `dev` for older server-light checkouts.
    if (prismaPush) {
      return hasScript(scripts, 'dev') ? 'dev' : 'start';
    }
    return hasScript(scripts, 'start') ? 'start' : 'dev';
  }

  // Unknown: be conservative.
  return 'start';
}

export function resolveServerStartScript({ serverComponentName, serverDir }) {
  const scripts = readScripts(serverDir);

  if (serverComponentName === 'happier-server-light') {
    if (hasScript(scripts, 'start:light')) {
      return 'start:light';
    }
  }

  return 'start';
}
