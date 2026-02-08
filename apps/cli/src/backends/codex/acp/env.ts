import { delimiter, resolve } from 'node:path';

import { projectPath } from '@/projectPath';

export function buildCodexAcpEnvOverrides(params?: {
  baseEnv?: { PATH?: string };
  projectDir?: string;
}): { PATH: string } {
  const projectDir = params?.projectDir ?? projectPath();
  const shimsDir = resolve(projectDir, 'scripts', 'shims');
  const basePath = (params?.baseEnv ? params.baseEnv.PATH ?? '' : process.env.PATH ?? '').trim();

  if (!basePath) return { PATH: shimsDir };
  return { PATH: `${shimsDir}${delimiter}${basePath}` };
}
