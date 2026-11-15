import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { copyDirDereferenceContainedSync } from '../../../../packages/cli-common/workspaceRuntimeDependencies.mjs';
import { readSourceRuntimeDependencyIdentity } from './source_author_inputs.mjs';

/** Capture the same external package graph the source dependency owner inventories.
 * Physical packages are copied once; edges retain peer/version resolution and cycles.
 * All links terminate inside this bundle, including plugin and runner imports. */
export function captureRuntimeDependencies({ imports, outputDir, sourceRepoDir, signal }) {
  const packages = new Map();
  const edges = [];
  readSourceRuntimeDependencyIdentity({ imports, signal, onPackage({ name, packageDir, resolveFrom }) {
    const physical = realpathSync(packageDir);
    if (!packages.has(physical)) {
      const target = join(outputDir, 'runtime-dependencies', String(packages.size));
      copyDirDereferenceContainedSync({ sourceDir: physical, destDir: target, dereferenceRootDir: sourceRepoDir,
        shouldCopyPath: path => path === physical || !relative(physical, path).split(/[\\/]/).includes('node_modules') });
      packages.set(physical, target);
    }
    edges.push({ name, physical, resolveFrom });
  } });
  const linked = new Set();
  for (const { name, physical, resolveFrom } of edges) {
    const parent = packages.get(realpathSync(dirname(resolveFrom)));
    const link = join(parent ?? outputDir, 'node_modules', name);
    if (linked.has(link)) continue;
    linked.add(link);
    mkdirSync(dirname(link), { recursive: true });
    const target = packages.get(physical);
    symlinkSync(process.platform === 'win32' ? target : relative(dirname(link), target), link,
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  const capturedImports = imports.map(item => ({ ...item, resolveFrom: join(outputDir, 'package.json') }));
  return { imports: capturedImports, identity: readSourceRuntimeDependencyIdentity({ imports: capturedImports, signal }), captured: true };
}
