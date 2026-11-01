import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { commandExists, execOrThrow, resolveYarnCommand, type RunCommand } from './commands.js';
import { resolveServerBuildDbProviders } from './serverBuildDbProviders.js';
import type { BinaryTarget } from './targets.js';
import { resolveSharpRuntimeSidecarEntries } from './sharpRuntimeSidecars.js';

export type StageEntry = {
  sourcePath: string;
  targetPath: string;
};

export type ServerDbProvider = 'sqlite' | 'mysql';
export type ServerComponent = 'happier-server' | 'happier-server-light';


export function resolveRequestedServerDbProviders(buildDbProviders: string): ServerDbProvider[] {
  return [...resolveServerBuildDbProviders(buildDbProviders)]
    .filter((provider): provider is ServerDbProvider => provider === 'sqlite' || provider === 'mysql');
}

export function resolvePrismaSchemaEngineTarget(target: BinaryTarget): { binaryTarget: string; fileName: string } {
  const targetKey = `${target.os}-${target.arch}`;
  switch (targetKey) {
    case 'linux-x64':
      return { binaryTarget: 'debian-openssl-3.0.x', fileName: 'schema-engine-debian-openssl-3.0.x' };
    case 'linux-arm64':
      return { binaryTarget: 'linux-arm64-openssl-3.0.x', fileName: 'schema-engine-linux-arm64-openssl-3.0.x' };
    case 'darwin-x64':
      return { binaryTarget: 'darwin', fileName: 'schema-engine-darwin' };
    case 'darwin-arm64':
      return { binaryTarget: 'darwin-arm64', fileName: 'schema-engine-darwin-arm64' };
    case 'windows-x64':
      return { binaryTarget: 'windows', fileName: 'schema-engine-windows.exe' };
    default:
      throw new Error(`[component-artifacts] unsupported Prisma schema engine target: ${targetKey}`);
  }
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
  runCommand(process.execPath, ['apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs'], {
    cwd: repoRoot,
    env: {
      ...env,
      CI: env.CI ?? '1',
      EXPO_UNSTABLE_WEB_MODAL: '1',
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
        EXPO_UNSTABLE_WEB_MODAL: '1',
      },
    },
  );

  const builtInfo = await stat(uiDistPath).catch(() => null);
  if (!builtInfo?.isDirectory()) {
    throw new Error(`[component-artifacts] missing ui web dist directory: ${uiDistPath}`);
  }
  runCommand(process.execPath, ['scripts/pipeline/release/precompress-ui-web-assets.mjs', '--dir', 'apps/ui/dist'], {
    cwd: repoRoot,
    env: {
      ...env,
      CI: env.CI ?? '1',
      EXPO_UNSTABLE_WEB_MODAL: '1',
    },
  });
  return uiDistPath;
}

export async function resolveServerBinarySidecarEntries({
  repoRoot,
  target,
  serverComponent = 'happier-server-light',
  buildDbProviders = String(process.env.HAPPIER_BUILD_DB_PROVIDERS ?? process.env.HAPPY_BUILD_DB_PROVIDERS ?? 'all').trim() || 'all',
  env = process.env,
  runCommand = execOrThrow,
  commandProbe = commandExists,
}: {
  repoRoot: string;
  target?: BinaryTarget;
  serverComponent?: ServerComponent;
  buildDbProviders?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
}): Promise<StageEntry[]> {
  const yarn = resolveYarnCommand({ commandProbe });
  const requestedBuildDbProviders = [...resolveServerBuildDbProviders(buildDbProviders)].join('|');
  runCommand(
    yarn.cmd,
    [...yarn.args, '--cwd', 'apps/server', '-s', 'generate:providers'],
    {
      cwd: repoRoot,
      env: {
        ...env,
        HAPPIER_BUILD_DB_PROVIDERS: requestedBuildDbProviders,
        HAPPY_BUILD_DB_PROVIDERS: requestedBuildDbProviders,
      },
    },
  );

  if (!target) {
    throw new Error('[component-artifacts] a binary target is required for server migration artifacts');
  }
  const schemaEngine = resolvePrismaSchemaEngineTarget(target);
  runCommand(
    process.execPath,
    [
      'apps/server/scripts/runtime/prepareFullRuntimeMigrationEngine.mjs',
      '--binary-target', schemaEngine.binaryTarget,
      '--out-dir', join(
        repoRoot,
        'apps',
        'server',
        'generated',
        'runtime-migration-engines',
        `${target.os}-${target.arch}`,
      ),
    ],
    { cwd: repoRoot, env },
  );

  const buildProviders = resolveServerBuildDbProviders(buildDbProviders);
  const dedupedProviders = resolveRequestedServerDbProviders(buildDbProviders);

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

  {
    const requiredMigrationEntries: StageEntry[] = [
      {
        sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'schema.prisma'),
        targetPath: join('prisma', 'schema.prisma'),
      },
      {
        sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'migrations'),
        targetPath: join('prisma', 'migrations'),
      },
    ];
    if (buildProviders.has('mysql')) {
      requiredMigrationEntries.push(
        {
          sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'mysql', 'schema.prisma'),
          targetPath: join('prisma', 'mysql', 'schema.prisma'),
        },
        {
          sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'mysql', 'migrations'),
          targetPath: join('prisma', 'mysql', 'migrations'),
        },
      );
    }
    for (const entry of requiredMigrationEntries) {
      const info = await stat(entry.sourcePath).catch(() => null);
      if (!info) {
        throw new Error(`[component-artifacts] missing server migration input: ${entry.sourcePath}`);
      }
      entries.push(entry);
    }

    const targetKey = `${target.os}-${target.arch}`;
    const schemaEngineFileName = resolvePrismaSchemaEngineTarget(target).fileName;
    const schemaEnginePath = join(
      repoRoot,
      'apps',
      'server',
      'generated',
      'runtime-migration-engines',
      targetKey,
      schemaEngineFileName,
    );
    const schemaEngineInfo = await stat(schemaEnginePath).catch(() => null);
    if (!schemaEngineInfo?.isFile()) {
      throw new Error(`[component-artifacts] missing full-server Prisma schema engine for ${targetKey}: ${schemaEnginePath}`);
    }
    entries.push({
      sourcePath: schemaEnginePath,
      targetPath: join('runtime', target.os === 'windows' ? 'schema-engine.exe' : 'schema-engine'),
    });
    const schemaWasmPath = join(repoRoot, 'node_modules', 'prisma', 'build', 'prisma_schema_build_bg.wasm');
    const schemaWasmInfo = await stat(schemaWasmPath).catch(() => null);
    if (!schemaWasmInfo?.isFile()) {
      throw new Error(`[component-artifacts] missing full-server Prisma schema WASM: ${schemaWasmPath}`);
    }
    entries.push({
      sourcePath: schemaWasmPath,
      targetPath: join('runtime', 'prisma_schema_build_bg.wasm'),
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

  entries.push(...await resolveSharpRuntimeSidecarEntries({ resolveFromPackageJsonPath: join(repoRoot, 'apps', 'server', 'package.json'), target }));

  return entries;
}
