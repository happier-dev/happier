import { isAllowedExactEnvKey } from './isAllowedExactEnvKey';

// Shared baseline for filtered Windows process environments. Preserve inherited
// values and spelling; paths may differ from the standard C: installation.
const WINDOWS_SYSTEM_ENV_KEYS: ReadonlySet<string> = new Set([
  'USERPROFILE',
  'USERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ProgramData',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'COMPUTERNAME',
  'OS',
  'PROCESSOR_ARCHITECTURE',
]);

export function isWindowsSystemEnvKey(key: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && isAllowedExactEnvKey(key, WINDOWS_SYSTEM_ENV_KEYS, platform);
}
