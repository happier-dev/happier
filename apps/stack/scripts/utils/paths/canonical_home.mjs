import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveHomeDirFromEnv(env = process.env) {
  const candidate = process.platform === 'win32'
    ? (env?.USERPROFILE ?? env?.HOME)
    : env?.HOME;
  const trimmed = String(candidate ?? '').trim();
  return trimmed || homedir();
}

export function expandHome(p, env = process.env) {
  return String(p ?? '').replace(/^~(?=[/\\])/, resolveHomeDirFromEnv(env));
}

export function getCanonicalHomeDirFromEnv(env = process.env) {
  const fromEnv = (env.HAPPIER_STACK_CANONICAL_HOME_DIR ?? '').trim();
  return fromEnv ? expandHome(fromEnv, env) : join(resolveHomeDirFromEnv(env), '.happier-stack');
}

export function getCanonicalHomeEnvPathFromEnv(env = process.env) {
  return join(getCanonicalHomeDirFromEnv(env), '.env');
}
