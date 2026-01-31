import { homedir } from 'node:os';
import { join } from 'node:path';

export function expandHome(p) {
  return String(p ?? '').replace(/^~(?=\/)/, homedir());
}

export function getCanonicalHomeDirFromEnv(env = process.env) {
  const fromEnv = (env.HAPPY_STACKS_CANONICAL_HOME_DIR ?? '').trim();
  return fromEnv ? expandHome(fromEnv) : join(homedir(), '.happier-stack');
}

export function getCanonicalHomeEnvPathFromEnv(env = process.env) {
  return join(getCanonicalHomeDirFromEnv(env), '.env');
}
