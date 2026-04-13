import { execFileSync } from 'node:child_process';

function isWindowsCmdWrapper(invocationCommand: string): boolean {
  return /(^|[\\/])cmd(?:\.exe)?$/i.test(invocationCommand.trim());
}

function extractPortFromBaseUrl(baseUrl: string): number | null {
  try {
    const port = Number.parseInt(new URL(baseUrl).port, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function parseListeningPidFromNetstat(output: string, port: number): number | null {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !/\bLISTENING\b/i.test(line)) continue;
    const columns = line.split(/\s+/);
    const localAddress = columns[1] ?? '';
    const localPortIndex = localAddress.lastIndexOf(':');
    if (localPortIndex < 0) continue;
    const localPort = Number.parseInt(localAddress.slice(localPortIndex + 1), 10);
    if (!Number.isFinite(localPort) || localPort !== port) continue;
    const pid = Number.parseInt(columns.at(-1) ?? '', 10);
    if (Number.isFinite(pid) && pid > 0) {
      return pid;
    }
  }
  return null;
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseWindowsProcessAncestry(output: string): number[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const ancestry = new Set<number>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const pid = parsePositiveInt((row as { ProcessId?: unknown }).ProcessId);
    if (pid) ancestry.add(pid);
    const parentPid = parsePositiveInt((row as { ParentProcessId?: unknown }).ParentProcessId);
    if (parentPid) ancestry.add(parentPid);
  }
  return Array.from(ancestry);
}

function resolveWindowsProcessAncestry(listenerPid: number): number[] {
  const script = [
    `$pid = ${listenerPid}`,
    '$rows = @()',
    '$seen = @{}',
    'while ($pid -gt 0 -and -not $seen.ContainsKey($pid)) {',
    '  $seen[$pid] = $true',
    '  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pid"',
    '  if ($null -eq $proc) { break }',
    '  $rows += [pscustomobject]@{ ProcessId = [int]$proc.ProcessId; ParentProcessId = [int]$proc.ParentProcessId }',
    '  $pid = [int]$proc.ParentProcessId',
    '}',
    '$rows | ConvertTo-Json -Compress',
  ].join('; ');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseWindowsProcessAncestry(output);
}

export async function resolveOpenCodeManagedServerTrackedPid(params: Readonly<{
  spawnPid: number;
  baseUrl: string;
  invocationCommand: string;
}>): Promise<number> {
  if (!isWindowsCmdWrapper(params.invocationCommand)) {
    return params.spawnPid;
  }
  const port = extractPortFromBaseUrl(params.baseUrl);
  if (!port) {
    return params.spawnPid;
  }

  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const listeningPid = parseListeningPidFromNetstat(output, port);
    if (!listeningPid || listeningPid === params.spawnPid) {
      return params.spawnPid;
    }
    try {
      return resolveWindowsProcessAncestry(listeningPid).includes(params.spawnPid)
        ? listeningPid
        : params.spawnPid;
    } catch {
      return params.spawnPid;
    }
  } catch {
    return params.spawnPid;
  }
}
