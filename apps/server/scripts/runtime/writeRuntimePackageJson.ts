import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveAdditionalServerRuntimeDependencies } from './runtimeExternalPackages';

type RuntimePackageJson = Readonly<{
  name: string;
  version: string;
  private: true;
  type: string;
  dependencies: Record<string, string>;
}>;

export async function writeRuntimePackageJson({
  projectDir,
  destRoot,
}: Readonly<{ projectDir: string; destRoot: string }>): Promise<RuntimePackageJson> {
  const packageJsonPath = resolve(projectDir, 'package.json');
  const raw = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as {
    name?: string;
    version?: string;
    type?: string;
    dependencies?: Record<string, string>;
  };

  const output: RuntimePackageJson = {
    name: String(raw.name ?? '@happier-dev/server'),
    version: String(raw.version ?? '0.0.0'),
    private: true,
    type: String(raw.type ?? 'module'),
    dependencies: await resolveAdditionalServerRuntimeDependencies({
      projectDir,
      dependencies: { ...(raw.dependencies ?? {}) },
    }),
  };

  await mkdir(resolve(destRoot), { recursive: true });
  await writeFile(join(destRoot, 'package.json'), JSON.stringify(output, null, 2) + '\n', 'utf-8');

  return output;
}
