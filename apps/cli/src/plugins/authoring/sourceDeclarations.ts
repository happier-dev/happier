import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import {
  collectExternalRuntimeDependencies,
  collectInternalRuntimeWorkspaceDepNames,
  resolveInstalledRuntimeDependency,
  resolveInstalledRuntimePackage,
} from '@happier-dev/cli-common/workspaceRuntimeDependencies';

/** Source QA packages retain authored inputs; only an author operation needs
 * their declarations. Published packages already contain declarations and do
 * not enter this path. The caller owns the temporary materialization. */
export async function emitSourceAuthorDeclarations(
  packageRoots: readonly string[],
  compile: (projectPath: string, workingDirectory: string) => Promise<void>,
): Promise<void> {
  const visited = new Set<string>();
  const emit = async (packageRoot: string): Promise<void> => {
    if (visited.has(packageRoot)) return;
    visited.add(packageRoot);
    const sourceRoot = join(packageRoot, 'dist', '.happier-source');
    const projectPath = join(sourceRoot, 'tsconfig.json');
    if (!existsSync(projectPath)) return;
    const manifestSource = await readFile(join(sourceRoot, 'package.json'), 'utf8');
    const manifest: Record<string, unknown> = JSON.parse(manifestSource);
    const dependencies = new Map<string, string>();
    for (const packageName of collectInternalRuntimeWorkspaceDepNames(manifest)) {
      const dependency = resolveInstalledRuntimePackage({
        packageName, resolveFromPackageJsonPath: join(packageRoot, 'package.json'),
      });
      await emit(dependency.packageDir);
      dependencies.set(packageName, dependency.packageDir);
    }
    for (const dependency of collectExternalRuntimeDependencies(manifest)) {
      const resolved = resolveInstalledRuntimeDependency({
        dependency, resolveFromPackageJsonPath: join(packageRoot, 'package.json'),
      });
      if (resolved) dependencies.set(dependency.name, resolved.packageDir);
    }
    // Native declaration inference treats source below node_modules as an
    // installed dependency, producing non-portable names for inferred types.
    // Recreate the authored source layout outside it, using this same closure.
    const workingDirectory = createHappierTempDir({ purpose: 'plugin-author-declarations' });
    try {
      const compilerInputs = join(workingDirectory, 'dist', '.happier-source');
      // Captured files may be read-only; write the adjusted project afresh.
      await cp(sourceRoot, compilerInputs, {
        recursive: true, filter: sourcePath => sourcePath !== projectPath,
      });
      await rename(join(compilerInputs, 'src'), join(workingDirectory, 'src'));
      await writeFile(join(workingDirectory, 'package.json'), manifestSource);
      // Ambient packages must be visible beside src, just like runtime
      // dependencies. A nested typeRoots lookup makes inferred JSX types name
      // the capture directory rather than the public react/jsx-runtime module.
      const capturedModules = join(compilerInputs, 'node_modules');
      if (existsSync(capturedModules)) {
        await rename(capturedModules, join(workingDirectory, 'node_modules'));
      }
      for (const [packageName, dependencyRoot] of dependencies) {
        const destination = join(workingDirectory, 'node_modules', packageName);
        // The capture already owns ambient dependencies such as @types/node.
        if (existsSync(destination)) continue;
        await mkdir(dirname(destination), { recursive: true });
        await symlink(dependencyRoot, destination, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const compilerProject = join(compilerInputs, 'tsconfig.json');
      const project: { compilerOptions: Record<string, unknown> } = JSON.parse(await readFile(projectPath, 'utf8'));
      project.compilerOptions.outDir = join(packageRoot, 'dist');
      project.compilerOptions.typeRoots = ['../../node_modules/@types'];
      await writeFile(compilerProject, JSON.stringify(project));
      await compile(compilerProject, workingDirectory);
    } finally {
      await removeHappierTempDirAsync(workingDirectory);
    }
    // Author installs consume ordinary JS/declarations, not the captured
    // compiler inputs. Keep those only in the immutable source runtime.
    await rm(sourceRoot, { recursive: true, force: true });
  };
  for (const packageRoot of packageRoots) await emit(packageRoot);
}
