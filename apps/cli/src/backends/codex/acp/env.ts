import { delimiter, resolve } from 'node:path';

import { projectPath } from '@/projectPath';

export function buildCodexAcpEnvOverrides(params?: {
  baseEnv?: { PATH?: string };
  projectDir?: string;
}): NodeJS.ProcessEnv {
  const projectDir = params?.projectDir ?? projectPath();
  const shimsDir = resolve(projectDir, 'scripts', 'shims');
  const basePath = (params?.baseEnv ? params.baseEnv.PATH ?? '' : process.env.PATH ?? '').trim();

  const PATH = !basePath ? shimsDir : `${shimsDir}${delimiter}${basePath}`;
  return {
    PATH,
    // Force Codex ACP to start a fresh thread (avoid accidental continue-from-previous-thread behavior).
    CODEX_THREAD_ID: undefined,
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
    CODEX_SHELL: undefined,
  };
}
