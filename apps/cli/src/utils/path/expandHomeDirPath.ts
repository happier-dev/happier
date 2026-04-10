import { homedir } from 'node:os';
import { join, sep } from 'node:path';

export function resolveHomeDirFromEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const envHome =
    process.platform === 'win32'
      ? (env.USERPROFILE || env.HOME)
      : env.HOME;
  const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
  return trimmed.length > 0 ? trimmed : homedir();
}

export function expandHomeDirPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (value === '~') return resolveHomeDirFromEnvironment(env);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    const normalizedRelativePath = value
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean)
      .join(sep);
    return join(resolveHomeDirFromEnvironment(env), normalizedRelativePath);
  }
  return value;
}
