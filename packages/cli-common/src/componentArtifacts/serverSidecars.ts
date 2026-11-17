import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKSPACE_PACKAGE_BUILD_INPUT_RECORD } from '../../packageBuildOutputTargets.mjs';
import { resolveInstalledRuntimePackage } from '../../workspaceRuntimeDependencies.mjs';

import { commandExists, execOrThrow, resolvePnpmCommand, type RunCommand } from './commands.js';
import type { BinaryTarget } from './targets.js';

export type StageEntry = {
  sourcePath: string;
  targetPath: string;
};

export type ServerDbProvider = 'sqlite' | 'mysql';
export type ServerComponent = 'happier-server' | 'happier-server-light';

export type ServerRuntimeSupportIdentity = {
  fingerprint: string;
  entryCount: number;
};

/** Preparation evidence changes on rebuild; it is not a server runtime input. */
export function isServerRuntimeSupportPayloadPath(path: string): boolean {
  return basename(path) !== WORKSPACE_PACKAGE_BUILD_INPUT_RECORD || basename(dirname(path)) !== 'dist';
}

/**
 * The server support artifact's generated Prisma/native closure is selected by
 * this value. Keep it with sidecar discovery so build, identity, and staging
 * cannot disagree about which provider payload they mean.
 */
export function resolveServerRuntimeSupportBuildDbProviders({
  serverComponent,
  buildDbProviders,
  env = process.env,
}: {
  serverComponent: ServerComponent;
  buildDbProviders?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  void serverComponent;
  return String(
    buildDbProviders
    ?? env.HAPPIER_BUILD_DB_PROVIDERS
    ?? env.HAPPY_BUILD_DB_PROVIDERS
    ?? 'all',
  ).trim() || 'all';
}

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
};

type ServerPrismaInstallLayoutOwner = {
  resolveServerPrismaInstallLayout: (input: { serverRoot: string }) => Readonly<{ defaultClientDir: string }>;
  resolveServerPrismaMigrationToolLayout: (input: { serverRoot: string }) => Readonly<{
    cliPackageDir: string;
    schemaWasmPath: string;
    nodeFetchNativeDir: string;
  }>;
};

/** The server owns where its Prisma packages are installed (apps/server/scripts/prismaInstallLayout.mjs). */
async function importServerPrismaInstallLayout(repoRoot: string): Promise<ServerPrismaInstallLayoutOwner> {
  const owner = pathToFileURL(join(repoRoot, 'apps', 'server', 'scripts', 'prismaInstallLayout.mjs')).href;
  return await import(owner) as ServerPrismaInstallLayoutOwner;
}

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

