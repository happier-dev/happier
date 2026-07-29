import { isAbsolute, resolve } from 'node:path';

export function resolveCliProxyApiPrebuiltExecutablePath({
  rawPath,
  targets,
  repoRoot = process.cwd(),
}) {
  const value = String(rawPath ?? '').trim();
  if (!value) return undefined;
  if (targets.length !== 1) {
    throw new Error('[release] --cliproxyapi-managed-runtime-executable requires exactly one CLI target');
  }
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}
