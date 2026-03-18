import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { commandExists, execOrThrow, resolveYarnCommand, type RunCommand } from './commands.js';

export type StageEntry = {
  sourcePath: string;
  targetPath: string;
};

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

  const normalized = buildDbProviders.toLowerCase();
  const requestedProviders = normalized === 'all'
    ? ['sqlite', 'mysql']
    : normalized
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value === 'sqlite' || value === 'mysql');
  const dedupedProviders = [...new Set(requestedProviders)];

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

  const postgresClientPath = join(repoRoot, 'node_modules', '.prisma', 'client');
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
