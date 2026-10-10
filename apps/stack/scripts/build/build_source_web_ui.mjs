import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { readWorkspacePackages, resolveWorkspaceSource } from './build_source_runtime.mjs';
import { resolveExpoBin, prepareExpoCommandEnv, applyExpoExportMaxWorkersArgs } from '../utils/expo/command.mjs';
import { applyExpoNodeHeapEnv } from '../utils/expo/expoNodeHeapEnv.mjs';
import { run } from '../utils/proc/proc.mjs';
import { runSourceBuildCommand } from '../utils/proc/runSourceBuildCommand.mjs';
import { buildStackWebExportEnv } from '../utils/ui/ui_export_env.mjs';
import { assertWebArtifactPayload } from '../runtime/shared/web_payload.mjs';
import { precompressUiWebAssets } from './precompress_ui_web_assets.mjs';
import { listBundledPluginUiArtifactExports } from '../../../ui/scripts/generateBundledPluginUiArtifacts.mjs';

/** Export this host's current source once. The caller owns explicit rebuilds,
 * supplies stable Expo baseDir and fresh outputDir; no live Expo or publication. */
export async function exportSourceWebUi({ repoDir, baseDir, outputDir, env = process.env, signal, runImpl }) {
  const { inventoryPath } = await prepareSourceWebUi({ repoDir, outputDir, env, signal });
  const uiProjectDir = join(repoDir, 'apps/ui');
  const { env: isolatedEnv } = await prepareExpoCommandEnv({
    baseDir, kind: 'source-web-export', projectDir: uiProjectDir,
    baseEnv: buildStackWebExportEnv({ baseEnv: env }),
  });
  const exportEnv = applyExpoNodeHeapEnv({
    ...isolatedEnv, CI: '1', HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath,
  });
  const uiDir = resolve(outputDir, 'web');
  const exportStartedAt = performance.now();
  const expoCommand = await resolveExpoBin(uiProjectDir);
  const expoArgs = applyExpoExportMaxWorkersArgs([
    'export', '--platform', 'web', '--output-dir', uiDir,
  ], exportEnv);
  // The optional runner substitutes only the external Expo boundary in tests.
  // Real exports acquire a separate host reservation after preparation releases.
  if (runImpl) await runImpl(expoCommand, expoArgs, { cwd: uiProjectDir, env: exportEnv, signal });
  else await runSourceBuildCommand({ repoDir, command: expoCommand, args: expoArgs,
    cwd: uiProjectDir, env: exportEnv, signal, captureStdout: false });
  await assertWebArtifactPayload({ payloadDir: uiDir, entrypoint: 'index.html' });
  await precompressUiWebAssets({ dir: uiDir });
  console.log(`[source-ui] phase=web-export elapsedMs=${Math.round(performance.now() - exportStartedAt)}`);
  return { uiDir, entrypoint: 'index.html', runtimeMode: 'source' };
}

/** Source QA and native web construction share the compiler and private inventory. */
export async function prepareSourceWebUi({ repoDir, outputDir, env = process.env, signal }) {
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir);
  await runSourceBuildCommand({ repoDir, scriptPath: fileURLToPath(import.meta.url),
    args: [JSON.stringify({ repoDir, outputDir })], env, signal, captureStdout: false });
  return { inventoryPath: join(outputDir, 'inputs/inventory.js') };
}

