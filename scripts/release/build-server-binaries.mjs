#!/usr/bin/env node

import { join } from 'node:path';
import { mkdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  SERVER_TARGETS,
  commandExists,
  compileBunBinary,
  execOrThrow,
  ensureFileExists,
  normalizeChannel,
  packageTargetBinary,
  parseArgs,
  parseCsv,
  readVersionFromPackageJson,
  resolveRepoRoot,
  resolveTargets,
  maybeSignFile,
  writeChecksumsFile,
} from './lib/binary_release.mjs';

async function main() {
  const repoRoot = resolveRepoRoot();
  const { kv } = parseArgs(process.argv.slice(2));

  if (!commandExists('bun')) {
    throw new Error('[release] bun is required to build binaries');
  }

  const channel = normalizeChannel(kv.get('--channel'));
  const version = String(kv.get('--version') ?? '').trim()
    || readVersionFromPackageJson(join(repoRoot, 'apps', 'server', 'package.json'));
  const outDir = join(repoRoot, 'dist', 'release-assets', 'server');
  // IMPORTANT: build scripts are invoked by multiple integration tests in parallel.
  // Never share a single temp directory across invocations, or concurrent builds will race on rm/mkdir.
  const tempBaseDir = join(repoRoot, 'dist', 'release-assets', '.tmp-server-binaries');
  const tempDir = join(tempBaseDir, `build-${process.pid}-${randomUUID()}`);
  const entrypoint = String(kv.get('--entrypoint') ?? '').trim()
    || join(repoRoot, 'apps', 'server', 'sources', 'main.light.ts');
  const externals = parseCsv(kv.get('--externals') ?? process.env.HAPPIER_SERVER_BUN_EXTERNALS ?? 'redis');
  const targets = resolveTargets({
    availableTargets: SERVER_TARGETS,
    requested: kv.get('--targets'),
  });

  await ensureFileExists(entrypoint);
  await mkdir(tempBaseDir, { recursive: true });
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  // Ensure generated Prisma clients are present before compiling the server binary.
  // Workspace installs do not reliably run app-level postinstall scripts in CI.
  const yarn = commandExists('yarn')
    ? { cmd: 'yarn', args: [] }
    : commandExists('corepack')
      ? { cmd: 'corepack', args: ['yarn'] }
      : null;
  if (!yarn) {
    throw new Error('[release] building server binaries requires yarn or corepack (corepack yarn)');
  }
  const buildDbProviders = String(
    process.env.HAPPIER_BUILD_DB_PROVIDERS ?? process.env.HAPPY_BUILD_DB_PROVIDERS ?? 'all',
  ).trim() || 'all';
  execOrThrow(
    yarn.cmd,
    [...yarn.args, '--cwd', 'apps/server', '-s', 'generate:providers'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HAPPIER_BUILD_DB_PROVIDERS: buildDbProviders,
        HAPPY_BUILD_DB_PROVIDERS: buildDbProviders,
      },
    },
  );

  const parseGeneratedProviderDirs = async () => {
    const normalized = buildDbProviders.toLowerCase();
    const requested = normalized === 'all'
      ? ['sqlite', 'mysql']
      : normalized
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value === 'sqlite' || value === 'mysql');
    const deduped = [...new Set(requested)];
    const entries = [];
    for (const provider of deduped) {
      const sourcePath = join(repoRoot, 'apps', 'server', 'generated', `${provider}-client`);
      const info = await stat(sourcePath).catch(() => null);
      if (!info?.isDirectory()) {
        throw new Error(`[release] missing generated Prisma directory for provider ${provider}: ${sourcePath}`);
      }
      entries.push({
        sourcePath,
        targetPath: join('generated', `${provider}-client`),
      });
    }
    if (deduped.includes('sqlite')) {
      const migrationsPath = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
      const migrationsInfo = await stat(migrationsPath).catch(() => null);
      if (!migrationsInfo?.isDirectory()) {
        throw new Error(`[release] missing sqlite migrations directory: ${migrationsPath}`);
      }
      entries.push({
        sourcePath: migrationsPath,
        targetPath: join('prisma', 'sqlite', 'migrations'),
      });
    }
    return entries;
  };
  const additionalStageEntries = await parseGeneratedProviderDirs();

  const artifacts = [];
  for (const target of targets) {
    const compiledPath = join(tempDir, `happier-server-${target.os}-${target.arch}${target.exeExt}`);
    await compileBunBinary({
      entrypoint,
      bunTarget: target.bunTarget,
      outfile: compiledPath,
      cwd: repoRoot,
      externals,
    });
    const artifact = await packageTargetBinary({
      product: 'happier-server',
      version,
      target,
      executableName: 'happier-server',
      buildTempDir: tempDir,
      outDir,
      compiledPath,
      additionalStageEntries,
    });
    artifacts.push(artifact);
  }

  const checksumsPath = await writeChecksumsFile({
    product: 'happier-server',
    version,
    artifacts,
    outDir,
  });
  const signaturePath = await maybeSignFile({
    path: checksumsPath,
    trustedComment: `happier-server ${version} ${channel}`,
  });

  // Best-effort cleanup to avoid unbounded temp build directories.
  await rm(tempDir, { recursive: true, force: true });

  const output = {
    product: 'happier-server',
    channel,
    version,
    outDir,
    entrypoint,
    artifacts: artifacts.map((artifact) => artifact.name),
    checksums: checksumsPath,
    signature: signaturePath,
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
