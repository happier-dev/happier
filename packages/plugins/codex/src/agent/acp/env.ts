import { delimiter, resolve } from 'node:path';

export const CODEX_ACP_TIMEOUT_ENV_KEYS = {
  initialize: 'HAPPIER_CODEX_ACP_INIT_TIMEOUT_MS',
  npxInitialize: 'HAPPIER_CODEX_ACP_NPX_INIT_TIMEOUT_MS',
  preToolCallIdle: 'HAPPIER_CODEX_ACP_PRE_TOOL_IDLE_TIMEOUT_MS',
} as const;

export function buildCodexAcpEnvOverrides(params?: Readonly<{
  baseEnv?: Readonly<Record<string, string | undefined>>;
  projectDir?: string;
}>): Record<string, string> {
  const projectDir = params?.projectDir ?? process.cwd();
  const shimsDir = resolve(projectDir, 'scripts', 'shims');
  const basePath = ((params?.baseEnv === undefined ? process.env.PATH : params.baseEnv.PATH) ?? '').trim();

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
