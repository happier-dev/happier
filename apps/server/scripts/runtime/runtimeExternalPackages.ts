import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function getServerRuntimeBundledInteropPackages(): ReadonlySet<string> {
  return new Set(['privacy-kit']);
}

async function resolveInstalledPackageJsonPath(params: Readonly<{
  projectDir: string;
  packageName: string;
}>): Promise<string> {
  const requireFromProject = createRequire(pathToFileURL(resolve(params.projectDir, 'package.json')).href);
  const resolvedEntryPath = requireFromProject.resolve(params.packageName);

  let dir = dirname(resolvedEntryPath);
  for (let i = 0; i < 20; i += 1) {
    const packageJsonPath = resolve(dir, 'package.json');
    try {
      const raw = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as { name?: string };
      if (raw.name === params.packageName) {
        return packageJsonPath;
      }
    } catch {
      // Keep walking upward until we either find the owning package.json or hit filesystem root.
    }

    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Unable to resolve installed package.json for ${params.packageName} from ${params.projectDir}`);
}

async function readPrivacyKitRuntimeDependencies(projectDir: string): Promise<Record<string, string>> {
  const privacyKitPackageJsonPath = await resolveInstalledPackageJsonPath({
    projectDir,
    packageName: 'privacy-kit',
  });
  const privacyKitPackageJson = JSON.parse(await readFile(privacyKitPackageJsonPath, 'utf-8')) as {
    dependencies?: Record<string, string>;
  };

  return { ...(privacyKitPackageJson.dependencies ?? {}) };
}

export async function resolveServerRuntimeTransitiveExternalPackagePatterns(projectDir: string): Promise<string[]> {
  const dependencies = await readPrivacyKitRuntimeDependencies(projectDir);
  return Object.keys(dependencies).flatMap((packageName) => [packageName, `${packageName}/*`]);
}

export async function resolveAdditionalServerRuntimeDependencies(params: Readonly<{
  projectDir: string;
  dependencies: Record<string, string>;
}>): Promise<Record<string, string>> {
  const output = { ...params.dependencies };

  if (typeof output['privacy-kit'] !== 'string') {
    return output;
  }

  const privacyKitDependencies = await readPrivacyKitRuntimeDependencies(params.projectDir);
  for (const [packageName, rawVersion] of Object.entries(privacyKitDependencies)) {
    const version = String(rawVersion ?? '').trim();
    if (!version) continue;
    output[packageName] = version;
  }

  return output;
}
