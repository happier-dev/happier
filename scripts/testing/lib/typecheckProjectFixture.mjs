import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { coerceHappyMonorepoRootFromPath } from '../../../apps/stack/scripts/utils/paths/paths.mjs';
import { resolveTypecheckCacheDirectory } from '../../workspaces/workspaceSourceTypecheck.mjs';

const require = createRequire(new URL('../../../apps/ui/package.json', import.meta.url));

export async function installUiTypecheckFixtureDependencies(t, packageDir) {
  const ownerDir = await mkdtemp(join(tmpdir(), 'happier-compiler-dependency-owner-'));
  t.after(() => rm(ownerDir, { recursive: true, force: true }));
  const ownerCache = join(ownerDir, 'node_modules/.cache/tsc');
  await mkdir(ownerCache, { recursive: true });
  const sentinel = 'dependency-owner cache must remain unchanged\n';
  await writeFile(join(ownerCache, 'router.d.ts'), sentinel);
  await mkdir(join(packageDir, 'node_modules/.cache/tsc'), { recursive: true });
  // Keep writable caches private while using the installed Expo/router code.
  for (const name of ['expo', 'expo-router']) {
    const ownedDependency = join(ownerDir, 'node_modules', name);
    await symlink(dirname(require.resolve(`${name}/package.json`)), ownedDependency,
      process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(ownedDependency, join(packageDir, 'node_modules', name),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  return async inventory => {
    const fixture = await realpath(coerceHappyMonorepoRootFromPath(packageDir) ?? packageDir);
    const cache = resolveTypecheckCacheDirectory(packageDir);
    const outputs = [...inventory.map(({ configPath }) => configPath),
      ...(await readdir(cache).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).map(file => join(cache, file))];
    for (const output of outputs) {
      const path = relative(fixture, await realpath(output));
      assert.ok(!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`),
        `generated compiler input escaped its fixture: ${output}`);
    }
    assert.deepEqual(await readdir(ownerCache), ['router.d.ts'], 'dependency-owner cache gained generated files');
    assert.equal(await readFile(join(ownerCache, 'router.d.ts'), 'utf8'), sentinel,
      'dependency-owner route declaration was overwritten');
  };
}
