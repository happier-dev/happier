import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import type { ProcessDescriptor } from 'ps-list';

/** BSD ps otherwise M-escapes Unicode when a service inherits the C locale. */
export function posixPsEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
}

/**
 * ps-list 8.1.1 cannot receive a child environment. Replace its Darwin scan so
 * concurrent runner launches never inherit a temporary daemon-wide locale.
 */
export async function listDarwinProcessSnapshot(): Promise<readonly ProcessDescriptor[]> {
  const scannerPids = new Set<number>();
  const env = posixPsEnvironment();
  const readProjection = (columns: string) => new Promise<string>((resolve, reject) => {
    const child = execFile('ps', ['-Aww', '-o', columns], {
      encoding: 'utf8',
      env,
      // Preserve ps-list 8.1.1's existing per-projection output budget.
      maxBuffer: 10_000_000,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    if (child.pid !== undefined) scannerPids.add(child.pid);
  });

  // Keep the variable-width executable and command in separate projections;
  // either can contain spaces, and BSD ps truncates non-final comm columns.
  const [metadata, commands] = await Promise.all([
    readProjection('pid=,ppid=,uid=,%cpu=,%mem=,comm='),
    readProjection('pid=,command='),
  ]);
  const commandByPid = new Map<number, string>();
  for (const line of commands.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) throw new Error('Unable to parse BSD ps command projection');
    commandByPid.set(Number(match[1]), match[2].trim());
  }

  const processes: ProcessDescriptor[] = [];
  for (const line of metadata.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.*)$/.exec(line);
    if (!match) throw new Error('Unable to parse BSD ps process projection');
    const pid = Number(match[1]);
    const cmd = commandByPid.get(pid);
    // Processes can exit between projections. As in ps-list, omit incomplete
    // rows and the scanner's own child processes.
    if (cmd === undefined || scannerPids.has(pid)) continue;
    processes.push({
      pid,
      ppid: Number(match[2]),
      uid: Number(match[3]),
      cpu: Number(match[4]),
      memory: Number(match[5]),
      name: basename(match[6].trim()),
      cmd,
    });
  }
  return processes;
}
