import os from 'node:os';
import { isAbsolute, join } from 'node:path';

export type ScopedPromptAssetRootConfig = Readonly<{
  projectRootPath: readonly string[];
  projectRootDisplayPath: string;
  userRootPath: readonly string[];
  userRootDisplayPath: string;
}>;

export type ScopedPromptAssetRootResolution =
  | Readonly<{
      ok: true;
      rootPath: string;
      displayRoot: string;
    }>
  | Readonly<{
      ok: false;
      error: string;
    }>;

function resolvePromptAssetHomedir(depsHomedir?: (() => string) | undefined): string {
  return typeof depsHomedir === 'function' ? depsHomedir() : os.homedir();
}

export function resolveScopedPromptAssetRoot(params: Readonly<{
  scope: 'user' | 'project';
  directory?: string | null | undefined;
  homedir?: () => string;
  config: ScopedPromptAssetRootConfig;
}>): ScopedPromptAssetRootResolution {
  if (params.scope === 'project') {
    const directory = typeof params.directory === 'string' ? params.directory.trim() : '';
    if (!directory) {
      return { ok: false, error: 'directory is required for project-scoped prompt assets' };
    }
    if (!isAbsolute(directory)) {
      return { ok: false, error: 'directory must be an absolute path for project-scoped prompt assets' };
    }
    return {
      ok: true,
      rootPath: join(directory, ...params.config.projectRootPath),
      displayRoot: params.config.projectRootDisplayPath,
    };
  }

  const homeDirectory = resolvePromptAssetHomedir(params.homedir);
  return {
    ok: true,
    rootPath: join(homeDirectory, ...params.config.userRootPath),
    displayRoot: params.config.userRootDisplayPath,
  };
}
