import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type LinuxSystemUserPaths = Readonly<{
  userHomeDir: string;
  happierHomeDir: string;
}>;

function parseLinuxPasswdHomeDir(passwdDatabase: string, systemUser: string): string | null {
  const normalizedSystemUser = String(systemUser ?? '').trim();
  if (!normalizedSystemUser) return null;

  for (const line of String(passwdDatabase ?? '').split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split(':');
    if (fields[0] !== normalizedSystemUser) continue;
    const homeDir = String(fields[5] ?? '').trim();
    if (homeDir) return homeDir;
  }

  return null;
}

function resolveLinuxSystemUserHomeDir(systemUser: string, deadlineMs?: number): string {
  const normalizedSystemUser = String(systemUser ?? '').trim();
  if (!normalizedSystemUser) {
    throw new Error('systemUser is required');
  }

  try {
    const timeout = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
    if (timeout !== undefined && timeout <= 0) throw new Error('System user lookup deadline elapsed');
    const result = spawnSync('getent', ['passwd', normalizedSystemUser], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: process.env,
      ...(timeout === undefined ? {} : { timeout }),
    });
    if ((result.status ?? 1) === 0) {
      const homeDir = parseLinuxPasswdHomeDir(String(result.stdout ?? ''), normalizedSystemUser);
      if (homeDir) return homeDir;
    }
  } catch {
    // Fall back to /etc/passwd when getent is unavailable.
  }

  try {
    const homeDir = parseLinuxPasswdHomeDir(readFileSync('/etc/passwd', 'utf8'), normalizedSystemUser);
    if (homeDir) return homeDir;
  } catch {
    // Ignore and throw a targeted error below.
  }

  throw new Error(`Unable to resolve home directory for system user "${normalizedSystemUser}"`);
}

export function resolveLinuxSystemUserPaths(params: Readonly<{
  systemUser: string;
  userHomeDirOverride?: string | null;
  happierHomeDirOverride?: string | null;
  deadlineMs?: number;
}>): LinuxSystemUserPaths {
  const userHomeDirOverride = String(params.userHomeDirOverride ?? '').trim();
  const userHomeDir = userHomeDirOverride || resolveLinuxSystemUserHomeDir(params.systemUser, params.deadlineMs);
  const happierHomeDirOverride = String(params.happierHomeDirOverride ?? '').trim();

  return {
    userHomeDir,
    happierHomeDir: happierHomeDirOverride || join(userHomeDir, '.happier'),
  };
}
