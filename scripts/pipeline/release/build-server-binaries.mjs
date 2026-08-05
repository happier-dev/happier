#!/usr/bin/env node

// @ts-check

import { join } from 'node:path';
import { mkdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  SERVER_TARGETS,
  SERVER_BINARY_DEFAULT_EXTERNALS,
  buildServerBinaryArtifactPayload,
  normalizeChannel,
  packagePreparedTargetBinary,
  parseArgs,
  parseCsv,
  prepareUiWebDist,
  readVersionFromPackageJson,
  resolveRepoRoot,
  resolveTargets,
  maybeSignFile,
  writeChecksumsFile,
} from './lib/binary-release.mjs';

async function main() {
  const repoRoot = resolveRepoRoot();
  const { kv } = parseArgs(process.argv.slice(2));

  const channel = normalizeChannel(kv.get('--channel'));
  const version = String(kv.get('--version') ?? '').trim()
    || readVersionFromPackageJson(join(repoRoot, 'apps', 'server', 'package.json'));
  const outDir = join(repoRoot, 'dist', 'release-assets', 'server');
  // IMPORTANT: build scripts are invoked by multiple integration tests in parallel.
  // Never share a single temp directory across invocations, or concurrent builds will race on rm/mkdir.
  const tempBaseDir = join(repoRoot, 'dist', 'release-assets', '.tmp-server-binaries');
  const tempDir = join(tempBaseDir, `build-${process.pid}-${randomUUID()}`);
  const serverComponent = String(kv.get('--server-component') ?? 'happier-server-light').trim();
  if (serverComponent !== 'happier-server' && serverComponent !== 'happier-server-light') {
    throw new Error(`Unsupported --server-component: ${serverComponent}`);
  }
  const entrypoint = String(kv.get('--entrypoint') ?? '').trim()
    || join(
      repoRoot,
      'apps',
      'server',
      'sources',
      serverComponent === 'happier-server' ? 'main.ts' : 'main.light.ts',
    );
  const externals = parseCsv(
    kv.get('--externals')
      ?? process.env.HAPPIER_SERVER_BUN_EXTERNALS
      ?? SERVER_BINARY_DEFAULT_EXTERNALS.join(','),
  );
  const targets = resolveTargets({
    availableTargets: SERVER_TARGETS,
    requested: kv.get('--targets'),
  });
  await mkdir(tempBaseDir, { recursive: true });
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  const buildDbProviders = String(
    process.env.HAPPIER_BUILD_DB_PROVIDERS ?? process.env.HAPPY_BUILD_DB_PROVIDERS ?? 'all',
  ).trim() || 'all';
  const uiWebDistPath = await prepareUiWebDist({ repoRoot });

  const artifacts = [];
  for (const target of targets) {
    const stageDir = join(tempDir, `happier-server-v${version}-${target.os}-${target.arch}`);
    await buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir: stageDir,
      uiWebDistPath,
      target,
      serverComponent,
      entrypoint,
      externals,
      buildDbProviders,
    });
    const artifact = await packagePreparedTargetBinary({
      product: 'happier-server',
      version,
      target,
      stageDir,
      outDir,
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
    serverComponent,
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
