import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeStubHappierCliFiles(
  monoRoot,
  {
    packageJsonContent,
    distIndexScript,
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

  return {
    cliDir,
    cliDistDir: join(cliDir, 'dist'),
    cliSrcDir: join(cliDir, 'src'),
    cliBinDir: join(cliDir, 'bin'),
  };
}
