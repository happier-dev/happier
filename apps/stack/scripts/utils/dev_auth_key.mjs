import { getHappyStacksHomeDir } from './paths/paths.mjs';

export * from './auth/dev_key.mjs';

export function resolveHappyStacksHomeDir(env = process.env) {
  return getHappyStacksHomeDir(env);
}
