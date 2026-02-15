import { join } from 'node:path';

export function buildCodeRabbitEnv(args: Readonly<{ baseEnv: NodeJS.ProcessEnv; homeDir: string | null | undefined }>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...(args.baseEnv ?? {}) };
  const dir = String(args.homeDir ?? '').trim();
  if (!dir) return merged;

  // IMPORTANT: Do not override HOME/USERPROFILE.
  // CodeRabbit uses OS credential storage (e.g. macOS Keychain); pointing HOME at an isolated
  // directory can cause keychain lookup failures. We only isolate CodeRabbit's config/cache
  // directories via CODERABBIT_HOME + XDG dirs.
  merged.CODERABBIT_HOME = join(dir, '.coderabbit');
  merged.XDG_CONFIG_HOME = join(dir, '.config');
  merged.XDG_CACHE_HOME = join(dir, '.cache');
  merged.XDG_STATE_HOME = join(dir, '.local', 'state');
  merged.XDG_DATA_HOME = join(dir, '.local', 'share');
  return merged;
}

