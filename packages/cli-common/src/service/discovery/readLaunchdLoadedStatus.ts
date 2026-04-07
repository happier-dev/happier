import type { LaunchdLoadedStatus } from './serviceDiscoveryTypes.js';

function parseIntOrNull(value: string | undefined): number | null {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function readLaunchdLoadedStatus(params: Readonly<{
  output: string;
}>): LaunchdLoadedStatus {
  const text = String(params.output ?? '');
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);

  let label: string | null = null;
  let pid: number | null = null;
  let lastExitStatus: number | null = null;

  for (const line of lines) {
    if (/^PID\s+Status\s+Label$/iu.test(line)) continue;

    const tableMatch = /^(-|\d+)\s+(-?\d+)\s+(.+)$/u.exec(line);
    if (tableMatch) {
      pid = tableMatch[1] === '-' ? null : parseIntOrNull(tableMatch[1]);
      lastExitStatus = parseIntOrNull(tableMatch[2]);
      label = String(tableMatch[3] ?? '').trim() || null;
      continue;
    }

    const pidMatch = /(?:^|\b)pid\s*=\s*(-?\d+)/iu.exec(line);
    if (pidMatch) pid = parseIntOrNull(pidMatch[1]);

    const lastExitMatch = /(?:^|\b)(?:last exit status|last exit code)\s*=\s*(-?\d+)/iu.exec(line);
    if (lastExitMatch) lastExitStatus = parseIntOrNull(lastExitMatch[1]);

    const labelMatch = /(?:^|\b)label\s*=\s*(.+)$/iu.exec(line);
    if (labelMatch) label = String(labelMatch[1] ?? '').trim() || null;
  }

  const state: LaunchdLoadedStatus['state'] = pid !== null || lastExitStatus !== null || label !== null
    ? (pid !== null ? 'loaded' : 'unloaded')
    : 'unknown';

  return {
    state,
    pid,
    lastExitStatus,
    label,
  };
}
