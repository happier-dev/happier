import { spawnSync } from 'node:child_process';

export function yarnCommand(): string {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

export function which(bin: string): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(cmd, [bin], { encoding: 'utf8' });
  if (res.error) return null;
  if (res.status === null) return null;
  if (res.status !== 0) return null;
  const out = (res.stdout || '').trim().split(/\r?\n/)[0];
  return out && out.length > 0 ? out : null;
}
