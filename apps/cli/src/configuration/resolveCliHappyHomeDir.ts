import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { expandHomeDirPath } from '../utils/path/expandHomeDirPath';

function isWindowsShapedAbsolutePath(pathLike: string): boolean {
  const value = String(pathLike ?? '').trim();
  if (!value) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  if (value.startsWith('\\\\?\\')) return true;
  if (value.startsWith('\\\\')) return true;
  return false;
}

export function resolveCliHappyHomeDir(env: NodeJS.ProcessEnv): string {
  const override = typeof env.HAPPIER_HOME_DIR === 'string' ? env.HAPPIER_HOME_DIR.trim() : '';
  if (!override) {
    const sudoInvokerHomeDir = resolveSudoInvokerHomeDir(env);
    const baseHomeDir = sudoInvokerHomeDir ?? expandHomeDirPath('~', env);
    return join(baseHomeDir, '.happier');
  }
  const expandedOverride = expandHomeDirPath(override, env);
  if (process.platform !== 'win32' && isWindowsShapedAbsolutePath(expandedOverride)) {
    throw new Error(`Windows-shaped HAPPIER_HOME_DIR overrides are not supported on ${process.platform}`);
  }
  return isAbsolute(expandedOverride) ? expandedOverride : resolvePath(expandedOverride);
}

export function resolveSudoInvokerHomeDir(env: NodeJS.ProcessEnv): string | null {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== 0) return null;
  const sudoUser = typeof env.SUDO_USER === 'string' ? env.SUDO_USER.trim() : '';
  const sudoUidRaw = typeof env.SUDO_UID === 'string' ? env.SUDO_UID.trim() : '';
  const sudoUid = sudoUidRaw ? Number.parseInt(sudoUidRaw, 10) : NaN;
  if (!sudoUser && !Number.isFinite(sudoUid)) return null;

  const parsePasswdHomeDir = (passwdDatabase: string, username?: string, uid?: number): string | null => {
    for (const line of String(passwdDatabase ?? '').split(/\r?\n/u)) {
      if (!line) continue;
      const parts = line.split(':');
      if (parts.length < 7) continue;
      const [name, _pw, uidText, _gid, _gecos, homeDir] = parts;
      const parsedUid = Number.parseInt(uidText, 10);
      const matchesUser = username && name === username;
      const matchesUid = uid != null && Number.isFinite(parsedUid) && parsedUid === uid;
      if (!matchesUser && !matchesUid) continue;
      const candidate = String(homeDir ?? '').trim();
      return candidate.startsWith('/') ? candidate : null;
    }
    return null;
  };

  if (process.platform === 'linux') {
    try {
      const candidateKey = sudoUser || (Number.isFinite(sudoUid) ? String(sudoUid) : '');
      if (candidateKey) {
        const result = spawnSync('getent', ['passwd', candidateKey], {
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          env: process.env,
        });
        if ((result.status ?? 1) === 0) {
          const homeDir = parsePasswdHomeDir(
            String(result.stdout ?? ''),
            sudoUser || undefined,
            Number.isFinite(sudoUid) ? sudoUid : undefined,
          );
          if (homeDir) return homeDir;
        }
      }
    } catch {
      // Fall back to /etc/passwd below.
    }
  }

  try {
    const homeDir = parsePasswdHomeDir(
      String(readFileSync('/etc/passwd', 'utf8')),
      sudoUser || undefined,
      Number.isFinite(sudoUid) ? sudoUid : undefined,
    );
    if (homeDir) return homeDir;
  } catch {
    // Ignore.
  }

  return null;
}
