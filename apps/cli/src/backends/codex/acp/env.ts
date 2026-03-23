import { delimiter, resolve } from 'node:path';

import { resolveCliRuntimeRootPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';

export function buildCodexAcpEnvOverrides(params?: {
  baseEnv?: NodeJS.ProcessEnv;
  projectDir?: string;
}): NodeJS.ProcessEnv {
  const projectDir = params?.projectDir ?? resolveCliRuntimeRootPath();
  const shimsDir = resolve(projectDir, 'scripts', 'shims');
  const explicitBasePath = typeof params?.baseEnv?.PATH === 'string' ? params.baseEnv.PATH : '';
  const inheritedPath = typeof process.env.PATH === 'string' ? process.env.PATH : '';
  const basePath = (explicitBasePath || inheritedPath).trim();

  const PATH = !basePath ? shimsDir : `${shimsDir}${delimiter}${basePath}`;
  const env: NodeJS.ProcessEnv = {
    ...(params?.baseEnv ?? {}),
    PATH,
  };
  // Force Codex ACP to start a fresh thread (avoid accidental continue-from-previous-thread behavior).
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  delete env.CODEX_SHELL;
  return env;
}
