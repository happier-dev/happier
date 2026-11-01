import { realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveInstalledRuntimePackage } from '@happier-dev/cli-common/workspaceRuntimeDependencies';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { PLUGIN_SDK_PACKAGE_NAME, readPackageJsonRecord, resolvePluginAuthorWorkspaceUiBuilder } from './hostSdkResolution';

/** Package resolution admits hoisted and linked installs; executable bytes stay inside that package. */
function resolveToolPackage(projectRoot: string, packageName: string, aliasPackageName = packageName) {
  const installed = resolveInstalledRuntimePackage({
    packageName,
    resolveFromPackageJsonPath: join(projectRoot, 'package.json'),
  });
  const packageJsonPath = realpathSync(installed.packageJsonPath);
  const packageJson = readPackageJsonRecord(packageJsonPath, `The resolved ${packageName} package`);
  if (packageJson.name !== packageName && packageJson.name !== aliasPackageName) {
    throw new Error(`Resolved tool must come from ${packageName}`);
  }
  return { packageRoot: dirname(packageJsonPath), packageJson };
}

function resolveContainedBin(tool: ReturnType<typeof resolveToolPackage>, packageName: string, binName: string): string {
  const bins = tool.packageJson.bin;
  const relativeBin = bins && typeof bins === 'object' && !Array.isArray(bins) ? Reflect.get(bins, binName) : undefined;
  if (typeof relativeBin !== 'string' || !relativeBin.trim()) {
    throw new Error(`${packageName} does not declare the ${binName} entrypoint`);
  }
  const entrypoint = resolve(tool.packageRoot, relativeBin);
  if (!isCanonicalAbsolutePathInsideRoot(tool.packageRoot, entrypoint)) {
    throw new Error(`Resolved tool entrypoint must remain inside ${packageName}`);
  }
  const physicalEntrypoint = realpathSync(entrypoint);
  if (!statSync(physicalEntrypoint).isFile() || !isCanonicalAbsolutePathInsideRoot(tool.packageRoot, physicalEntrypoint)) {
    throw new Error(`Resolved tool entrypoint must be a contained regular file inside ${packageName}`);
  }
  return physicalEntrypoint;
}

export function resolveNativeTypeScriptBin(projectRoot: string): string {
  // The pinned npm:typescript alias retains Microsoft's published package name.
  const tool = resolveToolPackage(projectRoot, '@typescript/native', 'typescript');
  if (typeof tool.packageJson.version !== 'string' || !/^7\./u.test(tool.packageJson.version)) {
    throw new Error('Resolved @typescript/native package must provide TypeScript 7');
  }
  return resolveContainedBin(tool, '@typescript/native', 'tsc');
}

export function resolvePluginUiBuildBin(projectRoot: string): string | null {
  const resolvedProjectRoot = realpathSync(projectRoot);
  const projectPackageJson = readPackageJsonRecord(join(resolvedProjectRoot, 'package.json'), 'The plugin project');
  const declaresSdk = ['dependencies', 'devDependencies'].some(field => {
    const dependencies = projectPackageJson[field];
    return dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)
      && typeof Reflect.get(dependencies, PLUGIN_SDK_PACKAGE_NAME) === 'string';
  });
  if (!declaresSdk) return null;
  const sourceBuilder = resolvePluginAuthorWorkspaceUiBuilder(resolvedProjectRoot);
  if (sourceBuilder) return sourceBuilder;
  return resolveContainedBin(resolveToolPackage(resolvedProjectRoot, PLUGIN_SDK_PACKAGE_NAME),
    PLUGIN_SDK_PACKAGE_NAME, 'happier-plugin-build-ui');
}
