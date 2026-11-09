import { existsSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectInternalRuntimeWorkspaceDepNames,
  resolveInstalledRuntimePackage,
} from '@happier-dev/cli-common/workspaceRuntimeDependencies';

/** Source QA packages retain authored inputs; only an author operation needs
 * their declarations. Published packages already contain declarations and do
 * not enter this path. The caller owns the temporary materialization. */
export async function emitSourceAuthorDeclarations(
  packageRoots: readonly string[],
  compile: (projectPath: string) => Promise<void>,
): Promise<void> {
  const visited = new Set<string>();
  const emit = async (packageRoot: string): Promise<void> => {
    if (visited.has(packageRoot)) return;
    visited.add(packageRoot);
    const sourceRoot = join(packageRoot, 'dist', '.happier-source');
    const projectPath = join(sourceRoot, 'tsconfig.json');
    if (!existsSync(projectPath)) return;
    const manifest: Record<string, unknown> = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
    for (const packageName of collectInternalRuntimeWorkspaceDepNames(manifest)) {
      const dependency = resolveInstalledRuntimePackage({
        packageName, resolveFromPackageJsonPath: join(packageRoot, 'package.json'),
      });
      await emit(dependency.packageDir);
    }
    // Recreate the authored relative layout only inside the temporary copy.
    // Relative references to ../node_modules must resolve this physical closure.
    await rename(join(sourceRoot, 'src'), join(packageRoot, 'src'));
    await compile(projectPath);
    // Author installs consume ordinary JS/declarations, not the captured
    // compiler inputs. Keep those only in the immutable source runtime.
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(join(packageRoot, 'src'), { recursive: true, force: true });
  };
  for (const packageRoot of packageRoots) await emit(packageRoot);
}
