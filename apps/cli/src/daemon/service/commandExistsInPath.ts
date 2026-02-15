import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';

function normalizePathList(envPath: string | undefined): string[] {
  return String(envPath ?? '')
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
}

function normalizePathext(pathext: string | undefined): string[] {
  const raw = String(pathext ?? '').trim() || '.EXE;.CMD;.BAT;.COM';
  const parts = raw
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  // Ensure each extension starts with a dot and is lowercase for comparisons.
  return parts.map((p) => (p.startsWith('.') ? p : `.${p}`)).map((p) => p.toLowerCase());
}

export function commandExistsInPath(params: Readonly<{
  cmd: string;
  envPath: string | undefined;
  platform: NodeJS.Platform;
  pathext?: string | undefined;
}>): boolean {
  const cmd = String(params.cmd ?? '').trim();
  if (!cmd) return false;

  const pathDirs = normalizePathList(params.envPath);
  if (pathDirs.length === 0) return false;

  if (params.platform !== 'win32') {
    for (const dir of pathDirs) {
      const full = join(dir, cmd);
      if (existsSync(full)) return true;
    }
    return false;
  }

  const exts = normalizePathext(params.pathext);
  const cmdLower = cmd.toLowerCase();
  const hasExt = exts.some((ext) => cmdLower.endsWith(ext));
  const candidates = hasExt ? [cmd] : [cmd, ...exts.map((ext) => `${cmd}${ext}`)];

  for (const dir of pathDirs) {
    for (const c of candidates) {
      const full = join(dir, c);
      if (existsSync(full)) return true;
    }
  }
  return false;
}

