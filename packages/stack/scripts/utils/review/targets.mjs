import { getComponentsDir, getComponentDir } from '../paths/paths.mjs';
import { join } from 'node:path';

export function isStackMode(env = process.env) {
  const stack = String(env.HAPPY_STACKS_STACK ?? env.HAPPY_LOCAL_STACK ?? '').trim();
  const envFile = String(env.HAPPY_STACKS_ENV_FILE ?? env.HAPPY_LOCAL_ENV_FILE ?? '').trim();
  return Boolean(stack && envFile);
}

export function defaultComponentCheckoutDir(rootDir, component) {
  return join(getComponentsDir(rootDir), component);
}

export function resolveDefaultStackReviewComponents({ rootDir, components }) {
  const list = Array.isArray(components) ? components : [];
  const out = [];
  for (const c of list) {
    const effective = getComponentDir(rootDir, c);
    const def = defaultComponentCheckoutDir(rootDir, c);
    if (effective !== def) out.push(c);
  }
  return out;
}

