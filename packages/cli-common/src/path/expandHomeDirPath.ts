import { homedir } from 'node:os';
import { join, sep } from 'node:path';

function resolveHomeDirFromEnvironment(processEnv: NodeJS.ProcessEnv = process.env): string {
  const envHome =
    process.platform === 'win32'
      ? (processEnv.USERPROFILE || processEnv.HOME)
      : processEnv.HOME;
  const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
  return trimmed.length > 0 ? trimmed : homedir();
}

export function expandHomeDirPath(value: string, processEnv: NodeJS.ProcessEnv = process.env): string {
  if (value === '~') return resolveHomeDirFromEnvironment(processEnv);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    const normalizedRelativePath = value
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean)
      .join(sep);
    return join(resolveHomeDirFromEnvironment(processEnv), normalizedRelativePath);
  }
  return value;
}
