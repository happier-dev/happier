import { basename, join } from 'node:path';

export function resolveAutostartEnvFilePath({
  mode,
  explicitEnvFilePath,
  defaultMainEnvFilePath,
  systemUserHomeDir,
} = {}) {
  const explicit = String(explicitEnvFilePath ?? '').trim();
  if (explicit) return explicit;

  const m = String(mode ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
  const home = String(systemUserHomeDir ?? '').trim();
  if (m === 'system' && home) {
    return join(home, '.happier', 'stacks', 'main', 'env');
  }

  return String(defaultMainEnvFilePath ?? '').trim();
}

export function resolveAutostartWorkingDirectory({
  platform,
  mode,
  defaultHomeDir,
  systemUserHomeDir,
  baseDir,
  installedCliRoot,
} = {}) {
  const p = String(platform ?? '').trim() || process.platform;
  const m = String(mode ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';

  if (p === 'linux') {
    if (m === 'user') return '%h';
    const home = String(systemUserHomeDir ?? '').trim() || String(defaultHomeDir ?? '').trim();
    return home || '/root';
  }

  if (p === 'darwin') {
    return String(installedCliRoot ?? '').trim();
  }

  return String(baseDir ?? '').trim();
}

export function resolveAutostartLogPaths({
  mode,
  hasStorageDirOverride,
  systemUserHomeDir,
  stackName,
  defaultBaseDir,
  defaultStdoutPath,
  defaultStderrPath,
} = {}) {
  const m = String(mode ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
  const override = hasStorageDirOverride === true;
  const home = String(systemUserHomeDir ?? '').trim();
  const name = String(stackName ?? '').trim() || 'main';

  if (m === 'system' && !override && home) {
    const baseDir = join(home, '.happier', 'stacks', name);
    const logsDir = join(baseDir, 'logs');
    const stdoutFile = basename(String(defaultStdoutPath ?? '').trim() || 'happier-stack.out.log');
    const stderrFile = basename(String(defaultStderrPath ?? '').trim() || 'happier-stack.err.log');
    return {
      baseDir,
      stdoutPath: join(logsDir, stdoutFile),
      stderrPath: join(logsDir, stderrFile),
    };
  }

  return {
    baseDir: String(defaultBaseDir ?? '').trim(),
    stdoutPath: String(defaultStdoutPath ?? '').trim(),
    stderrPath: String(defaultStderrPath ?? '').trim(),
  };
}

