import { execFileSync } from 'node:child_process';

import { readProcessInfoByPid } from '@/daemon/doctor';

export type OpenCodeServerProcessInfo = Readonly<{
  stat?: string;
  name: string;
  cmd: string;
}>;

function readOpenCodeServerProcessStatBestEffort(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (platform === 'win32') return null;
  try {
    const output = execFileSync(
      'ps',
      ['-o', 'stat=', '-p', String(Math.floor(pid))],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    ).trim();
    if (!output) return null;
    return output.split('\n').map((entry) => entry.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function isZombieProcessStat(stat: string): boolean {
  return stat.toUpperCase().includes('Z');
}

export function isOpenCodeServerPidAlive(
  pid: number,
  options: Readonly<{ platform?: NodeJS.Platform }> = {},
): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(Math.floor(pid), 0);
  } catch {
    return false;
  }

  const stat = readOpenCodeServerProcessStatBestEffort(pid, options.platform);
  if (!stat) return true;
  return !isZombieProcessStat(stat);
}

export async function getOpenCodeServerProcessInfoBestEffort(pid: number): Promise<OpenCodeServerProcessInfo | null> {
  const processInfo = await readProcessInfoByPid(Math.floor(pid)).catch(() => null);
  if (!processInfo) return null;
  const name = processInfo.name?.trim() ?? '';
  const cmd = processInfo.cmd?.trim() || name;
  if (!name || !cmd) return null;
  return {
    ...(processInfo.stat ? { stat: processInfo.stat } : {}),
    name,
    cmd,
  };
}
