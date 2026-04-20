import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { commandExists, execOrThrow, resolveYarnCommand, type RunCommand } from './commands.js';

export type StageEntry = {
  sourcePath: string;
  targetPath: string;
};

export type ServerDbProvider = 'sqlite' | 'mysql';

export function resolveRequestedServerDbProviders(buildDbProviders: string): ServerDbProvider[] {
  const tokens = String(buildDbProviders ?? '')
    .trim()
    .toLowerCase()
    .split(/[|,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (tokens.length === 0 || tokens.includes('all')) {
    return ['sqlite', 'mysql'];
  }

  const requestedProviders = new Set<ServerDbProvider>();
  for (const token of tokens) {
    if (token === 'sqlite') {
      requestedProviders.add('sqlite');
      continue;
    }
    if (token === 'mysql') {
      requestedProviders.add('mysql');
      continue;
    }
    if (token === 'postgres' || token === 'postgresql' || token === 'pglite') {
      continue;
    }
    throw new Error(
      `[component-artifacts] unsupported HAPPIER_BUILD_DB_PROVIDERS token: ${token}. Supported: postgres|postgresql|pglite|mysql|sqlite|all`,
    );
  }

  return [...requestedProviders];
}

async function ensureUiWebDist({
  repoRoot,
  env,
  runCommand,
  commandProbe,
}: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runCommand: RunCommand;
  commandProbe: (cmd: string) => boolean;
}): Promise<string> {
  const uiDistPath = join(repoRoot, 'apps', 'ui', 'dist');
  const existingInfo = await stat(uiDistPath).catch(() => null);
  if (existingInfo?.isDirectory()) {
    return uiDistPath;
  }

  runCommand(process.execPath, ['apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs'], {
    cwd: repoRoot,
    env: {
      ...env,
      CI: env.CI ?? '1',
    },
  });

  const yarn = resolveYarnCommand({ commandProbe });
  runCommand(
    yarn.cmd,
    [...yarn.args, '--cwd', 'apps/ui', '-s', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist'],
    {
      cwd: repoRoot,
      env: {
        ...env,
        CI: env.CI ?? '1',
      },
    },
  );

  const builtInfo = await stat(uiDistPath).catch(() => null);
  if (!builtInfo?.isDirectory()) {
    throw new Error(`[component-artifacts] missing ui web dist directory: ${uiDistPath}`);
  }
  return uiDistPath;
}

export async function resolveServerBinarySidecarEntries({
  repoRoot,
  buildDbProviders = String(process.env.HAPPIER_BUILD_DB_PROVIDERS ?? process.env.HAPPY_BUILD_DB_PROVIDERS ?? 'all').trim() || 'all',
  env = process.env,
  runCommand = execOrThrow,
  commandProbe = commandExists,
}: {
  repoRoot: string;
  buildDbProviders?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
}): Promise<StageEntry[]> {
  const dedupedProviders = resolveRequestedServerDbProviders(buildDbProviders);
  const yarn = resolveYarnCommand({ commandProbe });
  runCommand(
    yarn.cmd,
    [...yarn.args, '--cwd', 'apps/server', '-s', 'generate:providers'],
    {
      cwd: repoRoot,
      env: {
        ...env,
        HAPPIER_BUILD_DB_PROVIDERS: buildDbProviders,
        HAPPY_BUILD_DB_PROVIDERS: buildDbProviders,
      },
    },
  );

  const postgresClientPath = join(repoRoot, 'node_modules', '.prisma', 'client');
  const entries: StageEntry[] = [];
  for (const provider of dedupedProviders) {
    const sourcePath = join(repoRoot, 'apps', 'server', 'generated', `${provider}-client`);
    const info = await stat(sourcePath).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`[component-artifacts] missing generated Prisma directory for provider ${provider}: ${sourcePath}`);
    }
    entries.push({
      sourcePath,
      targetPath: join('generated', `${provider}-client`),
    });
  }

  if (dedupedProviders.includes('sqlite')) {
    const migrationsPath = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const migrationsInfo = await stat(migrationsPath).catch(() => null);
    if (!migrationsInfo?.isDirectory()) {
      throw new Error(`[component-artifacts] missing sqlite migrations directory: ${migrationsPath}`);
    }
    entries.push({
      sourcePath: migrationsPath,
      targetPath: join('prisma', 'sqlite', 'migrations'),
    });
  }

  const uiDistPath = await ensureUiWebDist({
    repoRoot,
    env,
    runCommand,
    commandProbe,
  });
  entries.push({
    sourcePath: uiDistPath,
    targetPath: join('ui-web', 'current'),
  });

  const postgresClientInfo = await stat(postgresClientPath).catch(() => null);
  if (!postgresClientInfo?.isDirectory()) {
    throw new Error(`[component-artifacts] missing generated postgres Prisma client directory: ${postgresClientPath}`);
  }
  entries.push({
    sourcePath: postgresClientPath,
    targetPath: join('node_modules', '.prisma', 'client'),
  });

  const prismaClientPackagePath = join(repoRoot, 'node_modules', '@prisma', 'client');
  const prismaClientPackageInfo = await stat(prismaClientPackagePath).catch(() => null);
  if (!prismaClientPackageInfo?.isDirectory()) {
    throw new Error(`[component-artifacts] missing @prisma/client package directory: ${prismaClientPackagePath}`);
  }
  entries.push({
    sourcePath: prismaClientPackagePath,
    targetPath: join('node_modules', '@prisma', 'client'),
  });

  return entries;
}
