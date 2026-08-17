import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { commandExists, execOrThrow, resolveYarnCommand, type RunCommand } from './commands.js';
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
  if (serverComponent === 'happier-server') return 'mysql';
  return String(
    buildDbProviders
    ?? env.HAPPIER_BUILD_DB_PROVIDERS
    ?? env.HAPPY_BUILD_DB_PROVIDERS
    ?? 'all',
  ).trim() || 'all';
}

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
};

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
  precompressUiWebDist({ repoRoot, env, runCommand });
  return uiDistPath;
}

function precompressUiWebDist({
  repoRoot,
  env,
  runCommand,
}: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runCommand: RunCommand;
}): void {
  runCommand(process.execPath, ['scripts/pipeline/release/precompress-ui-web-assets.mjs', '--dir', 'apps/ui/dist'], {
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

async function collectInstalledPackageSidecars({
  repoRoot,
  packageName,
  target,
  optional,
  visited,
}: {
  repoRoot: string;
  packageName: string;
  target: BinaryTarget;
  optional: boolean;
  visited: Set<string>;
}): Promise<StageEntry[]> {
  if (visited.has(packageName)) return [];
  const packageDir = join(repoRoot, packageNameToNodeModulesPath(packageName));
  const packageJsonPath = join(packageDir, 'package.json');
  const packageJsonInfo = await stat(packageJsonPath).catch(() => null);
  if (!packageJsonInfo?.isFile()) {
    if (optional) return [];
    throw new Error(`[component-artifacts] missing runtime package ${packageName}: ${packageJsonPath}`);
  }

  const packageJson = await readPackageJson(packageJsonPath);
  if (!packageSupportsTarget(packageJson, target)) {
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
      repoRoot,
      packageName: depName,
      target,
      optional: false,
      visited,
    }));
  }

  for (const depName of Object.keys(packageJson.optionalDependencies ?? {})) {
    entries.push(...await collectInstalledPackageSidecars({
      repoRoot,
      packageName: depName,
      target,
      optional: true,
      visited,
    }));
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
  const yarn = resolveYarnCommand({ commandProbe });
  const effectiveBuildDbProviders = resolveServerRuntimeSupportBuildDbProviders({
    serverComponent,
    buildDbProviders,
    env,
  });
  runCommand(
    yarn.cmd,
    [...yarn.args, '--cwd', 'apps/server', '-s', 'generate:providers'],
    {
      cwd: repoRoot,
      env: {
        ...env,
        HAPPIER_BUILD_DB_PROVIDERS: effectiveBuildDbProviders,
        HAPPY_BUILD_DB_PROVIDERS: effectiveBuildDbProviders,
      },
    },
  );

  if (serverComponent === 'happier-server') {
    if (!target) {
      throw new Error('[component-artifacts] a binary target is required for full-server migration artifacts');
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
  }

  const dedupedProviders = resolveRequestedServerDbProviders(effectiveBuildDbProviders);

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

  if (serverComponent === 'happier-server') {
    const requiredFullServerEntries: StageEntry[] = [
      { sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'schema.prisma'), targetPath: join('prisma', 'schema.prisma') },
      { sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'migrations'), targetPath: join('prisma', 'migrations') },
      { sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'mysql', 'schema.prisma'), targetPath: join('prisma', 'mysql', 'schema.prisma') },
      { sourcePath: join(repoRoot, 'apps', 'server', 'prisma', 'mysql', 'migrations'), targetPath: join('prisma', 'mysql', 'migrations') },
    ];
    for (const entry of requiredFullServerEntries) {
      const info = await stat(entry.sourcePath).catch(() => null);
      if (!info) {
        throw new Error(`[component-artifacts] missing full-server migration input: ${entry.sourcePath}`);
      }
      entries.push(entry);
    }
    if (!target) {
      throw new Error('[component-artifacts] a binary target is required for full-server migration artifacts');
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

  if (target) {
    const sharpVisited = new Set<string>();
    entries.push(...await collectInstalledPackageSidecars({
      repoRoot,
      packageName: 'sharp',
      target,
      optional: false,
      visited: sharpVisited,
    }));
    for (const packageName of requiredSharpRuntimePackages(target)) {
      entries.push(...await collectInstalledPackageSidecars({
        repoRoot,
        packageName,
        target,
        optional: false,
        visited: sharpVisited,
      }));
    }
  }

  return entries;
}

/**
 * Full-server support also owns the immutable Prisma migration-tool binary.
 * These entries are hashed as tool inputs but deliberately are not copied into
 * the runtime payload: the compiled tool is the runtime asset.
 */
export async function resolveServerRuntimeSupportToolIdentityEntries({
  repoRoot,
  serverComponent,
}: {
  repoRoot: string;
  serverComponent: ServerComponent;
}): Promise<StageEntry[]> {
  if (serverComponent !== 'happier-server') return [];
  const entries: StageEntry[] = [
    {
      sourcePath: join(repoRoot, 'packages', 'cli-common', 'scripts', 'buildPrismaMigrateBinary.mjs'),
      targetPath: join('tool-inputs', 'buildPrismaMigrateBinary.mjs'),
    },
    {
      sourcePath: join(repoRoot, 'node_modules', 'prisma'),
      targetPath: join('tool-inputs', 'prisma'),
    },
    {
      sourcePath: join(repoRoot, 'node_modules', 'node-fetch-native'),
      targetPath: join('tool-inputs', 'node-fetch-native'),
    },
  ];
  for (const entry of entries) {
    const info = await stat(entry.sourcePath).catch(() => null);
    if (!info) {
      throw new Error(`[component-artifacts] missing full-server Prisma migration tool input: ${entry.sourcePath}`);
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
  hash.update('happier:server-runtime-support:v1\0');
  hash.update(`target\0${target.os}\0${target.arch}\0${target.bunTarget}\0${target.exeExt}\0`);
  hash.update(`component\0${serverComponent}\0`);
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