export function serverRuntimeSupportNeedsPackagedMigration(buildDbProviders: string): boolean {
  const tokens = String(buildDbProviders ?? '')
    .trim()
    .toLowerCase()
    .split(/[|,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  return tokens.length === 0
    || tokens.includes('all')
    || tokens.some((token) => ['postgres', 'postgresql', 'pglite', 'mysql'].includes(token));
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

export async function prepareUiWebDist({
  repoRoot,
  env = process.env,
  runCommand = execOrThrow,
  commandProbe = commandExists,
}: {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
}): Promise<string> {
  const uiDistPath = join(repoRoot, 'apps', 'ui', 'dist');

  await runCommand(process.execPath, ['apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs'], {
    cwd: repoRoot,
    env: {
      ...env,
      CI: env.CI ?? '1',
    },
  });

  const pnpm = resolvePnpmCommand({ commandProbe });
  await runCommand(
    pnpm.cmd,
    [...pnpm.args, '--dir', 'apps/ui', '--silent', 'exec', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist'],
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
  await precompressUiWebDist({ repoRoot, env, runCommand });
  return uiDistPath;
}

async function precompressUiWebDist({
  repoRoot,
  env,
  runCommand,
}: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runCommand: RunCommand;
}): Promise<void> {
  await runCommand(process.execPath, ['scripts/pipeline/release/precompress-ui-web-assets.mjs', '--dir', 'apps/ui/dist'], {
    cwd: repoRoot,
    env: {
      ...env,
      CI: env.CI ?? '1',
    },
  });
}

function packageNameToNodeModulesPath(packageName: string): string {
  return join('node_modules', ...packageName.split('/'));
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  const raw = await readFile(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`[component-artifacts] invalid package.json: ${packageJsonPath}`);
  }
  return parsed as PackageJson;
}

function matchesPackageConstraint(values: string[] | undefined, targetValue: string): boolean {
  if (!values || values.length === 0) return true;
  const denied = values.some((value) => value === `!${targetValue}`);
  if (denied) return false;
  const allowedValues = values.filter((value) => !value.startsWith('!'));
  return allowedValues.length === 0 || allowedValues.includes(targetValue);
}

function packageSupportsTarget(packageJson: PackageJson, target: BinaryTarget): boolean {
  const npmOs = target.os === 'windows' ? 'win32' : target.os;
  return matchesPackageConstraint(packageJson.os, npmOs)
    && matchesPackageConstraint(packageJson.cpu, target.arch);
}

function requiredSharpRuntimePackages(target: BinaryTarget): string[] {
  const platform = target.os === 'windows' ? 'win32' : target.os;
  const suffix = `${platform}-${target.arch}`;
  return target.os === 'windows'
    ? [`@img/sharp-${suffix}`]
    : [`@img/sharp-${suffix}`, `@img/sharp-libvips-${suffix}`];
}

async function resolveSharpRuntimePackageJsonPath({
  repoRoot,
  target,
  env,
  runCommand,
  commandProbe,
}: {
  repoRoot: string;
  target: BinaryTarget;
  env: NodeJS.ProcessEnv;
  runCommand: RunCommand;
  commandProbe: (cmd: string) => boolean;
}): Promise<string> {
  const platform = target.os === 'windows' ? 'win32' : target.os;
  const serverPackageJsonPath = join(repoRoot, 'apps', 'server', 'package.json');
  if (platform === process.platform && target.arch === process.arch) return serverPackageJsonPath;
  if (!commandProbe('npm')) {
    throw new Error('[component-artifacts] cross-target server support requires npm with --cpu/--os selection');
  }
  const { packageJson: sharp } = resolveInstalledRuntimePackage({ packageName: 'sharp', resolveFromPackageJsonPath: serverPackageJsonPath });
  if (!sharp.version) throw new Error('[component-artifacts] installed Sharp has no version');
  const packageRoot = join(repoRoot, '.project', 'tmp', 'server-native-dependencies', `${target.os}-${target.arch}`);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'happier-server-native-dependencies',
    private: true,
    dependencies: { sharp: sharp.version },
  })}\n`);
  // npm's CPU/OS selection acquires Sharp's matching optional native packages.
  // No lifecycle scripts execute: Sharp publishes its addon and libvips in
  // those packages. Host build tools keep their original dependency tree.
  // Contract: https://docs.npmjs.com/cli/v10/commands/npm-install/#cpu
  await runCommand('npm', [
    'install',
    `--cpu=${target.arch}`,
    `--os=${platform}`,
    ...(target.os === 'linux' ? ['--libc=glibc'] : []),
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--workspaces=false',
  ], { cwd: packageRoot, env });
  return join(packageRoot, 'package.json');
}

function resolveIrohNodeAddonTarget(target: BinaryTarget): string {
  return `${target.os === 'windows' ? 'win32' : target.os}-${target.arch}`;
}

/**
 * Stages the runtime-facing Iroh workspace package shape beside a compiled
 * server. Release builders require the exact target addon; managed/source
 * artifacts may omit `native/` so optional Iroh support cannot make the Home
 * itself unavailable.
 */
export async function resolveIrohNativeServerSidecarEntries({
  repoRoot,
  target,
  requireNativeAddon = false,
}: {
  repoRoot: string;
  target: BinaryTarget;
  requireNativeAddon?: boolean;
}): Promise<StageEntry[]> {
  const packageRoot = join(repoRoot, 'packages', 'iroh-native');
  const packageTargetRoot = join('node_modules', '@happier-dev', 'iroh-native');
  const requiredEntries = [
    ['package.json', 'package.json'],
  ] as const;
  const entries: StageEntry[] = [];
  for (const [sourceRelativePath, targetRelativePath] of requiredEntries) {
    const sourcePath = join(packageRoot, sourceRelativePath);
    const info = await stat(sourcePath).catch(() => null);
    if (!info) {
      throw new Error(`[component-artifacts] missing Iroh native package runtime path: ${sourcePath}`);
    }
    entries.push({
      sourcePath,
      targetPath: join(packageTargetRoot, targetRelativePath),
    });
  }

  const nativePath = join(packageRoot, 'native');
  const addonTarget = resolveIrohNodeAddonTarget(target);
  const addonName = `happier-iroh-native-lifecycle.${addonTarget}.node`;
  const addonPath = join(nativePath, addonName);
  const addonInfo = await stat(addonPath).catch(() => null);
  if (requireNativeAddon && !addonInfo?.isFile()) {
    throw new Error(
      `[component-artifacts] missing Iroh lifecycle addon for ${target.os}-${target.arch}: ${addonPath}`,
    );
  }
  if (addonInfo?.isFile()) {
    entries.push({
      sourcePath: addonPath,
      targetPath: join(packageTargetRoot, 'native', addonName),
    });
  }
  return entries;
}

async function collectInstalledPackageSidecars({
  resolveFromPackageJsonPath,
  packageName,
  target,
  optional,
  visited,
}: {
  resolveFromPackageJsonPath: string;
  packageName: string;
  /** Omitted for platform-neutral closures; native packages are filtered by it. */
  target?: BinaryTarget;
  optional: boolean;
  visited: Set<string>;
}): Promise<StageEntry[]> {
  if (visited.has(packageName)) return [];
  let installed: ReturnType<typeof resolveInstalledRuntimePackage>;
  try {
    installed = resolveInstalledRuntimePackage({ packageName, resolveFromPackageJsonPath });
  } catch (error) {
    if (optional && error && typeof error === 'object' && 'code' in error && error.code === 'MODULE_NOT_FOUND') return [];
    throw error;
  }
  const { packageDir, packageJsonPath } = installed;
  const packageJson = await readPackageJson(packageJsonPath);
  if (target && !packageSupportsTarget(packageJson, target)) {
    if (optional) return [];
    throw new Error(`[component-artifacts] runtime package ${packageName} is incompatible with ${target.os}-${target.arch}`);
  }

  visited.add(packageName);
  const entries: StageEntry[] = [{
    sourcePath: packageDir,
    targetPath: packageNameToNodeModulesPath(packageName),
  }];

  for (const depName of Object.keys(packageJson.dependencies ?? {})) {
    entries.push(...await collectInstalledPackageSidecars({
      resolveFromPackageJsonPath: packageJsonPath,
      packageName: depName,
      target,
      optional: false,
      visited,
    }));
  }

  for (const depName of Object.keys(packageJson.optionalDependencies ?? {})) {
    entries.push(...await collectInstalledPackageSidecars({
      resolveFromPackageJsonPath: packageJsonPath,
      packageName: depName,
      target,
      optional: true,
      visited,
    }));
  }

  return entries;
}

/** Sharp's native closure beside the compiled server; target acquisition stays server-owned. */
export async function resolveSharpServerSidecarEntries({
  repoRoot,
  target,
  env = process.env,
  runCommand = execOrThrow,
  commandProbe = commandExists,
}: {
  repoRoot: string;
  target: BinaryTarget;
  env?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
}): Promise<StageEntry[]> {
  const resolveFromPackageJsonPath = await resolveSharpRuntimePackageJsonPath({ repoRoot, target, env, runCommand, commandProbe });
  const visited = new Set<string>();
  const entries = await collectInstalledPackageSidecars({ resolveFromPackageJsonPath, packageName: 'sharp', target, optional: false, visited });
  const sharp = resolveInstalledRuntimePackage({ packageName: 'sharp', resolveFromPackageJsonPath });
  for (const packageName of requiredSharpRuntimePackages(target)) {
    entries.push(...await collectInstalledPackageSidecars({ resolveFromPackageJsonPath: sharp.packageJsonPath, packageName, target, optional: false, visited }));
  }
  return entries;
}

export async function resolveServerRuntimeSupportEntries({
  repoRoot,
  target,
  serverComponent = 'happier-server-light',
  buildDbProviders,
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
  const pnpm = resolvePnpmCommand({ commandProbe });
  const effectiveBuildDbProviders = resolveServerRuntimeSupportBuildDbProviders({
    serverComponent,
    buildDbProviders,
    env,
  });
  await runCommand(
    pnpm.cmd,
    [...pnpm.args, '--dir', 'apps/server', '--silent', 'run', 'generate:providers'],
    {
      cwd: repoRoot,
      env: {
        ...env,
        HAPPIER_BUILD_DB_PROVIDERS: effectiveBuildDbProviders,
        HAPPY_BUILD_DB_PROVIDERS: effectiveBuildDbProviders,
      },
    },
  );

  const needsPackagedMigration = serverRuntimeSupportNeedsPackagedMigration(effectiveBuildDbProviders);
  if (needsPackagedMigration) {
    if (!target) {
      throw new Error('[component-artifacts] a binary target is required for server migration artifacts');
    }
    const schemaEngine = resolvePrismaSchemaEngineTarget(target);
    await runCommand(
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
  }

  const dedupedProviders = resolveRequestedServerDbProviders(effectiveBuildDbProviders);

  const serverRoot = join(repoRoot, 'apps', 'server');
  const prismaLayouts = await importServerPrismaInstallLayout(repoRoot);
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

  const providerTokens = String(effectiveBuildDbProviders).toLowerCase().split(/[|,]/).map((value) => value.trim());
  const includesAllProviders = providerTokens.length === 0 || providerTokens.includes('all');
  const includesPostgres = includesAllProviders || providerTokens.some((token) => ['postgres', 'postgresql', 'pglite'].includes(token));
  const includesMysql = includesAllProviders || providerTokens.includes('mysql');
  // The packaged Prisma 6 migration CLI reads the URL from the schema; the server stages its
  // URL-less Prisma 7 schemas with `url = env("DATABASE_URL")` for that tool only.
  const migrationSchemaRoot = join(repoRoot, 'apps', 'server', 'generated', 'runtime-migration-schemas');
  const prepareMigrationSchema = async (sourceSchemaPath: string, preparedSchemaPath: string): Promise<string> => {
    const owner = pathToFileURL(join(serverRoot, 'scripts', 'runtime', 'prepareFullRuntimeMigrationSchema.mjs')).href;
    const { withPackagedMigrationDatasourceUrl } = await import(owner) as {
      withPackagedMigrationDatasourceUrl: (schema: string) => string;
    };
    await mkdir(dirname(preparedSchemaPath), { recursive: true });
    await writeFile(preparedSchemaPath, withPackagedMigrationDatasourceUrl(await readFile(sourceSchemaPath, 'utf8')), 'utf8');
    return preparedSchemaPath;
  };
  const requiredMigrationEntries: StageEntry[] = [
    ...(includesPostgres ? [
      {
        sourcePath: await prepareMigrationSchema(
          join(repoRoot, 'apps', 'server', 'prisma', 'schema.prisma'),
          join(migrationSchemaRoot, 'postgres', 'schema.prisma'),
        ),
        targetPath: join('prisma', 'schema.prisma'),
      },
      { sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'migrations'), targetPath: join('prisma', 'migrations') },
    ] : []),
    ...(includesMysql ? [
      {
        sourcePath: await prepareMigrationSchema(
          join(repoRoot, 'apps', 'server', 'prisma', 'mysql', 'schema.prisma'),
          join(migrationSchemaRoot, 'mysql', 'schema.prisma'),
        ),
        targetPath: join('prisma', 'mysql', 'schema.prisma'),
      },
      { sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'mysql', 'migrations'), targetPath: join('prisma', 'mysql', 'migrations') },
    ] : []),
  ];
  for (const entry of requiredMigrationEntries) {
    const info = await stat(entry.sourcePath).catch(() => null);
    if (!info) {
      throw new Error(`[component-artifacts] missing server migration input: ${entry.sourcePath}`);
    }
    entries.push(entry);
  }
  if (needsPackagedMigration && target) {
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
      throw new Error(`[component-artifacts] missing server Prisma schema engine for ${targetKey}: ${schemaEnginePath}`);
    }
    entries.push({
      sourcePath: schemaEnginePath,
      targetPath: join('runtime', target.os === 'windows' ? 'schema-engine.exe' : 'schema-engine'),
    });
    const schemaWasmPath = prismaLayouts.resolveServerPrismaMigrationToolLayout({ serverRoot }).schemaWasmPath;
    const schemaWasmInfo = await stat(schemaWasmPath).catch(() => null);
    if (!schemaWasmInfo?.isFile()) {
      throw new Error(`[component-artifacts] missing server Prisma schema WASM: ${schemaWasmPath}`);
    }
    entries.push({
      sourcePath: schemaWasmPath,
      targetPath: join('runtime', 'prisma_schema_build_bg.wasm'),
    });
  }

  const postgresClientPath = prismaLayouts.resolveServerPrismaInstallLayout({ serverRoot }).defaultClientDir;
  const postgresClientInfo = await stat(postgresClientPath).catch(() => null);
  if (!postgresClientInfo?.isDirectory()) {
    throw new Error(`[component-artifacts] missing generated postgres Prisma client directory: ${postgresClientPath}`);
  }
  entries.push({
    sourcePath: postgresClientPath,
    targetPath: join('node_modules', '.prisma', 'client'),
  });

  // Every generated client loads `@prisma/client/runtime/client.js` (the default client) or its
  // copied runtime, and both require `@prisma/client-runtime-utils` from the payload's node_modules.
  entries.push(...await collectInstalledPackageSidecars({
    resolveFromPackageJsonPath: join(repoRoot, 'apps', 'server', 'package.json'),
    packageName: '@prisma/client',
    target,
    optional: false,
    visited: new Set(),
  }));

  if (target) {
    entries.push(...await resolveIrohNativeServerSidecarEntries({
      repoRoot,
      target,
      requireNativeAddon: String(env.HAPPIER_SERVER_REQUIRE_IROH_NATIVE ?? '').trim() === '1',
    }));
    entries.push(...await resolveSharpServerSidecarEntries({ repoRoot, target, env, runCommand, commandProbe }));
  }

  return entries;
}

/**
 * Server support owns the immutable Prisma migration-tool binary independently
 * of which server behavior preset consumes it.
 * These entries are hashed as tool inputs but deliberately are not copied into
 * the runtime payload: the compiled tool is the runtime asset.
 */
export async function resolveServerRuntimeSupportToolIdentityEntries({
  repoRoot,
  serverComponent,
  buildDbProviders = 'all',
}: {
  repoRoot: string;
  serverComponent: ServerComponent;
  buildDbProviders?: string;
}): Promise<StageEntry[]> {
  void serverComponent;
  if (!serverRuntimeSupportNeedsPackagedMigration(buildDbProviders)) return [];
  const migrationTool = (await importServerPrismaInstallLayout(repoRoot))
    .resolveServerPrismaMigrationToolLayout({ serverRoot: join(repoRoot, 'apps', 'server') });
  const entries: StageEntry[] = [
    {
      sourcePath: join(repoRoot, 'packages', 'cli-common', 'scripts', 'buildPrismaMigrateBinary.mjs'),
      targetPath: join('tool-inputs', 'buildPrismaMigrateBinary.mjs'),
    },
    {
      sourcePath: join(repoRoot, 'packages', 'cli-common', 'src', 'componentArtifacts', 'commands.ts'),
      targetPath: join('tool-inputs', 'commands.ts'),
    },
    {
      sourcePath: migrationTool.cliPackageDir,
      targetPath: join('tool-inputs', 'prisma'),
    },
    {
      sourcePath: migrationTool.nodeFetchNativeDir,
      targetPath: join('tool-inputs', 'node-fetch-native'),
    },
  ];
  for (const entry of entries) {
    const info = await stat(entry.sourcePath).catch(() => null);
    if (!info) {
      throw new Error(`[component-artifacts] missing server Prisma migration tool input: ${entry.sourcePath}`);
    }
  }
  return entries;
}

async function hashServerRuntimeSupportPath({
  hash,
  rootPath,
  relativePath,
}: {
  hash: ReturnType<typeof createHash>;
  rootPath: string;
  relativePath: string;
}): Promise<void> {
  const path = relativePath ? join(rootPath, relativePath) : rootPath;
  if (!isServerRuntimeSupportPayloadPath(path)) return;
  const info = await lstat(path);
  const normalizedPath = relativePath.replaceAll('\\', '/') || '.';
  if (info.isDirectory()) {
    hash.update(`dir\0${normalizedPath}\0`);
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      // Payload finalization removes package-manager shims, so their source topology
      // must not create a distinct reusable server-support artifact identity.
      if (entry.name === '.bin') continue;
      await hashServerRuntimeSupportPath({
        hash,
        rootPath,
        relativePath: relativePath ? join(relativePath, entry.name) : entry.name,
      });
    }
    return;
  }
  if (info.isFile()) {
    hash.update(`file\0${normalizedPath}\0${info.size}\0`);
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
    }
    hash.update('\0');
    return;
  }
  if (info.isSymbolicLink()) {
    hash.update(`link\0${normalizedPath}\0${await readlink(path)}\0`);
    return;
  }
  throw new Error(`[component-artifacts] unsupported server runtime support entry: ${path}`);
}

/**
 * Hashes exactly the owner-selected Prisma/native support closure that is copied
 * beside a managed server binary. The server artifact owner uses this identity
 * for its immutable support artifact; it deliberately excludes static web UI.
 */
export async function readServerRuntimeSupportIdentity({
  entries,
  toolIdentityEntries = [],
  toolInputs = [],
  target,
  serverComponent,
  buildDbProviders,
}: {
  entries: readonly StageEntry[];
  toolIdentityEntries?: readonly StageEntry[];
  toolInputs?: readonly string[];
  target: BinaryTarget;
  serverComponent: ServerComponent;
  buildDbProviders: string;
}): Promise<ServerRuntimeSupportIdentity> {
  const hash = createHash('sha256');
  hash.update('happier:server-runtime-support:v2\0');
  hash.update(`target\0${target.os}\0${target.arch}\0${target.bunTarget}\0${target.exeExt}\0`);
  void serverComponent;
  hash.update(`db-providers\0${String(buildDbProviders ?? '').trim()}\0`);
  const orderedEntries = [...entries].sort((left, right) =>
    left.targetPath.replaceAll('\\', '/').localeCompare(right.targetPath.replaceAll('\\', '/')),
  );
  for (const entry of orderedEntries) {
    hash.update(`runtime-entry\0${entry.targetPath.replaceAll('\\', '/')}\0`);
    await hashServerRuntimeSupportPath({ hash, rootPath: entry.sourcePath, relativePath: '' });
  }
  const orderedToolEntries = [...toolIdentityEntries].sort((left, right) =>
    left.targetPath.replaceAll('\\', '/').localeCompare(right.targetPath.replaceAll('\\', '/')),
  );
  for (const entry of orderedToolEntries) {
    hash.update(`tool-entry\0${entry.targetPath.replaceAll('\\', '/')}\0`);
    await hashServerRuntimeSupportPath({ hash, rootPath: entry.sourcePath, relativePath: '' });
  }
  for (const toolInput of [...toolInputs].map((value) => String(value).trim()).filter(Boolean).sort()) {
    hash.update(`tool\0${toolInput}\0`);
  }
  return {
    fingerprint: hash.digest('hex').slice(0, 16),
    entryCount: orderedEntries.length + orderedToolEntries.length,
  };
}

export async function resolveServerBinarySidecarEntries({
  repoRoot,
  uiWebDistPath,
  target,
  serverComponent = 'happier-server-light',
  buildDbProviders,
  env = process.env,
  runCommand = execOrThrow,
  commandProbe = commandExists,
}: {
  repoRoot: string;
  uiWebDistPath: string;
  target?: BinaryTarget;
  serverComponent?: ServerComponent;
  buildDbProviders?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
}): Promise<StageEntry[]> {
  const entries = await resolveServerRuntimeSupportEntries({
    repoRoot,
    target,
    serverComponent,
    buildDbProviders,
    env,
    runCommand,
    commandProbe,
  });
  const uiDistInfo = await stat(uiWebDistPath).catch(() => null);
  if (!uiDistInfo?.isDirectory()) {
    throw new Error(`[component-artifacts] missing prepared ui web dist directory: ${uiWebDistPath}`);
  }
  return [
    ...entries,
    {
      sourcePath: uiWebDistPath,
      targetPath: join('ui-web', 'current'),
    },
  ];
}
