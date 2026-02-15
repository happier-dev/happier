#!/usr/bin/env node

import { join } from 'node:path';

import {
  commandExists,
  execOrThrow,
  normalizeChannel,
  parseArgs,
  readVersionFromPackageJson,
  resolveRepoRoot,
  resolveYarnCommand,
} from './lib/binary_release.mjs';
import { createUiWebReleaseArtifacts } from './lib/ui_web_bundle.mjs';

async function main() {
  const repoRoot = resolveRepoRoot();
  const { kv, flags } = parseArgs(process.argv.slice(2));

  if (!commandExists('tar')) {
    throw new Error('[release] tar is required to build the ui web bundle artifact');
  }

  const channel = normalizeChannel(kv.get('--channel'));
  const version = String(kv.get('--version') ?? '').trim()
    || readVersionFromPackageJson(join(repoRoot, 'apps', 'ui', 'package.json'));

  const outDir = String(kv.get('--out-dir') ?? '').trim() || join(repoRoot, 'dist', 'release-assets', 'ui-web');
  const distDir = String(kv.get('--dist-dir') ?? '').trim() || join(repoRoot, 'apps', 'ui', 'dist');
  const skipBuild = flags.has('--skip-build');

  if (!skipBuild) {
    const yarn = resolveYarnCommand({});
    execOrThrow(
      yarn.cmd,
      [...yarn.args, '--cwd', 'apps/ui', '-s', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: process.env.CI ?? '1',
        },
      },
    );
  }

  const result = await createUiWebReleaseArtifacts({
    version,
    distDir,
    outDir,
  });

  console.log(JSON.stringify({ ...result, channel }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

