import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import {
  collectPackageBuildOutputTargets,
  isPackageBuildDistOutputTarget,
  resolvePackageBuildOutputTargetPath,
} from './packageBuildOutputTargets.mjs';

/** Both complete builds and output-only refreshes consume the freshly staged
 * definePlugin projection, never an unrelated packaged-manifest generation. */
export async function withWorkspaceOutputScriptArgs({ packageDir, scriptName, env = process.env }, operation) {
  const args = ['run', '--silent', scriptName];
  const outputDir = env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR?.trim();
  if (scriptName !== 'build:ui' || !outputDir) return await operation(args, env);
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  const manifestExport = packageJson.exports?.['./manifest'];
  if (packageJson.scripts?.[scriptName]?.trim() !== 'happier-plugin-build-ui' || !manifestExport) {
    return await operation(args, env);
  }
  // Both children can reach authored workspace exports through happier-source.
  // Reuse the repository's source runtime so relative emitted .js specifiers
  // resolve to their TypeScript owners, including generated Protocol leaves.
  const childEnv = {
    ...env,
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${new URL('../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url).href}`.trim(),
  };
  const targets = collectPackageBuildOutputTargets({ exports: { './manifest': manifestExport } })
    .filter(target => isPackageBuildDistOutputTarget(target) && /\.(?:mjs|cjs|js)$/.test(target));
  if (targets.length !== 1) throw new Error('Staged plugin UI build requires one emitted manifest module export');
  const modulePath = resolvePackageBuildOutputTargetPath({ packageDir, outputDir, target: targets[0] });
  const temporaryDir = await mkdtemp(join(tmpdir(), 'happier-staged-ui-manifest-'));
  const manifestPath = join(temporaryDir, 'plugin.json');
  try {
    // A fresh process also refreshes the module's relative dependency graph;
    // ESM cache-busting only the manifest would retain stale imported facts.
    const result = await runCommand(process.execPath, ['--input-type=module', '--eval', `
      import { writeFile } from 'node:fs/promises';
      import { pathToFileURL } from 'node:url';
      const { PLUGIN_MANIFEST } = await import(pathToFileURL(process.argv[1]).href);
      if (!PLUGIN_MANIFEST || typeof PLUGIN_MANIFEST !== 'object' || Array.isArray(PLUGIN_MANIFEST)) {
        throw new Error('Emitted plugin manifest must export PLUGIN_MANIFEST');
      }
      await writeFile(process.argv[2], JSON.stringify(PLUGIN_MANIFEST));
    `, modulePath, manifestPath], { cwd: packageDir, env: childEnv, stdio: 'inherit', ownedProcessGroup: true });
    if (result.error) throw result.error;
    if (result.signal || result.status !== 0) throw new Error(`Staged plugin manifest import failed with code ${result.status ?? 'unknown'}`);
    // The SDK's public CLI consumes installed package exports. Repository
    // preparation instead uses the same current-source compiler as the UI
    // inventory, including when installed workspace manifests are stale.
    return await operation(['exec', process.execPath, fileURLToPath(import.meta.url),
      '--manifest-path', manifestPath], childEnv);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [{ buildUniversalPluginUiArtifacts }, { sourcePluginUiBuildOptions }] = await Promise.all([
    import('../../packages/plugin-sdk/src/ui/build/buildUniversalUiArtifacts.ts'),
    import('./sourcePluginUiBuildOptions.mjs'),
  ]);
  await buildUniversalPluginUiArtifacts(process.cwd(), process.argv[3],
    await sourcePluginUiBuildOptions({ repoRoot: fileURLToPath(new URL('../../', import.meta.url)) }));
}
