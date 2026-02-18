import { execSync as execSyncImpl } from 'node:child_process';

function isDisabled(value: string | undefined): boolean {
  const raw = (value ?? '').toString().trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return lower === '0' || lower === 'false' || lower === 'off' || lower === 'no';
}

export function ensureWindowsUtf8CodePage(params?: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  execSync?: typeof execSyncImpl;
}): boolean {
  const platform = params?.platform ?? process.platform;
  if (platform !== 'win32') return false;

  const env = params?.env ?? process.env;
  const isTTY = params?.isTTY ?? Boolean(process.stdout.isTTY || process.stderr.isTTY);

  // Allow disabling, since changing the code page can be surprising in some environments.
  if (isDisabled(env.HAPPIER_WINDOWS_UTF8_CODEPAGE)) return false;

  // Only attempt when attached to a terminal; avoid touching code page in non-interactive contexts.
  if (!isTTY) return false;

  const execSync = params?.execSync ?? execSyncImpl;
  const shell = env.ComSpec || 'cmd.exe';

  try {
    // Suppress output; we only care about side effects.
    execSync('chcp 65001 >NUL', { stdio: 'ignore', windowsHide: true, shell });
    return true;
  } catch {
    return false;
  }
}

