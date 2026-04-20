import { homedir as osHomedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

type Deps = Readonly<{
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  cwd: () => string;
}>;

/**
 * Machine/daemon RPC handlers need a stable default directory for relative paths.
 *
 * Filesystem authorization is resolved separately by the filesystem access policy. Do not use
 * `HAPPIER_MACHINE_RPC_WORKING_DIRECTORY` here; that env var is an explicit restriction policy,
 * not the default relative-path base.
 */
export function resolveMachineRpcWorkingDirectory(overrides?: Partial<Deps>): string {
  const env = overrides?.env ?? process.env;
  const cwd = overrides?.cwd ?? process.cwd;
  const fallbackHomedir = overrides?.homedir ?? osHomedir;

  const envHomeRaw = process.platform === 'win32'
    ? (env.USERPROFILE || env.HOME)
    : env.HOME;
  const envHomeDir = typeof envHomeRaw === 'string' ? envHomeRaw.trim() : '';
  const candidates = [envHomeDir || fallbackHomedir(), cwd()];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = String(candidate).trim();
    if (!value) continue;
    if (!isAbsolute(value)) continue;
    return resolve(value);
  }

  return resolve(cwd());
}
