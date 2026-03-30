import { spawnSync } from 'node:child_process';

export function commandExistsOnPath(
  cmd: string,
  options: Readonly<{
    env?: NodeJS.ProcessEnv;
    path?: string | undefined;
  }> = {},
): boolean {
  const name = String(cmd ?? '').trim();
  if (!name) return false;

  const env = options.env ?? process.env;
  const pathEnv = options.path ?? env.PATH ?? process.env.PATH;
  const probeEnv = { ...process.env, ...env, PATH: pathEnv };

  if (process.platform === 'win32') {
    const res = spawnSync('where', [name], {
      stdio: 'ignore',
      env: probeEnv,
      windowsHide: true,
    });
    return (res.status ?? 1) === 0;
  }

  const res = spawnSync('sh', ['-lc', 'command -v "$1" >/dev/null 2>&1', 'sh', name], {
    stdio: 'ignore',
    env: probeEnv,
    windowsHide: true,
  });
  return (res.status ?? 1) === 0;
}