async function prepareSourceWebUiInputs({ repoDir, outputDir }) {
  const uiProjectDir = join(repoDir, 'apps/ui');
  const requireFromUi = createRequire(join(uiProjectDir, 'package.json'));
  const { build, transform, stop } = requireFromUi('esbuild');
  const packages = await readWorkspacePackages(repoDir);
  const uiPackage = JSON.parse(await readFile(join(uiProjectDir, 'package.json'), 'utf8'));
  const plugins = [...packages].filter(([name, { manifest }]) => (
    name.startsWith('@happier-dev/plugins-') && uiPackage.dependencies?.[name]
    && listBundledPluginUiArtifactExports(manifest).length > 0
  )).sort(([left], [right]) => left.localeCompare(right));
  const inputsDir = join(outputDir, 'inputs');
  await mkdir(inputsDir);
  const toolsDir = join(outputDir, 'tools');
  await mkdir(toolsDir);
  // Preparation tooling resolves installed third-party support from each real
  // importer. Served web output has no dependency or first-party source links.
  const preparationPath = join(toolsDir, 'prepare.mjs');
  const source = [
    `import { prepareSourcePluginUiArtifacts } from ${JSON.stringify(join(uiProjectDir, 'scripts/prepareSourcePluginUiArtifacts.mjs'))};`,
    `import { readWorkspacePackages, resolveWorkspaceSource } from ${JSON.stringify(join(repoDir, 'apps/stack/scripts/build/build_source_runtime.mjs'))};`,
    ...plugins.map(([name], index) => `import { PLUGIN_MANIFEST as manifest${index} } from ${JSON.stringify(`${name}/manifest`)};`),
    `const workspaces = await readWorkspacePackages(${JSON.stringify(repoDir)});`,
    `await prepareSourcePluginUiArtifacts({repoRoot:${JSON.stringify(repoDir)},outputDir:${JSON.stringify(inputsDir)},resolveSourceImport(specifier) { const name = specifier.split('/').slice(0,specifier.startsWith('@') ? 2 : 1).join('/'); if (workspaces.has(name) || specifier.startsWith('@happier-dev/')) return resolveWorkspaceSource(workspaces,specifier); },plugins:[${plugins.map(([name], index) => (
      `{directory:${JSON.stringify(name.slice('@happier-dev/plugins-'.length))},manifest:manifest${index}}`
    )).join(',')}]});`,
  ].join('\n');
  const toolStartedAt = performance.now();
  try {
    const preparation = await build({
      stdin: { contents: source, resolveDir: uiProjectDir, sourcefile: 'source-ui-preparation.mjs' },
      outfile: preparationPath, bundle: true, platform: 'node', format: 'esm',
      conditions: ['happier-source'], metafile: true,
      banner: { js: "import { createRequire as createSourceRequire } from 'node:module'; const require = createSourceRequire(import.meta.url);" },
      plugins: [{ name: 'source-ui-workspace-inputs', setup(builder) {
        builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
          const contents = await readFile(path, 'utf8');
          if (!contents.includes('import.meta.url')) return undefined;
          const loader = ['.ts', '.mts', '.cts'].includes(extname(path)) ? 'ts' : extname(path) === '.tsx' ? 'tsx' : extname(path) === '.jsx' ? 'jsx' : 'js';
          const transformed = await transform(contents, {
            loader, format: 'esm', jsx: 'automatic',
            define: { 'import.meta.url': JSON.stringify(pathToFileURL(path).href) },
          });
          return { contents: transformed.code, resolveDir: dirname(path), loader: 'js' };
        });
        builder.onResolve({ filter: /^[^./#]/ }, async (args) => {
          if (args.pluginData?.installedSupport) return undefined;
          const name = args.path.split('/').slice(0, args.path.startsWith('@') ? 2 : 1).join('/');
          if (packages.has(name) || args.path.startsWith('@happier-dev/')) {
            return { path: resolveWorkspaceSource(packages, args.path) };
          }
          const resolved = await builder.resolve(args.path, {
            resolveDir: args.resolveDir, kind: args.kind, pluginData: { installedSupport: true },
          });
          return resolved.errors.length ? { errors: resolved.errors, warnings: resolved.warnings }
            : { path: resolved.path, external: true };
        });
      } }],
    });
    await writeFile(join(toolsDir, 'metafile.json'), JSON.stringify(preparation.metafile));
  } finally {
    // The caller sequences source builders before UI preparation. Release
    // this completed tool compiler before the independent SDK/Metro phases.
    stop();
  }
  console.log(`[source-ui] phase=tool-bundle elapsedMs=${Math.round(performance.now() - toolStartedAt)}`);
  const preparationStartedAt = performance.now();
  await run(process.execPath, [preparationPath], { cwd: uiProjectDir, env: process.env });
  console.log(`[source-ui] phase=plugin-ui-preparation elapsedMs=${Math.round(performance.now() - preparationStartedAt)} plugins=${plugins.length}`);
}

// Preparation and external Expo export acquire the same host admission envelope
// sequentially, never as nested reservations.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareSourceWebUiInputs(JSON.parse(process.argv[2]));
}
