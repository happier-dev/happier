import { delimiter, resolve } from 'node:path';

export function buildCodexAcpEnvOverrides(params?: Readonly<{
  baseEnv?: Readonly<Record<string, string | undefined>>;
  projectDir?: string;
}>): Record<string, string> {
  const projectDir = params?.projectDir ?? process.cwd();
  const shimsDir = resolve(projectDir, 'scripts', 'shims');
  const explicitBasePath = typeof params?.baseEnv?.PATH === 'string' ? params.baseEnv.PATH : '';
  const inheritedPath = typeof process.env.PATH === 'string' ? process.env.PATH : '';
  const basePath = (explicitBasePath || inheritedPath).trim();

  const PATH = !basePath ? shimsDir : `${shimsDir}${delimiter}${basePath}`;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(params?.baseEnv ?? {})) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  env.PATH = PATH;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  delete env.CODEX_SHELL;
  return env;
}
