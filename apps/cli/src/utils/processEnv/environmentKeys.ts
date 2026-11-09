// Machine paths belong in filtered Windows environments; user/native-login
// homes remain owned by the launch or isolated Runner storage policy.
const WINDOWS_SYSTEM_ENV_KEYS: ReadonlySet<string> = new Set([
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'COMPUTERNAME',
  'OS',
  'PROCESSOR_ARCHITECTURE',
]);
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function isWindowsSystemEnvKey(key: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && WINDOWS_SYSTEM_ENV_KEYS.has(key.toUpperCase());
}

export function isValidProcessEnvKey(key: string, platform: NodeJS.Platform = process.platform): boolean {
  // Windows system names with parentheses cannot use POSIX assignment grammar.
  return ENVIRONMENT_VARIABLE_NAME_PATTERN.test(key) || isWindowsSystemEnvKey(key, platform);
}
