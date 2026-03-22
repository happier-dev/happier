import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import {
  getServerRuntimeBundledInteropPackages,
  resolveServerRuntimeTransitiveExternalPackagePatterns,
} from './runtimeExternalPackages';

type BuildServerRuntimeParams = Readonly<{
  projectDir?: string;
  outDir: string;
  clean?: boolean;
}>;

type BuildServerRuntimeResult = Readonly<{
  outDir: string;
  entrypoints: {
    full: string;
    light: string;
  };
}>;

function resolveDefaultProjectDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

async function readRuntimeExternalPackages(projectDir: string): Promise<string[]> {
  const packageJsonPath = join(projectDir, 'package.json');
  const raw = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const bundledInteropPackages = getServerRuntimeBundledInteropPackages();
  const rootExternalPackages = [
    ...Object.keys(raw.dependencies ?? {}),
    ...Object.keys(raw.optionalDependencies ?? {}),
  ].filter((name) => !bundledInteropPackages.has(name));
  const transitiveRuntimeExternalPackages = await resolveServerRuntimeTransitiveExternalPackagePatterns(projectDir);

  return [...rootExternalPackages, ...transitiveRuntimeExternalPackages];
}

export async function buildServerRuntime(params: BuildServerRuntimeParams): Promise<BuildServerRuntimeResult> {
  const projectDir = params.projectDir ? resolve(params.projectDir) : resolveDefaultProjectDir();
  const outDir = resolve(params.outDir);
  const clean = params.clean ?? true;

  if (clean) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  const external = await readRuntimeExternalPackages(projectDir);
  await build({
    absWorkingDir: projectDir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outdir: outDir,
    entryPoints: {
      main: join(projectDir, 'sources', 'main.ts'),
      'main.light': join(projectDir, 'sources', 'main.light.ts'),
    },
    tsconfig: join(projectDir, 'tsconfig.json'),
    external: [...external, 'bun:sqlite'],
    logLevel: 'silent',
    sourcemap: false,
  });

  return {
    outDir,
    entrypoints: {
      full: join(outDir, 'main.js'),
      light: join(outDir, 'main.light.js'),
    },
  };
}

function takeArgValue(argv: string[], name: string): string {
  const direct = argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1).trim();
  const index = argv.indexOf(name);
  if (index >= 0) return String(argv[index + 1] ?? '').trim();
  return '';
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  const argv = process.argv.slice(2);
  const outDir = takeArgValue(argv, '--out-dir');
  const projectDir = takeArgValue(argv, '--project-dir');

  if (!outDir) {
    console.error('[server runtime] missing --out-dir');
    process.exit(1);
  }

  buildServerRuntime({ outDir, ...(projectDir ? { projectDir } : {}) }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
