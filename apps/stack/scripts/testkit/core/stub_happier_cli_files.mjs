import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import cliDistBuildManifest from '../../utils/cli/cliDistBuildManifestLoader.mjs';
import { withDependencyRefresh } from '../../utils/proc/dependency_refresh.mjs';
import { writeFakeBin } from './fake_bin_harness.mjs';
export { publishPinnedRunnerSnapshotFixture } from '../../../../../packages/cli-common/tests/pinnedRunnerSnapshot.fixture.mjs';

export function writeStubCliDistBuildManifest(cliDir, { entrypointDir = 'dist', inputFingerprint } = {}) {
  return cliDistBuildManifest.writeCliDistBuildManifest(
    join(cliDir, entrypointDir, 'index.mjs'),
    {
      outputDir: join(cliDir, entrypointDir),
      builtAt: '2026-07-09T00:00:00.000Z',
      inputFingerprint,
    },
  );
}

export async function writeStubHappierCliFiles(
  monoRoot,
  {
    packageJsonContent,
    distIndexScript,
    distBuildManifest = true,
    packageDistIndexScript,
    packageDistBuildManifest = true,
    srcIndexScript,
    binHappierScript,
    tsconfigContent,
  } = {},
) {
  const cliDir = join(monoRoot, 'apps', 'cli');

  if (typeof packageJsonContent !== 'undefined') {
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, 'package.json'), packageJsonContent, 'utf-8');
  }

  if (typeof distIndexScript !== 'undefined') {
    await mkdir(join(cliDir, 'dist'), { recursive: true });
    await writeFile(join(cliDir, 'dist', 'index.mjs'), distIndexScript, 'utf-8');
  }

  if (typeof packageDistIndexScript !== 'undefined') {
    await mkdir(join(cliDir, 'package-dist'), { recursive: true });
    await writeFile(join(cliDir, 'package-dist', 'index.mjs'), packageDistIndexScript, 'utf-8');
  }

  if (typeof srcIndexScript !== 'undefined') {
    await mkdir(join(cliDir, 'src'), { recursive: true });
    await writeFile(join(cliDir, 'src', 'index.ts'), srcIndexScript, 'utf-8');
  }

  if (typeof binHappierScript !== 'undefined') {
    await mkdir(join(cliDir, 'bin'), { recursive: true });
    await writeFile(join(cliDir, 'bin', 'happier.mjs'), binHappierScript, 'utf-8');
  }

  if (typeof tsconfigContent !== 'undefined') {
    await writeFile(join(cliDir, 'tsconfig.json'), tsconfigContent, 'utf-8');
  }

  if (typeof distIndexScript !== 'undefined' && distBuildManifest) {
    writeStubCliDistBuildManifest(cliDir);
  }
  if (typeof packageDistIndexScript !== 'undefined' && packageDistBuildManifest) {
    writeStubCliDistBuildManifest(cliDir, { entrypointDir: 'package-dist' });
  }

  return {
    cliDir,
    cliDistDir: join(cliDir, 'dist'),
    cliSrcDir: join(cliDir, 'src'),
    cliBinDir: join(cliDir, 'bin'),
  };
}

export async function prepareStubHappierCliDependencies(
  monoRoot,
  { cliDir = join(monoRoot, 'apps', 'cli'), env = process.env } = {},
) {
  const { packageManager } = JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8'));
  const version = /^pnpm@([^+]+)/u.exec(packageManager)[1];
  await writeFile(join(monoRoot, 'package.json'), JSON.stringify({ private: true, packageManager }) + '\n', 'utf-8');
  await writeFile(join(monoRoot, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'",
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    'importers:',
    '  .: {}',
    '  apps/cli: {}',
    '  apps/server: {}',
    '  apps/ui: {}',
    '',
  ].join('\n'), 'utf-8');
  await writeFile(join(monoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  // Only the package-manager process is simulated. The real refresh owner
  // publishes readiness from the installer's physical tree and workspace inputs.
  const pm = writeFakeBin({ root: monoRoot, name: 'pnpm.cjs', content: `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
if (process.argv[2] !== 'install') process.exit(97);
mkdirSync(join(process.cwd(), 'node_modules'), { recursive: true });
writeFileSync(join(process.cwd(), 'node_modules/.modules.yaml'), ${JSON.stringify(`packageManager: pnpm@${version}\nlayoutVersion: 5\nnodeLinker: hoisted\n`)});
` });
  const dependencyEnv = { npm_execpath: pm.binPath };
  await withDependencyRefresh({ installDir: monoRoot, componentDir: cliDir, env: {
    ...env, ...dependencyEnv,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0',
    HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0',
  } }, ({ env: installEnv }) => {
    execFileSync(process.execPath, [pm.binPath, 'install', '--frozen-lockfile'], { cwd: monoRoot, env: installEnv, stdio: 'pipe' });
  });
  return dependencyEnv;
}
