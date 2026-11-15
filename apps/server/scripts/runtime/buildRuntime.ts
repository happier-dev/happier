import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Plugin } from 'esbuild';
import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { buildPublicShareViewerBundle } from '../buildPublicShareViewer.mjs';
import { buildPublicProfileRenderer, stagePublicProfileAssets } from '../buildPublicProfileRenderer.mjs';
import {
  getServerRuntimeBundledInteropPackages,
  resolveServerRuntimeTransitiveExternalPackagePatterns,
} from './runtimeExternalPackages';

type BuildServerRuntimeParams = Readonly<{
  projectDir?: string;
  outDir: string;
  clean?: boolean;
  releaseChannel?: PublicReleaseRingId;
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

  await buildPublicShareViewerBundle({ projectDir });
  await buildPublicProfileRenderer({ projectDir, check: true });
  await bundleServerRuntimeEntrypoints({ projectDir, outDir, releaseChannel: params.releaseChannel });
  await stagePublicProfileAssets({ projectDir, outDir });

  return {
    outDir,
    entrypoints: {
      full: join(outDir, 'main.js'),
      light: join(outDir, 'main.light.js'),
    },
  };
}

/**
 * Generated Prisma clients are CommonJS packages that locate their query engine
 * and schema beside themselves. Bundling one into an ESM chunk turns its
 * `require("node:fs")` into esbuild's throwing dynamic-require shim, so the
 * runtime imports the installed client instead, at its path from the output.
 */
function externalGeneratedPrismaClients(outDir: string): Plugin {
  return {
    name: 'external-generated-prisma-clients',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /[/\\]generated[/\\](?:sqlite|mysql)-client(?:[/\\]|$)/ }, (args) => {
        const fromOutput = relative(outDir, resolve(args.resolveDir, args.path)).split(sep).join('/');
        return { path: fromOutput.startsWith('.') ? fromOutput : `./${fromOutput}`, external: true };
      });
    },
  };
}

/** Bundles the full and light server entrypoints into `outDir` (flat ESM chunks). */
export async function bundleServerRuntimeEntrypoints(params: Readonly<{
  projectDir: string;
  outDir: string;
  releaseChannel?: PublicReleaseRingId;
}>): Promise<void> {
  const { projectDir, outDir } = params;
  const external = await readRuntimeExternalPackages(projectDir);
  await build({
    absWorkingDir: projectDir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    define: { __HAPPIER_GUEST_CLI_SOURCE__: JSON.stringify('public-release'),
      __HAPPIER_GUEST_CLI_CHANNEL__: JSON.stringify(params.releaseChannel ?? 'publicdev') },
    outdir: outDir,
    entryPoints: {
      main: join(projectDir, 'sources', 'main.ts'),
      'main.light': join(projectDir, 'sources', 'main.light.ts'),
    },
    tsconfig: join(projectDir, 'tsconfig.json'),
    external: [...external, 'bun:sqlite'],
    plugins: [externalGeneratedPrismaClients(outDir)],
    logLevel: 'silent',
    sourcemap: false,
  });
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
  const rawChannel = takeArgValue(argv, '--channel') || process.env.HAPPIER_BUILD_GUEST_CLI_CHANNEL || 'publicdev';
  const releaseChannel = normalizePublicReleaseRingId(rawChannel);
  if (!releaseChannel) throw new Error(`[server runtime] invalid public release channel: ${rawChannel}`);

  if (!outDir) {
    console.error('[server runtime] missing --out-dir');
    process.exit(1);
  }

  buildServerRuntime({ outDir, releaseChannel, ...(projectDir ? { projectDir } : {}) }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
