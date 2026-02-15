import { join } from 'node:path';

export function resolveServerRunnerTarget({ platform, arch }) {
  const p = String(platform ?? '').trim();
  const a = String(arch ?? '').trim();
  if (!p) {
    throw new Error('Unsupported platform: (empty)');
  }
  if (p !== 'linux' && p !== 'darwin' && p !== 'win32') {
    throw new Error(`Unsupported platform '${p}'. Expected linux|darwin|win32.`);
  }

  const os = p === 'win32' ? 'windows' : p;
  if (a !== 'x64' && a !== 'arm64') {
    throw new Error(`Unsupported architecture '${a}'. Expected x64 or arm64.`);
  }
  if (p === 'win32' && a !== 'x64') {
    throw new Error(`Unsupported architecture '${a}' for windows. Expected x64.`);
  }

  return {
    os,
    arch: a,
    exeName: os === 'windows' ? 'happier-server.exe' : 'happier-server',
  };
}

export function resolveRunnerCacheRoot({ platform, homedir, env }) {
  const p = String(platform ?? '').trim();
  const home = String(homedir ?? '').trim();
  const e = env && typeof env === 'object' ? env : {};

  if (String(e.HAPPIER_CACHE_DIR ?? '').trim()) {
    return String(e.HAPPIER_CACHE_DIR).trim();
  }

  if (p === 'win32') {
    const local = String(e.LOCALAPPDATA ?? '').trim();
    return local || join(home || 'C:\\\\Users\\\\Default', 'AppData', 'Local');
  }
  if (p === 'darwin') {
    return join(home || '', 'Library', 'Caches');
  }
  const xdg = String(e.XDG_CACHE_HOME ?? '').trim();
  if (xdg) return xdg;
  return join(home || '', '.cache');
}

