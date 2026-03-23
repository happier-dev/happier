import { execFileSync } from 'node:child_process';

export type OpenCodeServerProcessInfo = Readonly<{
  stat?: string;
  name: string;
  cmd: string;
}>;

function readOpenCodeServerProcessInfoBestEffort(pid: number): OpenCodeServerProcessInfo | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const output = execFileSync(
      'ps',
      ['-o', 'stat=,comm=,command=', '-p', String(Math.floor(pid))],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    ).trim();
    if (!output) return null;

    const line = output
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (!line) return null;

    const match = /^(\S+)\s+(\S+)\s+(.*)$/.exec(line) ?? /^(\S+)\s+(\S+)$/.exec(line);
    if (!match) return null;

    const stat = match[1]?.trim() ?? '';
    const name = match[2]?.trim() ?? '';
    const cmd = (match[3]?.trim() || name);
    if (!stat || (!name && !cmd)) return null;
    return { stat, name, cmd };
  } catch {
    return null;
  }
}

function isZombieProcessStat(stat: string): boolean {
  return stat.toUpperCase().includes('Z');
}

export function isOpenCodeServerPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(Math.floor(pid), 0);
  } catch {
    return false;
  }

  const info = readOpenCodeServerProcessInfoBestEffort(pid);
  if (!info?.stat) return true;
  return !isZombieProcessStat(info.stat);
}

export function getOpenCodeServerProcessInfoBestEffort(pid: number): OpenCodeServerProcessInfo | null {
  return readOpenCodeServerProcessInfoBestEffort(pid);
}
