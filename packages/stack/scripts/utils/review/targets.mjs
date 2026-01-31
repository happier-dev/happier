import { getComponentsDir, getComponentDir } from '../paths/paths.mjs';
import { join } from 'node:path';

export function isStackMode(env = process.env) {
  const stack = String(env.HAPPIER_STACK_STACK ?? '').trim();
  const envFile = String(env.HAPPIER_STACK_ENV_FILE ?? '').trim();
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
