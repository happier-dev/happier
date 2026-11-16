import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const sourcePath = fileURLToPath(new URL('./workspaceSource.ts', import.meta.url));

/**
 * Bundle with chunk splitting like the shipped CLI, enter the graph from every
 * listed module first, and report what the unbound default resolves to. A
 * module cycle that captured the local source eagerly (LAUNCH-REGRESS-1112)
 * prints `undefined` here instead of failing native Agent preparation live.
 */
async function resolveDefaultThroughBundle(dir: string, workspaceSourceModule: string, firstImports: readonly string[]): Promise<string[]> {
  const entries = await Promise.all(firstImports.map(async (first, index) => {
    const entry = join(dir, `entry-${index}.ts`);
    await writeFile(entry, `
import * as first from ${JSON.stringify(first)};
import { currentWorkspaceSource } from ${JSON.stringify(workspaceSourceModule)};
void first;
console.log(String(currentWorkspaceSource()?.kind));
`, 'utf8');
    return entry;
  }));
  // Native-addon packages stay external and resolve from the package's own node_modules,
  // so the bundle is written beneath it (ignored, removed after the run).
  const outdir = join(packageRoot, 'node_modules', '.cache', `workspace-source-bundle-${randomUUID()}`);
  cleanup.push(outdir);
  // The shipped CLI artifact's own bundler settings: source condition, workspace resolver,
  // runtime externals and chunk splitting (buildCliBinaryArtifactPayload.ts).
  const { SOURCE_CONDITION, SOURCE_RUNTIME_COMMONJS_BANNER, SOURCE_RUNTIME_COMMONJS_DEFINE, SOURCE_RUNTIME_OUTPUT_OPTIONS, createWorkspaceSourceResolver, readWorkspacePackages } =
    await import('@happier-dev/cli-common/sourceRuntimeEntries');
  const { CLI_RUNTIME_EXTERNAL_PACKAGES } = await import('@happier-dev/cli-common/componentArtifacts');
  const repoRoot = join(packageRoot, '..', '..');
  await build({ absWorkingDir: repoRoot, entryPoints: entries, outdir, bundle: true, splitting: true, platform: 'node', format: 'esm',
    target: 'node20', ...SOURCE_RUNTIME_OUTPUT_OPTIONS, conditions: [SOURCE_CONDITION], banner: { js: SOURCE_RUNTIME_COMMONJS_BANNER }, define: SOURCE_RUNTIME_COMMONJS_DEFINE, logLevel: 'silent',
    plugins: [createWorkspaceSourceResolver({ workspacePackages: await readWorkspacePackages(repoRoot),
      requireFromProject: createRequire(join(packageRoot, 'package.json')), externalPackages: [...CLI_RUNTIME_EXTERNAL_PACKAGES] })] });
  return entries.map((_entry, index) => {
    const result = spawnSync(process.execPath, [join(outdir, `entry-${index}.js`)], { cwd: dir, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : `failed: ${result.stderr.trim().split('\n').filter(line => /Error/.test(line)).slice(0, 2).join(' | ')}`;
  });
}

describe('workspace source default in a bundled chunk graph', () => {
  it('resolves this Machine\'s disk whichever module enters the graph first', async () => {
    await withTempDir('happier-workspace-source-bundle-', async dir => {
      const consumers = ['./localWorkspaceSource.ts', '../../integrations/ripgrep/index.ts', '../../integrations/difftastic/index.ts',
        '../../rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization.ts']
        .map(path => fileURLToPath(new URL(path, import.meta.url)));
      expect(await resolveDefaultThroughBundle(dir, sourcePath, [sourcePath, ...consumers])).toEqual(consumers.map(() => 'local').concat('local'));
    });
  }, 120_000);

  it.each([
    ['eager capture (pre-repair)', 'let unboundSource = localWorkspaceSource;\nexport function currentWorkspaceSource() { return unboundSource; }', false],
    ['call-time fallback (repair)', 'let unboundSource;\nexport function currentWorkspaceSource() { return unboundSource ?? localWorkspaceSource; }', true],
  ] as const)('a local source that imports back into the port: %s', async (_name, body, resolves) => {
    await withTempDir('happier-workspace-source-bundle-cycle-', async dir => {
      // The loaded LAUNCH-REGRESS-1112 graph: the local source module imports back into the port.
      const port = join(dir, 'port.ts');
      const cyclicLocal = join(dir, 'cyclicLocal.ts');
      await writeFile(port, `import { localWorkspaceSource } from ${JSON.stringify(cyclicLocal)};\n${body}\n`, 'utf8');
      await writeFile(cyclicLocal, `
import { currentWorkspaceSource } from ${JSON.stringify(port)};
export const readCurrent = () => currentWorkspaceSource();
export const localWorkspaceSource = { kind: 'local', id: 'local' };
`, 'utf8');
      const [result] = await resolveDefaultThroughBundle(dir, port, [cyclicLocal]);
      if (resolves) expect(result).toBe('local');
      else expect(result).not.toBe('local');
    });
  }, 120_000);
});
