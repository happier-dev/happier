import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import cliDistBuildManifest from '../../utils/cli/cliDistBuildManifestLoader.mjs';

export function writeStubCliDistBuildManifest(cliDir, { entrypointDir = 'dist' } = {}) {
  return cliDistBuildManifest.writeCliDistBuildManifest(
    join(cliDir, entrypointDir, 'index.mjs'),
    {
      outputDir: join(cliDir, entrypointDir),
      builtAt: '2026-07-09T00:00:00.000Z',
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
