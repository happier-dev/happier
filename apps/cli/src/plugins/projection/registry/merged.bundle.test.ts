import { once } from 'node:events';
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';

// Compilation belongs to collection, not an operation deadline. Execute the
// emitted split import in a fresh process against the real bundled declarations.
const observation = await observeCompiledSelection();

async function observeCompiledSelection() {
  const cliRoot = projectPath();
  const repoDir = join(cliRoot, '../..');
  const temporaryRoot = join(cliRoot, 'node_modules/.cache');
  await mkdir(temporaryRoot, { recursive: true });
  return withTempDir('provider-selection-bundle-', async directory => {
    const { readWorkspacePackages, createWorkspaceSourceResolver, SOURCE_RUNTIME_OUTPUT_OPTIONS } = await import(
      /* @vite-ignore */ pathToFileURL(join(repoDir, 'packages/cli-common/sourceRuntimeEntries.mjs')).href
    );
    await Promise.all([
      cp(join(cliRoot, 'assets/bundled-plugin-manifests'), join(directory, 'assets/bundled-plugin-manifests'), { recursive: true }),
      cp(join(cliRoot, 'package.json'), join(directory, 'package.json')),
    ]);
    await build({
      absWorkingDir: repoDir,
      entryPoints: [join(cliRoot, 'src/plugins/projection/registry/merged.ts')],
      outdir: join(directory, 'dist'),
      outExtension: { '.js': '.mjs' },
      bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20',
      ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
      conditions: ['happier-source'], tsconfig: join(cliRoot, 'tsconfig.json'), logLevel: 'silent',
      plugins: [createWorkspaceSourceResolver({ workspacePackages: await readWorkspacePackages(repoDir),
        requireFromProject: createRequire(join(cliRoot, 'package.json')) })],
    });
    const bundle = pathToFileURL(join(directory, 'dist/merged.mjs')).href;
    const child = spawnTestProcess(process.execPath, ['--input-type=module', '--eval', `
      const { resolveMergedContributionRegistry } = await import(${JSON.stringify(bundle)});
      const registry = await resolveMergedContributionRegistry({ happyHomeDir: ${JSON.stringify(join(directory, 'home'))},
        providerContributionKeys: ['happier.provider.deepseek/deepseek'] });
      process.stdout.write(JSON.stringify({ keys: [...registry.providersByContributionKey.keys()],
        name: registry.providersByContributionKey.get('happier.provider.deepseek/deepseek')?.definition.name,
        actions: registry.actions.length, agents: registry.agents.length }) + '\\n');
    `], { cwd: cliRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { errors += String(chunk); });
    const [code] = await once(child, 'close');
    if (code !== 0) throw new Error(`Compiled Provider selection exited ${code}: ${errors}`);
    return JSON.parse(output) as Readonly<{ keys: readonly string[]; name: string; actions: number; agents: number }>;
  }, temporaryRoot);
}

it('loads the compiled registry dynamic import and selects the real Provider declaration', () => {
  expect(observation).toEqual({ keys: ['happier.provider.deepseek/deepseek'], name: 'DeepSeek', actions: 0, agents: 0 });
});
