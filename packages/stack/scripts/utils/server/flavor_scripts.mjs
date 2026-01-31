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

export function isUnifiedHappyServerLight({ serverDir }) {
  return (
    existsSync(join(serverDir, 'prisma', 'sqlite', 'schema.prisma')) ||
    existsSync(join(serverDir, 'prisma', 'schema.sqlite.prisma'))
  );
}

export function resolveServerLightPrismaSchemaArgs({ serverDir }) {
  if (existsSync(join(serverDir, 'prisma', 'sqlite', 'schema.prisma'))) {
    return ['--schema', 'prisma/sqlite/schema.prisma'];
  }
  if (existsSync(join(serverDir, 'prisma', 'schema.sqlite.prisma'))) {
    return ['--schema', 'prisma/schema.sqlite.prisma'];
  }
  return [];
}

export function resolveServerLightPrismaMigrateDeployArgs({ serverDir }) {
  return ['migrate', 'deploy', ...resolveServerLightPrismaSchemaArgs({ serverDir })];
}

export function resolveServerLightPrismaClientImport({ serverDir }) {
  if (!isUnifiedHappyServerLight({ serverDir })) {
    return '@prisma/client';
  }
  const clientPath = join(serverDir, 'generated', 'sqlite-client', 'index.js');
  return pathToFileURL(clientPath).href;
}

export function resolvePrismaClientImportForServerComponent({ serverComponentName, serverComponent, serverDir }) {
  const name = serverComponentName ?? serverComponent;
  if (name === 'happy-server-light') {
    return resolveServerLightPrismaClientImport({ serverDir });
  }
  return '@prisma/client';
}

export function resolveServerDevScript({ serverComponentName, serverDir, prismaPush }) {
  const scripts = readScripts(serverDir);

  if (serverComponentName === 'happy-server') {
    return 'start';
  }

  if (serverComponentName === 'happy-server-light') {
    const unified = isUnifiedHappyServerLight({ serverDir });
    if (unified) {
      // Server-light now relies on deterministic migrations (not db push).
      // Prefer the dedicated dev script that runs migrate deploy before starting.
      if (hasScript(scripts, 'dev:light')) {
        return 'dev:light';
      }
      // Fallback: no dev script, run the light start script.
      return hasScript(scripts, 'start:light') ? 'start:light' : 'start';
    }

    // Legacy behavior: prefer `dev` for older happy-server-light checkouts.
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

  if (serverComponentName === 'happy-server-light') {
    const unified = isUnifiedHappyServerLight({ serverDir });
    if (unified && hasScript(scripts, 'start:light')) {
      return 'start:light';
    }
  }

  return 'start';
}
